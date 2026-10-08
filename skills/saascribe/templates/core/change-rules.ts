import type Stripe from "stripe";
import { type BillingConfig, type Interval, intervalRank, isInterval, isPlanId, planRank } from "./config.ts";
import { isLive, type SubscriptionPlan, type SubscriptionState } from "./subscription-state.ts";

/**
 * What a requested plan change means for this account, and how it maps to Stripe parameters
 * under the configured policy. Pure; `services/change-plan.ts` does the calls.
 */

export type ChangeKind = "trial_switch" | "upgrade" | "downgrade" | "keep_current";

export type ChangeRefusal =
  | "unknown_plan"
  | "no_subscription"
  | "multiple_subscriptions"
  | "past_due"
  | "not_active"
  | "cancel_scheduled"
  | "unsupported_subscription"
  | "same_plan"
  | "already_scheduled";

export type ChangeDecision =
  | { kind: ChangeKind; from: SubscriptionPlan; to: SubscriptionPlan }
  | { refusal: ChangeRefusal };

/**
 * Moving up means a plan at least as big on an interval at least as long, and not the same
 * thing: Pro monthly to Pro yearly or to Team monthly. Anything else (a smaller plan, or yearly
 * to monthly) moves down, because the customer has already paid for the longer or bigger term.
 */
export function isMoveUp(config: BillingConfig, from: SubscriptionPlan, to: SubscriptionPlan): boolean {
  return planRank(config, to.plan) >= planRank(config, from.plan) && intervalRank(to.interval) >= intervalRank(from.interval);
}

export function classifyChange(
  config: BillingConfig,
  state: SubscriptionState,
  target: { plan?: unknown; interval?: unknown },
): ChangeDecision {
  if (!isPlanId(config, target.plan)) return { refusal: "unknown_plan" };
  const primary = state.primary;
  if (!primary || !isLive(primary)) return { refusal: "no_subscription" };
  if (state.paidLiveCount > 1) return { refusal: "multiple_subscriptions" };
  if (primary.status === "past_due" || primary.status === "unpaid") return { refusal: "past_due" };
  if (!state.entitled) return { refusal: "not_active" };
  if (state.cancelScheduled) return { refusal: "cancel_scheduled" };
  if ((primary.items?.data?.length ?? 0) !== 1 || !state.plan || !state.interval) {
    return { refusal: "unsupported_subscription" };
  }

  const from: SubscriptionPlan = { plan: state.plan, interval: state.interval };
  const interval: Interval | null = target.interval === undefined ? from.interval : isInterval(config, target.interval) ? target.interval : null;
  if (!interval) return { refusal: "unknown_plan" };
  const to: SubscriptionPlan = { plan: target.plan, interval };

  if (to.plan === from.plan && to.interval === from.interval) {
    return state.scheduledChange ? { kind: "keep_current", from, to } : { refusal: "same_plan" };
  }
  if (primary.status === "trialing") return { kind: "trial_switch", from, to };
  const scheduled = state.scheduledChange;
  if (scheduled && scheduled.plan === to.plan && scheduled.interval === to.interval) return { refusal: "already_scheduled" };
  return { kind: isMoveUp(config, from, to) ? "upgrade" : "downgrade", from, to };
}

/** How a change kind is carried out under the policy. */
export type ChangePlanStep =
  | {
    when: "now";
    proration_behavior: Stripe.SubscriptionUpdateParams.ProrationBehavior;
    /** `pending_if_incomplete` leaves the plan unchanged when the charge fails. */
    payment_behavior?: Stripe.SubscriptionUpdateParams.PaymentBehavior;
    /** `now` ends a trial as part of the switch. */
    trial_end?: "now";
    /**
     * Restart the billing period now. Needed when the interval changes: under flexible billing
     * mode (the default for new subscriptions since 2025-09-30.clover) Stripe never resets the
     * anchor on its own, so a monthly subscription moved to a yearly price would keep its monthly
     * anchor. Send as `billing_cycle_anchor: { type: "now" }` (an object since 2026-09-30.endive).
     */
    resetBillingCycleAnchor?: true;
    /** True when the update creates an invoice that must be paid now. */
    chargesNow: boolean;
  }
  | { when: "period_end" }
  | { when: "release_schedule" };

export function changeStep(config: BillingConfig, kind: ChangeKind, intervalChanges = false): ChangePlanStep {
  const step = baseStep(config, kind);
  // A trial keeps its own end as the anchor; the first paid period starts there either way.
  if (step.when === "now" && intervalChanges && kind !== "trial_switch") return { ...step, resetBillingCycleAnchor: true };
  return step;
}

function baseStep(config: BillingConfig, kind: ChangeKind): ChangePlanStep {
  const policy = config.policy;
  switch (kind) {
    case "keep_current":
      return { when: "release_schedule" };
    case "trial_switch":
      return policy.trialSwitch === "free_keep_trial"
        ? { when: "now", proration_behavior: "none", chargesNow: false }
        : { when: "now", proration_behavior: "always_invoice", payment_behavior: "pending_if_incomplete", trial_end: "now", chargesNow: true };
    case "upgrade":
      return policy.upgrade === "charge_now"
        ? { when: "now", proration_behavior: "always_invoice", payment_behavior: "pending_if_incomplete", chargesNow: true }
        : { when: "now", proration_behavior: "create_prorations", chargesNow: false };
    case "downgrade":
      return policy.downgrade === "period_end"
        ? { when: "period_end" }
        : { when: "now", proration_behavior: "create_prorations", chargesNow: false };
  }
}

/**
 * Whether an upgrade preview's proration date can still be applied: not in the future, not older
 * than the TTL, and inside the current period (a renewal in between would bill the wrong span).
 */
export function isProrationDateUsable(
  config: BillingConfig,
  prorationDate: unknown,
  periodStart: number | null,
  now: number,
): prorationDate is number {
  return (
    typeof prorationDate === "number" &&
    Number.isInteger(prorationDate) &&
    prorationDate <= now &&
    now - prorationDate <= config.policy.previewTtlSeconds &&
    (!periodStart || prorationDate >= periodStart)
  );
}

/** How cancelling a subscription in this status ends it under the policy. */
export function cancelMode(config: BillingConfig, status: Stripe.Subscription.Status): "now" | "period_end" {
  switch (config.policy.cancel) {
    case "always_now":
      return "now";
    case "always_period_end":
      return status === "past_due" || status === "unpaid" ? "now" : "period_end";
    case "period_end_except_trial_and_past_due":
      return status === "trialing" || status === "past_due" || status === "unpaid" ? "now" : "period_end";
  }
}
