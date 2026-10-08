import type Stripe from "stripe";
import type { PlanCatalog } from "../core/plan-catalog.ts";
import { deriveState, type SubscriptionState, toIso } from "../core/subscription-state.ts";
import type { BillingDeps, SubscriberWrite } from "../ports.ts";
import { loadCatalog } from "./catalog.ts";

/**
 * Stripe to database, through one writer. Every caller that learns something about a customer
 * (webhook, status check, plan change, cancel, resume, post-payment signup) calls
 * `syncCustomer`, which re-reads ALL of the customer's subscriptions and rewrites the row from
 * them. Nothing patches the row from a single event.
 *
 * Re-reading alone does not order two writers: two webhooks for one customer can read Stripe in
 * one order and save in the other. So every read takes a sync token first (`readFresh`), and the
 * store refuses a write whose read started before the one already saved.
 */

/**
 * The Stripe customer behind an account. The stored customer id comes first: Stripe's email
 * search is case-sensitive and never returns test-clock customers. A stored id from the other
 * Stripe mode reads as `resource_missing` and falls through to the email.
 */
export async function resolveCustomer(
  deps: BillingDeps,
  keys: { userId?: string | null; email?: string | null },
): Promise<Stripe.Customer | null> {
  const row = await deps.store.find(keys);
  if (row?.stripeCustomerId) {
    try {
      const customer = await deps.stripe.customers.retrieve(row.stripeCustomerId);
      if (!("deleted" in customer && customer.deleted)) return customer as Stripe.Customer;
    } catch (error) {
      if ((error as { code?: string }).code !== "resource_missing") throw error;
    }
  }

  const email = (keys.email ?? row?.email ?? "").trim();
  if (!email) return null;
  for (const candidate of new Set([email, email.toLowerCase()])) {
    const { data } = await deps.stripe.customers.list({ email: candidate, limit: 1 });
    if (data[0]) return data[0];
  }
  return null;
}

/** Every subscription of the customer, with what `deriveState` needs expanded. */
export async function readSubscriptions(stripe: Stripe, customerId: string): Promise<Stripe.Subscription[]> {
  const subscriptions: Stripe.Subscription[] = [];
  for await (
    const sub of stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
      expand: ["data.schedule", "data.pending_setup_intent"],
    })
  ) {
    subscriptions.push(sub);
  }
  return subscriptions;
}

export async function readState(deps: BillingDeps, customerId: string, catalog?: PlanCatalog): Promise<SubscriptionState> {
  const plans = catalog ?? await loadCatalog(deps.stripe, deps.config, deps.mode);
  return deriveState(deps.config, plans, customerId, await readSubscriptions(deps.stripe, customerId));
}

/** A Stripe read with the sync token taken just before it. Writes go through this, never a bare state. */
export interface FreshState {
  state: SubscriptionState;
  syncToken: number;
}

export async function readFresh(deps: BillingDeps, customerId: string, catalog?: PlanCatalog): Promise<FreshState> {
  const syncToken = await deps.store.nextSyncToken();
  return { state: await readState(deps, customerId, catalog), syncToken };
}

export function stateToWrite(
  state: SubscriptionState,
  ctx: { email: string; userId: string | null; syncToken: number },
): SubscriberWrite {
  return {
    email: ctx.email,
    userId: ctx.userId,
    stripeCustomerId: state.customerId,
    entitled: state.entitled,
    status: state.status,
    plan: state.plan,
    interval: state.interval,
    currentPeriodEnd: toIso(state.periodEnd),
    trialEnd: state.status === "trialing" ? toIso(state.trialEnd) : null,
    cancelAt: state.cancelScheduled ? toIso(state.cancelAt) : null,
    scheduledPlan: state.scheduledChange?.plan ?? null,
    scheduledInterval: state.scheduledChange?.interval ?? null,
    scheduledAt: toIso(state.scheduledChange?.effectiveAt),
    paidSubscriptionCount: state.paidLiveCount,
    syncToken: ctx.syncToken,
  };
}

export interface Synced {
  state: SubscriptionState;
  rowId: string;
  userId: string | null;
  email: string;
  previousPlan: string | null;
  /** False when a newer read had already saved the row; `state` is then older than the row. */
  saved: boolean;
}

/**
 * Writes a derived state. The only caller of `store.save`. When the plan changed and the row
 * belongs to a user, `onPlanChange` runs before the row is saved: if the save then fails, the
 * next sync still sees the old plan and repeats an idempotent side effect, never skips it.
 *
 * If the store refuses the write as older, the side effect may have run on the older answer.
 * It runs once more towards the plan the row keeps, so the account ends on the newest plan
 * whichever writer's side effect finished last.
 */
export async function applyState(
  deps: BillingDeps,
  fresh: FreshState,
  ctx: { email: string; userId?: string | null },
): Promise<Synced> {
  const { state, syncToken } = fresh;
  const existing = await deps.store.find({ userId: ctx.userId, customerId: state.customerId, email: ctx.email });
  const userId = existing?.userId ?? ctx.userId ?? null;
  const previousPlan = existing?.plan ?? null;
  const onPlanChange = deps.onPlanChange;
  const change = onPlanChange && userId && previousPlan && state.plan && previousPlan !== state.plan
    ? { userId, from: previousPlan, to: state.plan }
    : null;
  if (change) await onPlanChange!(change);

  const saved = await deps.store.save(stateToWrite(state, { email: ctx.email, userId, syncToken }));
  if (!saved.saved) {
    deps.log.info("Billing row already holds a newer Stripe read; older write skipped", { customerId: state.customerId });
    if (change && saved.previousPlan && saved.previousPlan !== change.to) {
      await onPlanChange!({ userId: change.userId, from: change.to, to: saved.previousPlan });
    }
  }
  return { state, rowId: saved.rowId, userId: saved.userId, email: ctx.email, previousPlan, saved: saved.saved };
}

/** Recomputes a customer's row from Stripe. Throws instead of writing a partial answer. */
export async function syncCustomer(
  deps: BillingDeps,
  customerId: string,
  ctx: { userId?: string | null; email?: string | null } = {},
): Promise<Synced | null> {
  const customer = await deps.stripe.customers.retrieve(customerId);
  if ("deleted" in customer && customer.deleted) return null;
  const email = (ctx.email ?? (customer as Stripe.Customer).email ?? "").trim();
  if (!email) {
    deps.log.error("Stripe customer has no email; row not written", { customerId });
    return null;
  }
  return applyState(deps, await readFresh(deps, customerId), { email, userId: ctx.userId });
}

/** What the frontend needs to render the billing page. */
export function describeState(state: SubscriptionState) {
  return {
    entitled: state.entitled,
    status: state.status,
    plan: state.plan,
    interval: state.interval,
    current_period_end: toIso(state.periodEnd),
    trial_end: state.status === "trialing" ? toIso(state.trialEnd) : null,
    cancel_at: state.cancelScheduled ? toIso(state.cancelAt) : null,
    scheduled_change: state.scheduledChange
      ? {
        plan: state.scheduledChange.plan,
        interval: state.scheduledChange.interval,
        effective_at: toIso(state.scheduledChange.effectiveAt),
      }
      : null,
    paid_subscription_count: state.paidLiveCount,
  };
}
