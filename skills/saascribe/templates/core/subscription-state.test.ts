// Run with Node 22.18+ (`node --test core/*.test.ts`) or Deno 2 (`deno test core/`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { type BillingConfig, DEFAULT_POLICY, type Policy, validateConfig } from "./config.ts";
import { buildPlanCatalog, getSellingPrice, planOfPrice } from "./plan-catalog.ts";
import {
  deriveState,
  hasConfirmedPayment,
  isAbandonedCheckout,
  isPaidFor,
  scheduledChangeOf,
} from "./subscription-state.ts";
import { cancelMode, changeStep, classifyChange, isProrationDateUsable } from "./change-rules.ts";

// Minimal Stripe-shaped fixtures. Only the fields the module reads are filled in.
// deno-lint-ignore no-explicit-any
type Any = any;

const NOW = 1_790_000_000;
const DAY = 86_400;

const configWith = (policy: Partial<Policy> = {}): BillingConfig =>
  validateConfig({
    plans: [
      { id: "basic", rank: 1 },
      { id: "pro", rank: 2 },
      { id: "team", rank: 3 },
    ],
    productMetadataKey: "plan",
    currency: "usd",
    intervals: ["month", "year"],
    policy: { ...DEFAULT_POLICY, ...policy },
  });
const config = configWith();

function product(id: string, plan: string | null, created: number, active = true): Any {
  return { id, object: "product", active, created, metadata: plan ? { plan } : {} };
}

function price(
  id: string,
  prod: Any,
  created: number,
  opts: { active?: boolean; interval?: string; amount?: number; currency?: string; count?: number } = {},
): Any {
  return {
    id,
    object: "price",
    active: opts.active ?? true,
    created,
    currency: opts.currency ?? "usd",
    unit_amount: opts.amount ?? 0,
    recurring: { interval: opts.interval ?? "month", interval_count: opts.count ?? 1 },
    product: prod,
  };
}

const basicProduct = product("prod_basic", "basic", 100);
const proProduct = product("prod_pro", "pro", 100);
const teamProduct = product("prod_team", "team", 100);

const PRICES = {
  basic: price("price_basic", basicProduct, 100, { amount: 1900 }),
  proOld: price("price_pro_old", proProduct, 100, { active: false, amount: 3900 }),
  pro: price("price_pro", proProduct, 200, { amount: 4900 }),
  proYear: price("price_pro_year", proProduct, 300, { interval: "year", amount: 49000 }),
  proEur: price("price_pro_eur", proProduct, 400, { currency: "eur", amount: 4500 }),
  proQuarter: price("price_pro_quarter", proProduct, 400, { count: 3 }),
  team: price("price_team", teamProduct, 100, { amount: 9900 }),
  teamYear: price("price_team_year", teamProduct, 100, { interval: "year", amount: 99000 }),
  other: price("price_other", product("prod_other", null, 100), 100),
};

const catalog = buildPlanCatalog(config, Object.values(PRICES));

function sub(id: string, p: Any, status: string, created: number, extra: Record<string, unknown> = {}): Any {
  return {
    id,
    object: "subscription",
    status,
    created,
    start_date: created,
    trial_end: null,
    cancel_at_period_end: false,
    cancel_at: null,
    default_payment_method: null,
    default_source: null,
    pending_setup_intent: null,
    pending_update: null,
    schedule: null,
    metadata: {},
    items: {
      data: [{
        id: `si_${id}`,
        price: { id: p.id, product: p.product.id, recurring: p.recurring },
        current_period_start: created,
        current_period_end: created + 30 * DAY,
      }],
    },
    ...extra,
  };
}

function schedule(id: string, phases: Array<{ price: string; start: number; end: number }>, status = "active"): Any {
  return {
    id,
    status,
    phases: phases.map((ph) => ({ start_date: ph.start, end_date: ph.end, items: [{ price: ph.price, quantity: 1 }], metadata: {} })),
  };
}

const stateOf = (...subs: Any[]) => deriveState(config, catalog, "cus_1", subs, NOW);

// --- config -----------------------------------------------------------------------------

test("validateConfig: refuses duplicate ids or ranks and uppercase currency", () => {
  const base = { productMetadataKey: "plan", currency: "usd", intervals: ["month"] as const, policy: DEFAULT_POLICY };
  assert.throws(() => validateConfig({ ...base, plans: [{ id: "a", rank: 1 }, { id: "a", rank: 2 }] }));
  assert.throws(() => validateConfig({ ...base, plans: [{ id: "a", rank: 1 }, { id: "b", rank: 1 }] }));
  assert.throws(() => validateConfig({ ...base, currency: "USD", plans: [{ id: "a", rank: 1 }] }));
});

// --- catalog ---------------------------------------------------------------------------

test("catalog: sells the newest active price per plan and interval, maps archived prices too", () => {
  assert.equal(getSellingPrice(catalog, "pro", "month").id, "price_pro");
  assert.equal(getSellingPrice(catalog, "pro", "year").id, "price_pro_year");
  assert.deepEqual(catalog.sellablePriceIds.get("pro:month"), ["price_pro"]);
  assert.deepEqual(planOfPrice(config, catalog, "price_pro_old"), { plan: "pro", interval: "month" });
  assert.equal(planOfPrice(config, catalog, "price_other"), null);
});

test("catalog: other currencies and multi-month intervals are not sold", () => {
  assert.deepEqual(catalog.sellablePriceIds.get("pro:month"), ["price_pro"]);
  assert.equal(planOfPrice(config, catalog, "price_pro_quarter"), null);
});

test("catalog: a monthly-only app does not sell or map yearly prices", () => {
  const monthly = validateConfig({ ...config, intervals: ["month"] });
  const c = buildPlanCatalog(monthly, Object.values(PRICES));
  assert.equal(c.sellingPrice.get("pro:year"), undefined);
  assert.throws(() => getSellingPrice(c, "pro", "year"), /No active yearly price/);
});

test("catalog: an unknown price resolves through its product", () => {
  const fresh = { id: "price_new", product: "prod_team", recurring: { interval: "month", interval_count: 1 } } as Any;
  assert.deepEqual(planOfPrice(config, catalog, fresh), { plan: "team", interval: "month" });
  assert.equal(planOfPrice(config, catalog, "price_unknown"), null);
});

// --- paid-for and abandoned -------------------------------------------------------------

test("isAbandonedCheckout: only with positive evidence", () => {
  const unconfirmed = { id: "seti_1", status: "requires_payment_method" };
  assert.equal(isAbandonedCheckout(sub("a", PRICES.pro, "incomplete", NOW)), true);
  assert.equal(isAbandonedCheckout(sub("b", PRICES.pro, "trialing", NOW, { pending_setup_intent: unconfirmed })), true);
  // A card on the subscription, a succeeded setup intent, or no setup intent at all: not abandoned.
  assert.equal(
    isAbandonedCheckout(sub("c", PRICES.pro, "trialing", NOW, { pending_setup_intent: unconfirmed, default_payment_method: "pm_1" })),
    false,
  );
  assert.equal(
    isAbandonedCheckout(sub("d", PRICES.pro, "trialing", NOW, { pending_setup_intent: { id: "seti_2", status: "succeeded" } })),
    false,
  );
  assert.equal(isAbandonedCheckout(sub("e", PRICES.pro, "trialing", NOW)), false);
  // An unexpanded setup intent is not evidence.
  assert.equal(isAbandonedCheckout(sub("f", PRICES.pro, "trialing", NOW, { pending_setup_intent: "seti_3" })), false);
});

test("hasConfirmedPayment: needs a card on a trial, an unexpanded setup intent is not enough", () => {
  assert.equal(hasConfirmedPayment(sub("a", PRICES.pro, "active", NOW)), true);
  assert.equal(hasConfirmedPayment(sub("b", PRICES.pro, "trialing", NOW, { default_payment_method: "pm_1" })), true);
  assert.equal(hasConfirmedPayment(sub("c", PRICES.pro, "trialing", NOW, { pending_setup_intent: "seti_1" })), false);
  assert.equal(hasConfirmedPayment(sub("d", PRICES.pro, "incomplete", NOW)), false);
  assert.equal(hasConfirmedPayment(sub("e", PRICES.pro, "canceled", NOW, { default_payment_method: "pm_1" })), false);
});

test("hasConfirmedPayment: the card step is the transition, a trial ending is not", () => {
  // The webhook compares the payload with the payload overlaid by previous_attributes.
  const cardSaved = sub("t", PRICES.pro, "trialing", NOW, { default_payment_method: "pm_1" });
  const beforeCard = { ...cardSaved, default_payment_method: null };
  assert.equal(hasConfirmedPayment(cardSaved) && !hasConfirmedPayment(beforeCard), true);

  const firstPayment = sub("p", PRICES.pro, "active", NOW);
  const beforePayment = { ...firstPayment, status: "incomplete" };
  assert.equal(hasConfirmedPayment(firstPayment) && !hasConfirmedPayment(beforePayment), true);

  const trialEnded = sub("e", PRICES.pro, "active", NOW, { default_payment_method: "pm_1" });
  const beforeEnd = { ...trialEnded, status: "trialing" };
  assert.equal(hasConfirmedPayment(trialEnded) && !hasConfirmedPayment(beforeEnd), false);
});

test("isPaidFor: active, past_due, unpaid and confirmed trials", () => {
  assert.equal(isPaidFor(sub("a", PRICES.pro, "active", NOW)), true);
  assert.equal(isPaidFor(sub("b", PRICES.pro, "past_due", NOW)), true);
  assert.equal(isPaidFor(sub("c", PRICES.pro, "unpaid", NOW)), true);
  assert.equal(isPaidFor(sub("d", PRICES.pro, "trialing", NOW, { default_payment_method: "pm_1" })), true);
  assert.equal(isPaidFor(sub("e", PRICES.pro, "canceled", NOW)), false);
  assert.equal(isPaidFor(sub("f", PRICES.pro, "incomplete", NOW)), false);
});

// --- deriveState ------------------------------------------------------------------------

test("deriveState: two paid subscriptions report the bigger plan and count 2", () => {
  const state = stateOf(sub("pro", PRICES.pro, "active", NOW - 40 * DAY), sub("team", PRICES.team, "active", NOW - 10 * DAY));
  assert.equal(state.plan, "team");
  assert.equal(state.entitled, true);
  assert.equal(state.paidLiveCount, 2);
  assert.equal(state.primary?.id, "team");
});

test("deriveState: plan comes from the price, not stale metadata", () => {
  assert.equal(stateOf(sub("s", PRICES.team, "active", NOW, { metadata: { plan: "basic" } })).plan, "team");
});

test("deriveState: period dates come from the subscription item", () => {
  const state = stateOf(sub("s", PRICES.pro, "active", NOW - DAY));
  assert.equal(state.periodStart, NOW - DAY);
  assert.equal(state.periodEnd, NOW - DAY + 30 * DAY);
  assert.equal(state.interval, "month");
});

test("deriveState: a cancelled subscription never hides a live one", () => {
  const state = stateOf(sub("gone", PRICES.team, "canceled", NOW - DAY), sub("live", PRICES.basic, "active", NOW - 20 * DAY));
  assert.equal(state.primary?.id, "live");
  assert.equal(state.entitled, true);
  assert.equal(state.plan, "basic");
});

test("deriveState: an abandoned checkout trial loses to the paid subscription", () => {
  const abandoned = sub("abandoned", PRICES.team, "trialing", NOW, {
    pending_setup_intent: { id: "seti", status: "requires_payment_method" },
  });
  const state = stateOf(abandoned, sub("paid", PRICES.pro, "active", NOW - 20 * DAY));
  assert.equal(state.primary?.id, "paid");
  assert.equal(state.paidLiveCount, 1);
  assert.equal(state.liveCount, 2);
});

test("deriveState: only ended subscriptions keep the newest plan and report not entitled", () => {
  const state = stateOf(sub("older", PRICES.team, "canceled", NOW - 90 * DAY), sub("newer", PRICES.basic, "canceled", NOW - 30 * DAY));
  assert.equal(state.entitled, false);
  assert.equal(state.plan, "basic");
});

test("deriveState: past_due keeps the plan while Stripe retries, unless the policy locks", () => {
  const pd = sub("pd", PRICES.pro, "past_due", NOW);
  assert.equal(stateOf(pd).entitled, true);
  const locking = configWith({ pastDue: "lock" });
  assert.equal(deriveState(locking, catalog, "cus_1", [pd], NOW).entitled, false);
});

test("deriveState: unpaid (retries exhausted) ends the plan", () => {
  const state = stateOf(sub("up", PRICES.pro, "unpaid", NOW));
  assert.equal(state.status, "unpaid");
  assert.equal(state.entitled, false);
  assert.equal(state.plan, "pro");
});

test("deriveState: cancel_at_period_end and cancel_at both count as set to end", () => {
  const atEnd = stateOf(sub("a", PRICES.pro, "active", NOW, { cancel_at_period_end: true }));
  assert.equal(atEnd.cancelScheduled, true);
  assert.equal(atEnd.cancelAt, NOW + 30 * DAY);
  const atDate = stateOf(sub("b", PRICES.pro, "active", NOW, { cancel_at: NOW + 5 * DAY }));
  assert.equal(atDate.cancelScheduled, true);
  assert.equal(atDate.cancelAt, NOW + 5 * DAY);
});

// --- scheduled change -------------------------------------------------------------------

test("scheduledChangeOf: a future phase on another plan is a pending downgrade", () => {
  const end = NOW + 10 * DAY;
  const s = sub("s", PRICES.team, "active", NOW - 20 * DAY, {
    schedule: schedule("sub_sched_1", [
      { price: "price_team", start: NOW - 20 * DAY, end },
      { price: "price_pro", start: end, end: end + 30 * DAY },
    ]),
  });
  assert.deepEqual(scheduledChangeOf(config, catalog, s, NOW), {
    plan: "pro",
    interval: "month",
    effectiveAt: end,
    scheduleId: "sub_sched_1",
  });
  assert.equal(stateOf(s).scheduledChange?.plan, "pro");
});

test("scheduledChangeOf: a move from yearly to monthly on the same plan is a pending change", () => {
  const end = NOW + 100 * DAY;
  const s = sub("s", PRICES.proYear, "active", NOW - 265 * DAY, {
    schedule: schedule("sched", [
      { price: "price_pro_year", start: NOW - 265 * DAY, end },
      { price: "price_pro", start: end, end: end + 30 * DAY },
    ]),
  });
  assert.deepEqual(scheduledChangeOf(config, catalog, s, NOW)?.interval, "month");
});

test("scheduledChangeOf: after the downgrade took effect the schedule is no longer a pending change", () => {
  const start = NOW - 5 * DAY;
  const s = sub("s", PRICES.pro, "active", start, {
    schedule: schedule("sub_sched_1", [
      { price: "price_team", start: start - 30 * DAY, end: start },
      { price: "price_pro", start, end: start + 30 * DAY },
    ]),
  });
  assert.equal(scheduledChangeOf(config, catalog, s, NOW), null);
});

test("scheduledChangeOf: released or unexpanded schedules are ignored", () => {
  const end = NOW + 10 * DAY;
  const phases = [
    { price: "price_team", start: NOW - DAY, end },
    { price: "price_pro", start: end, end: end + 30 * DAY },
  ];
  assert.equal(scheduledChangeOf(config, catalog, sub("r", PRICES.team, "active", NOW, { schedule: schedule("s1", phases, "released") }), NOW), null);
  assert.equal(scheduledChangeOf(config, catalog, sub("u", PRICES.team, "active", NOW, { schedule: "sub_sched_2" }), NOW), null);
});

// --- classifyChange ---------------------------------------------------------------------

const PRO_MONTH = { plan: "pro", interval: "month" };

test("classifyChange: active upgrade and downgrade", () => {
  const state = stateOf(sub("s", PRICES.pro, "active", NOW - DAY));
  assert.deepEqual(classifyChange(config, state, { plan: "team" }), { kind: "upgrade", from: PRO_MONTH, to: { plan: "team", interval: "month" } });
  assert.deepEqual(classifyChange(config, state, { plan: "basic" }), { kind: "downgrade", from: PRO_MONTH, to: { plan: "basic", interval: "month" } });
  assert.deepEqual(classifyChange(config, state, { plan: "pro" }), { refusal: "same_plan" });
  assert.deepEqual(classifyChange(config, state, { plan: "enterprise" }), { refusal: "unknown_plan" });
  assert.deepEqual(classifyChange(config, state, { plan: "team", interval: "week" }), { refusal: "unknown_plan" });
});

test("classifyChange: monthly to yearly moves up, yearly to monthly or a smaller plan moves down", () => {
  const monthly = stateOf(sub("m", PRICES.pro, "active", NOW - DAY));
  assert.equal((classifyChange(config, monthly, { plan: "pro", interval: "year" }) as Any).kind, "upgrade");
  assert.equal((classifyChange(config, monthly, { plan: "team", interval: "year" }) as Any).kind, "upgrade");
  assert.equal((classifyChange(config, monthly, { plan: "basic", interval: "year" }) as Any).kind, "downgrade");

  const yearly = stateOf(sub("y", PRICES.proYear, "active", NOW - DAY));
  assert.equal((classifyChange(config, yearly, { plan: "pro", interval: "month" }) as Any).kind, "downgrade");
  assert.equal((classifyChange(config, yearly, { plan: "team", interval: "month" }) as Any).kind, "downgrade");
  assert.equal((classifyChange(config, yearly, { plan: "team" }) as Any).kind, "upgrade");
});

test("classifyChange: any change during a trial is a trial switch", () => {
  const state = stateOf(sub("s", PRICES.pro, "trialing", NOW - DAY, { default_payment_method: "pm_1" }));
  assert.equal((classifyChange(config, state, { plan: "team" }) as Any).kind, "trial_switch");
  assert.equal((classifyChange(config, state, { plan: "basic" }) as Any).kind, "trial_switch");
});

test("classifyChange: with a downgrade scheduled, the current plan means keep it", () => {
  const end = NOW + 10 * DAY;
  const state = stateOf(
    sub("s", PRICES.team, "active", NOW - 20 * DAY, {
      schedule: schedule("sched", [
        { price: "price_team", start: NOW - 20 * DAY, end },
        { price: "price_basic", start: end, end: end + 30 * DAY },
      ]),
    }),
  );
  assert.equal((classifyChange(config, state, { plan: "team" }) as Any).kind, "keep_current");
  assert.deepEqual(classifyChange(config, state, { plan: "basic" }), { refusal: "already_scheduled" });
  assert.equal((classifyChange(config, state, { plan: "pro" }) as Any).kind, "downgrade");
});

test("classifyChange: refusals", () => {
  assert.deepEqual(classifyChange(config, stateOf(), { plan: "pro" }), { refusal: "no_subscription" });
  assert.deepEqual(classifyChange(config, stateOf(sub("c", PRICES.pro, "canceled", NOW)), { plan: "pro" }), { refusal: "no_subscription" });
  assert.deepEqual(
    classifyChange(config, stateOf(sub("a", PRICES.pro, "active", NOW - DAY), sub("b", PRICES.team, "active", NOW)), { plan: "basic" }),
    { refusal: "multiple_subscriptions" },
  );
  assert.deepEqual(classifyChange(config, stateOf(sub("p", PRICES.pro, "past_due", NOW)), { plan: "team" }), { refusal: "past_due" });
  assert.deepEqual(
    classifyChange(config, stateOf(sub("x", PRICES.pro, "active", NOW, { cancel_at_period_end: true })), { plan: "team" }),
    { refusal: "cancel_scheduled" },
  );
  const twoItems = sub("t", PRICES.pro, "active", NOW);
  twoItems.items.data.push({ id: "si_extra", price: { id: "price_basic", product: "prod_basic", recurring: PRICES.basic.recurring } });
  assert.deepEqual(classifyChange(config, stateOf(twoItems), { plan: "team" }), { refusal: "unsupported_subscription" });
});

// --- policy to Stripe parameters ----------------------------------------------------------

test("changeStep: default policy charges upgrades now, schedules downgrades, keeps the trial free", () => {
  assert.deepEqual(changeStep(config, "upgrade"), {
    when: "now",
    proration_behavior: "always_invoice",
    payment_behavior: "pending_if_incomplete",
    chargesNow: true,
  });
  assert.deepEqual(changeStep(config, "downgrade"), { when: "period_end" });
  assert.deepEqual(changeStep(config, "trial_switch"), { when: "now", proration_behavior: "none", chargesNow: false });
  assert.deepEqual(changeStep(config, "keep_current"), { when: "release_schedule" });
});

test("changeStep: alternative policies", () => {
  const alt = configWith({ upgrade: "credit_next_invoice", downgrade: "now_with_credit", trialSwitch: "end_trial_and_charge" });
  assert.deepEqual(changeStep(alt, "upgrade"), { when: "now", proration_behavior: "create_prorations", chargesNow: false });
  assert.deepEqual(changeStep(alt, "downgrade"), { when: "now", proration_behavior: "create_prorations", chargesNow: false });
  assert.deepEqual(changeStep(alt, "trial_switch"), {
    when: "now",
    proration_behavior: "always_invoice",
    payment_behavior: "pending_if_incomplete",
    trial_end: "now",
    chargesNow: true,
  });
});

test("changeStep: an interval change made now restarts the billing period, a trial switch does not", () => {
  assert.equal((changeStep(config, "upgrade", true) as Any).resetBillingCycleAnchor, true);
  assert.equal((changeStep(config, "upgrade", false) as Any).resetBillingCycleAnchor, undefined);
  assert.equal((changeStep(config, "trial_switch", true) as Any).resetBillingCycleAnchor, undefined);
  assert.deepEqual(changeStep(config, "downgrade", true), { when: "period_end" });
  const now = configWith({ downgrade: "now_with_credit" });
  assert.equal((changeStep(now, "downgrade", true) as Any).resetBillingCycleAnchor, true);
});

test("isProrationDateUsable: fresh, past, inside the period", () => {
  assert.equal(isProrationDateUsable(config, NOW - 60, NOW - DAY, NOW), true);
  assert.equal(isProrationDateUsable(config, NOW + 1, NOW - DAY, NOW), false);
  assert.equal(isProrationDateUsable(config, NOW - 16 * 60, NOW - DAY, NOW), false);
  assert.equal(isProrationDateUsable(config, NOW - 60, NOW - 30, NOW), false);
  assert.equal(isProrationDateUsable(config, "1789999940", NOW - DAY, NOW), false);
});

test("cancelMode: trial and past due end now under the default; past due always ends now", () => {
  assert.equal(cancelMode(config, "active"), "period_end");
  assert.equal(cancelMode(config, "trialing"), "now");
  assert.equal(cancelMode(config, "past_due"), "now");
  const periodEnd = configWith({ cancel: "always_period_end" });
  assert.equal(cancelMode(periodEnd, "trialing"), "period_end");
  assert.equal(cancelMode(periodEnd, "past_due"), "now");
  assert.equal(cancelMode(configWith({ cancel: "always_now" }), "active"), "now");
});
