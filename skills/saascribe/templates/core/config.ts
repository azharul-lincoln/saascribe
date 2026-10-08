/**
 * Billing configuration: which plans exist, how Stripe tags them, and the policy choices.
 *
 * Copy this file into the app and fill in `PLANS`; everything else in `core/` reads it.
 * Nothing here talks to Stripe or a database.
 */

export type Interval = "month" | "year";

export interface PlanDefinition {
  /** Stable id stored in the app's database and written to the Stripe product metadata. */
  id: string;
  /** Higher is a bigger plan. Decides upgrade versus downgrade. Must be unique. */
  rank: number;
}

export interface Policy {
  /**
   * `charge_now`: the upgrade takes effect now and the prorated difference is charged now
   * (`proration_behavior: always_invoice` + `payment_behavior: pending_if_incomplete`), so a
   * declined card leaves the plan unchanged.
   * `credit_next_invoice`: takes effect now, the difference lands on the next renewal
   * (`create_prorations`). Nothing can be declined today, but the customer gets the bigger plan
   * before paying for it.
   */
  upgrade: "charge_now" | "credit_next_invoice";
  /**
   * `period_end`: the current plan runs until the period ends, then a subscription schedule
   * moves it down. No refund or credit. The customer can undo it until then.
   * `now_with_credit`: switches now and credits the unused time on the next invoice.
   */
  downgrade: "period_end" | "now_with_credit";
  /**
   * `free_keep_trial`: during a trial any switch applies now, costs nothing, trial end unchanged.
   * `end_trial_and_charge`: switching ends the trial and charges the new plan now.
   */
  trialSwitch: "free_keep_trial" | "end_trial_and_charge";
  /**
   * `keep_access`: a failed renewal keeps the plan while Stripe retries. Stripe's "if all retries
   * fail" setting must then cancel the subscription or mark it unpaid, never leave it past due.
   * `lock`: access stops at the first failed renewal.
   */
  pastDue: "keep_access" | "lock";
  /**
   * `period_end_except_trial_and_past_due`: paid time runs out; a trial and an overdue plan end
   * now (the open invoice is voided, so nothing is charged after a cancel).
   * `always_period_end`: everything runs to the end of the period, trials included.
   * `always_now`: everything ends now, no refund.
   */
  cancel: "period_end_except_trial_and_past_due" | "always_period_end" | "always_now";
  /** Trial length for new subscriptions; null for no trial. */
  trialDays: number | null;
  /** What happens when a trial ends without a card. */
  trialMissingPaymentMethod: "cancel" | "pause" | "create_invoice";
  /** How long an upgrade preview's proration date may be reused by `apply`. */
  previewTtlSeconds: number;
  /** How long a completed checkout may still open the post-payment page. */
  checkoutProofMaxAgeSeconds: number;
  /** Turn on Stripe Tax on checkout, previews and plan changes. Needs a customer address. */
  automaticTax: boolean;
}

export interface BillingConfig {
  plans: readonly PlanDefinition[];
  /** Product metadata key that names the plan, e.g. `plan` -> `pro`. */
  productMetadataKey: string;
  /** Lowercase ISO currency of the prices the app sells. */
  currency: string;
  /** Billing intervals the app sells. `["month"]` or `["month", "year"]`. */
  intervals: readonly Interval[];
  policy: Policy;
}

/** The defaults are the policy the reference app runs in production. */
export const DEFAULT_POLICY: Policy = {
  upgrade: "charge_now",
  downgrade: "period_end",
  trialSwitch: "free_keep_trial",
  pastDue: "keep_access",
  cancel: "period_end_except_trial_and_past_due",
  trialDays: 7,
  trialMissingPaymentMethod: "cancel",
  previewTtlSeconds: 15 * 60,
  checkoutProofMaxAgeSeconds: 30 * 24 * 60 * 60,
  automaticTax: false,
};

/** Throws on a config that would make plan comparisons ambiguous. Call once at startup. */
export function validateConfig(config: BillingConfig): BillingConfig {
  const ids = new Set<string>();
  const ranks = new Set<number>();
  for (const plan of config.plans) {
    if (!/^[a-z0-9_-]+$/.test(plan.id)) throw new Error(`Plan id "${plan.id}" must be lowercase letters, digits, _ or -`);
    if (ids.has(plan.id)) throw new Error(`Duplicate plan id "${plan.id}"`);
    if (ranks.has(plan.rank)) throw new Error(`Duplicate plan rank ${plan.rank}`);
    ids.add(plan.id);
    ranks.add(plan.rank);
  }
  if (config.plans.length === 0) throw new Error("At least one plan is required");
  if (config.intervals.length === 0) throw new Error("At least one interval is required");
  if (config.currency !== config.currency.toLowerCase()) throw new Error("currency must be lowercase, e.g. usd");
  return config;
}

export function isPlanId(config: BillingConfig, value: unknown): value is string {
  return typeof value === "string" && config.plans.some((plan) => plan.id === value);
}

export function normalizePlanId(config: BillingConfig, value: unknown): string | null {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  return isPlanId(config, id) ? id : null;
}

/** 0 for an unknown or missing plan, so it ranks below every real plan. */
export function planRank(config: BillingConfig, planId: string | null | undefined): number {
  return config.plans.find((plan) => plan.id === planId)?.rank ?? 0;
}

export function isInterval(config: BillingConfig, value: unknown): value is Interval {
  return typeof value === "string" && (config.intervals as readonly string[]).includes(value);
}

/** Year is the bigger commitment, so month to year counts as moving up. */
export const intervalRank = (interval: Interval | null | undefined): number =>
  interval === "year" ? 2 : interval === "month" ? 1 : 0;
