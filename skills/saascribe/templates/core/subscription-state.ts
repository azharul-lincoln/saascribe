import type Stripe from "stripe";
import { type BillingConfig, type Interval, intervalRank, planRank } from "./config.ts";
import { type PlanCatalog, planOfPrice } from "./plan-catalog.ts";

/**
 * A customer's billing state, derived from ALL of their Stripe subscriptions at once.
 *
 * Every writer of the app's subscriptions row (webhook, page-load check, plan change, cancel,
 * resume, post-payment signup) recomputes it here from what Stripe says now, instead of patching
 * the row from whichever event arrived last. Event order, replays, and a second subscription on
 * the same customer then stop mattering.
 *
 * Pure functions only; the I/O lives in `services/sync.ts`.
 */

/** Statuses that never come back. */
const ENDED_STATUSES: ReadonlySet<string> = new Set(["canceled", "incomplete_expired"]);
/** Statuses where money has been, or is being, collected. */
const PAID_STATUSES: ReadonlySet<string> = new Set(["active", "past_due", "unpaid"]);

/**
 * Statuses that grant the product. `past_due` is in only with `pastDue: keep_access`; Stripe's
 * "if all retries fail" setting then moves the subscription to `canceled` or `unpaid`, which ends it.
 */
export function entitledStatuses(config: BillingConfig): ReadonlySet<string> {
  return new Set(config.policy.pastDue === "keep_access" ? ["active", "trialing", "past_due"] : ["active", "trialing"]);
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);
export const toIso = (seconds: number | null | undefined) => (seconds ? new Date(seconds * 1000).toISOString() : null);

export function isLive(sub: Stripe.Subscription): boolean {
  return !ENDED_STATUSES.has(sub.status);
}

/**
 * A checkout that created a subscription but never got a card: `incomplete`, or a trial whose
 * setup intent has not succeeded and that has no payment method of its own. Only positive
 * evidence counts, because checkout cancels these. Needs `pending_setup_intent` expanded.
 */
export function isAbandonedCheckout(sub: Stripe.Subscription): boolean {
  if (sub.status === "incomplete") return true;
  if (sub.status !== "trialing") return false;
  if (sub.default_payment_method || sub.default_source) return false;
  const setupIntent = sub.pending_setup_intent;
  return !!setupIntent && typeof setupIntent === "object" && setupIntent.status !== "succeeded";
}

/** A live subscription someone is paying for, or will pay for when the trial ends. */
export function isPaidFor(sub: Stripe.Subscription): boolean {
  if (sub.status === "trialing") return !isAbandonedCheckout(sub);
  return PAID_STATUSES.has(sub.status);
}

/**
 * Positive evidence that a card stands behind the subscription: it has been paid, or it is a
 * trial with a payment method of its own (checkout saves the card on the subscription with
 * `save_default_payment_method: on_subscription`). Stricter than `isPaidFor`, which gives an
 * unexpanded setup intent the benefit of the doubt. Drives the one "your plan is active" email.
 */
export function hasConfirmedPayment(
  sub: Pick<Stripe.Subscription, "status" | "default_payment_method" | "default_source">,
): boolean {
  if (sub.status === "trialing") return !!(sub.default_payment_method || sub.default_source);
  return PAID_STATUSES.has(sub.status);
}

export interface SubscriptionPlan {
  plan: string;
  interval: Interval;
}

/** Plan and interval from the subscription's single item price. */
export function planOfSubscription(
  config: BillingConfig,
  catalog: PlanCatalog,
  sub: Stripe.Subscription,
): SubscriptionPlan | null {
  return planOfPrice(config, catalog, sub.items?.data?.[0]?.price);
}

/**
 * Billing period of the subscription. Since API 2025-03-31.basil the dates live on each item,
 * not on the subscription; with one item per subscription the first item is the period.
 */
export function periodOf(sub: Stripe.Subscription): { start: number | null; end: number | null } {
  const item = sub.items?.data?.[0];
  return { start: item?.current_period_start ?? null, end: item?.current_period_end ?? null };
}

export interface ScheduledChange extends SubscriptionPlan {
  /** Unix seconds when the next phase starts. */
  effectiveAt: number;
  scheduleId: string;
}

/**
 * The plan a subscription schedule will move to next. A schedule stays attached for the whole
 * of its last phase after a downgrade has taken effect, so only a phase that has not started yet
 * counts as a pending change. Needs `schedule` expanded.
 */
export function scheduledChangeOf(
  config: BillingConfig,
  catalog: PlanCatalog,
  sub: Stripe.Subscription,
  now = nowSeconds(),
): ScheduledChange | null {
  const schedule = sub.schedule;
  if (!schedule || typeof schedule !== "object") return null;
  if (schedule.status !== "active" && schedule.status !== "not_started") return null;

  const next = [...(schedule.phases ?? [])]
    .filter((phase) => phase.start_date > now)
    .sort((a, b) => a.start_date - b.start_date)[0];
  if (!next) return null;

  const target = planOfPrice(config, catalog, next.items?.[0]?.price);
  const current = planOfSubscription(config, catalog, sub);
  if (!target) return null;
  if (current && target.plan === current.plan && target.interval === current.interval) return null;
  return { ...target, effectiveAt: next.start_date, scheduleId: schedule.id };
}

export interface SubscriptionState {
  customerId: string | null;
  /** The subscription the account is billed on; see `deriveState` for how it is picked. */
  primary: Stripe.Subscription | null;
  status: Stripe.Subscription.Status | null;
  /** Grants the product right now. */
  entitled: boolean;
  plan: string | null;
  interval: Interval | null;
  periodStart: number | null;
  periodEnd: number | null;
  trialEnd: number | null;
  /** The subscription is set to end (`cancel_at_period_end` or a `cancel_at` date). */
  cancelScheduled: boolean;
  /** When it ends, if it is set to. */
  cancelAt: number | null;
  scheduledChange: ScheduledChange | null;
  hasPendingUpdate: boolean;
  subscriptionCount: number;
  liveCount: number;
  /** More than one is a duplicate that blocks plan changes until support resolves it. */
  paidLiveCount: number;
}

/**
 * Picks the primary subscription: paid-for live first, then entitled, then live, then the bigger
 * plan among live ones, then the newest. With no live subscription the newest ended one still
 * supplies the last known plan.
 */
export function deriveState(
  config: BillingConfig,
  catalog: PlanCatalog,
  customerId: string | null,
  subscriptions: Stripe.Subscription[],
  now = nowSeconds(),
): SubscriptionState {
  const entitledSet = entitledStatuses(config);
  const key = (sub: Stripe.Subscription) => {
    const live = isLive(sub);
    const plan = live ? planOfSubscription(config, catalog, sub) : null;
    return [
      Number(live && isPaidFor(sub)),
      Number(entitledSet.has(sub.status)),
      Number(live),
      planRank(config, plan?.plan),
      intervalRank(plan?.interval),
      sub.created,
    ];
  };
  const ranked = [...subscriptions].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (kb[i] !== ka[i]) return kb[i] - ka[i];
    return 0;
  });

  const primary = ranked[0] ?? null;
  const live = subscriptions.filter(isLive);
  const plan = primary ? planOfSubscription(config, catalog, primary) : null;
  const period = primary ? periodOf(primary) : { start: null, end: null };

  return {
    customerId,
    primary,
    status: primary?.status ?? null,
    entitled: !!primary && entitledSet.has(primary.status),
    plan: plan?.plan ?? null,
    interval: plan?.interval ?? null,
    periodStart: period.start,
    periodEnd: period.end,
    trialEnd: primary?.trial_end ?? null,
    cancelScheduled: !!primary && (primary.cancel_at_period_end === true || !!primary.cancel_at),
    cancelAt: primary?.cancel_at ?? (primary?.cancel_at_period_end ? period.end : null),
    scheduledChange: primary && isLive(primary) ? scheduledChangeOf(config, catalog, primary, now) : null,
    hasPendingUpdate: !!primary?.pending_update,
    subscriptionCount: subscriptions.length,
    liveCount: live.length,
    paidLiveCount: live.filter(isPaidFor).length,
  };
}
