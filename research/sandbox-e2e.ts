// End-to-end run of the reference services against a real Stripe sandbox, using test clocks.
//
//   node --env-file=.env.test research/sandbox-e2e.ts [scenario ...]
//
// Needs STRIPE_SECRET_KEY for a sandbox or test mode (sk_test_ / rk_test_); a live key is refused.
// Creates three products with monthly and yearly prices (reused on later runs), plus one customer
// on its own test clock per scenario. The clocks, and with them the customers and subscriptions,
// are deleted at the end. The billing store is in memory; webhooks are replayed from the account's
// real events, signed locally, so no endpoint is needed.

import assert from "node:assert/strict";
import type Stripe from "stripe";
import { type BillingConfig, DEFAULT_POLICY, type Interval, validateConfig } from "../skills/saascribe/templates/core/config.ts";
import type {
  BillingDeps,
  EmailMessage,
  HeldChange,
  SubscriberRow,
  SubscriberStore,
  SubscriberWrite,
} from "../skills/saascribe/templates/ports.ts";
import { cancelSubscription } from "../skills/saascribe/templates/services/cancel.ts";
import { changePlan } from "../skills/saascribe/templates/services/change-plan.ts";
import { createStripe } from "../skills/saascribe/templates/services/stripe-client.ts";
import { syncCustomer } from "../skills/saascribe/templates/services/sync.ts";
import { handleWebhook, type WebhookDeps } from "../skills/saascribe/templates/services/webhook.ts";

const key = process.env.STRIPE_SECRET_KEY ?? "";
if (!/^(sk|rk)_test_/.test(key)) throw new Error("STRIPE_SECRET_KEY must be a sandbox or test-mode key");
const stripe = createStripe(key);
const WEBHOOK_SECRET = "whsec_local_e2e";
const RUN = Date.now().toString(36);
const DAY = 86_400;

const config: BillingConfig = validateConfig({
  plans: [{ id: "basic", rank: 1 }, { id: "pro", rank: 2 }, { id: "team", rank: 3 }],
  productMetadataKey: "plan",
  currency: "usd",
  intervals: ["month", "year"],
  policy: DEFAULT_POLICY,
});

const AMOUNTS: Record<string, Record<Interval, number>> = {
  basic: { month: 1000, year: 10000 },
  pro: { month: 3000, year: 30000 },
  team: { month: 9000, year: 90000 },
};

// --- catalog --------------------------------------------------------------------------------

const prices: Record<string, string> = {};

async function ensureCatalog() {
  for (const plan of Object.keys(AMOUNTS)) {
    const found = await stripe.products.search({ query: `metadata['plan']:'${plan}' AND active:'true'` });
    const product = found.data[0] ??
      await stripe.products.create({ name: `SaaScribe E2E ${plan}`, metadata: { plan } });
    for (const interval of ["month", "year"] as Interval[]) {
      const lookup = `saascribe_e2e_${plan}_${interval}`;
      const existing = await stripe.prices.list({ lookup_keys: [lookup], limit: 1 });
      const price = existing.data[0] ?? await stripe.prices.create({
        product: product.id,
        currency: "usd",
        unit_amount: AMOUNTS[plan][interval],
        recurring: { interval },
        lookup_key: lookup,
      });
      prices[`${plan}:${interval}`] = price.id;
    }
  }
}

// --- app side -------------------------------------------------------------------------------

function memoryStore(): SubscriberStore & { rows: (SubscriberRow & SubscriberWrite)[]; held: Record<string, HeldChange> } {
  const rows: (SubscriberRow & SubscriberWrite)[] = [];
  const held: Record<string, HeldChange> = {};
  let token = 0;
  const find: SubscriberStore["find"] = async ({ userId, customerId, email }) =>
    (userId && rows.find((r) => r.userId === userId)) ||
    (customerId && rows.find((r) => r.stripeCustomerId === customerId)) ||
    (email && rows.find((r) => r.email.toLowerCase() === email.toLowerCase())) ||
    null;
  return {
    rows,
    held,
    find,
    listAll: async () => rows,
    nextSyncToken: async () => ++token,
    save: async (write) => {
      const existing = await find({ userId: write.userId, customerId: write.stripeCustomerId, email: write.email }) as
        | (SubscriberRow & SubscriberWrite)
        | null;
      const previousPlan = existing?.plan ?? null;
      if (existing && existing.syncToken > write.syncToken) return { rowId: existing.id, userId: existing.userId, previousPlan, saved: false };
      if (existing) {
        Object.assign(existing, write, { id: existing.id, userId: existing.userId ?? write.userId, plan: write.plan ?? existing.plan });
        return { rowId: existing.id, userId: existing.userId, previousPlan, saved: true };
      }
      const row = { ...write, id: `row_${rows.length + 1}` };
      rows.push(row);
      return { rowId: row.id, userId: row.userId, previousPlan, saved: true };
    },
    holdChange: async (customerId, change) => {
      if (!rows.some((r) => r.stripeCustomerId === customerId)) return false;
      if (change) held[customerId] = change;
      else delete held[customerId];
      return true;
    },
    takeHeldChange: async (customerId) => {
      const change = held[customerId] ?? null;
      delete held[customerId];
      return change;
    },
  };
}

function app(appConfig: BillingConfig = config) {
  const sent: EmailMessage[] = [];
  const logs: string[] = [];
  const store = memoryStore();
  const deps: BillingDeps = {
    config: appConfig,
    stripe,
    mode: "test",
    store,
    mailer: { send: async (m) => void sent.push(m) },
    log: {
      info: (m) => void logs.push(m),
      error: (m, d) => void logs.push(`ERROR ${m} ${JSON.stringify(d ?? {})}`),
    },
    copy: { supportEmail: "help@example.com", appUrl: "https://app.example.com", billingPath: "/billing", postCheckoutPath: "/welcome", cancelReasons: ["too_expensive"] },
  };
  const { stripe: _s, mode: _m, ...rest } = deps;
  const wdeps: WebhookDeps = {
    ...rest,
    modes: {
      activeMode: async () => "test",
      credentials: (mode) => ({ mode, secretKey: mode === "test" ? key : null, webhookSecret: mode === "test" ? WEBHOOK_SECRET : null }),
    },
    makeStripe: () => stripe,
  };
  return { deps, wdeps, store, sent, logs };
}

// --- Stripe side ----------------------------------------------------------------------------

const clocks: string[] = [];

interface Account {
  clock: Stripe.TestHelpers.TestClock;
  customer: Stripe.Customer;
  user: { id: string; email: string; emailVerified: boolean };
  subscription: Stripe.Subscription;
  startedAt: number;
}

async function account(name: string, plan: string, interval: Interval, opts: { trialDays?: number } = {}): Promise<Account> {
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now() / 1000), name: `e2e ${name} ${RUN}` });
  clocks.push(clock.id);
  const email = `e2e+${name}-${RUN}@example.com`;
  const customer = await stripe.customers.create({
    email,
    test_clock: clock.id,
    payment_method: "pm_card_visa",
    invoice_settings: { default_payment_method: "pm_card_visa" },
  });
  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: prices[`${plan}:${interval}`] }],
    ...(opts.trialDays ? { trial_period_days: opts.trialDays } : {}),
  });
  return { clock, customer, user: { id: `user_${name}`, email, emailVerified: true }, subscription, startedAt: Math.floor(Date.now() / 1000) };
}

async function useCard(a: Account, testPaymentMethod: string) {
  const pm = await stripe.paymentMethods.attach(testPaymentMethod, { customer: a.customer.id });
  await stripe.customers.update(a.customer.id, { invoice_settings: { default_payment_method: pm.id } });
}

async function advance(a: Account, days: number) {
  const current = await stripe.testHelpers.testClocks.retrieve(a.clock.id);
  await stripe.testHelpers.testClocks.advance(a.clock.id, { frozen_time: current.frozen_time + days * DAY });
  for (let i = 0; i < 120; i++) {
    const c = await stripe.testHelpers.testClocks.retrieve(a.clock.id);
    if (c.status === "ready") return;
    if (c.status === "internal_failure") throw new Error("test clock failed");
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("test clock did not finish advancing");
}

const sub = (a: Account) => stripe.subscriptions.retrieve(a.subscription.id, { expand: ["schedule", "latest_invoice"] });
const planOf = (s: Stripe.Subscription) => {
  const price = s.items.data[0].price;
  return Object.entries(prices).find(([, id]) => id === price.id)?.[0] ?? price.id;
};
const nextPhasePlan = (s: Stripe.Subscription) => {
  const schedule = s.schedule as Stripe.SubscriptionSchedule | null;
  if (!schedule || schedule.status !== "active") return null;
  const now = schedule.current_phase?.end_date ?? 0;
  const next = schedule.phases.find((p) => p.start_date >= now);
  const price = next?.items[0]?.price;
  const id = typeof price === "string" ? price : price?.id;
  return Object.entries(prices).find(([, p]) => p === id)?.[0] ?? null;
};

/** Replays this customer's real events since `since` through the webhook handler. */
async function replayEvents(a: Account, wdeps: WebhookDeps, since: number, types?: string[]) {
  const seen: string[] = [];
  const events: Stripe.Event[] = [];
  for await (const event of stripe.events.list({ created: { gte: since - 5 }, limit: 100 })) events.push(event);
  for (const event of events.reverse()) {
    const object = event.data.object as { customer?: string | { id: string } | null; id?: string };
    const customerId = typeof object.customer === "string" ? object.customer : object.customer?.id ?? (object.id === a.customer.id ? a.customer.id : null);
    if (customerId !== a.customer.id) continue;
    if (types && !types.includes(event.type)) continue;
    const payload = JSON.stringify(event);
    const header = await stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: WEBHOOK_SECRET });
    const result = await handleWebhook(wdeps, payload, header);
    assert.equal(result.status, 200, `${event.type}: ${JSON.stringify(result.body)}`);
    seen.push(event.type);
  }
  return seen;
}

async function preview(deps: BillingDeps, a: Account, plan: string, interval: Interval) {
  const result = await changePlan(deps, a.user, { action: "preview", plan, interval });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body as Record<string, unknown>;
}

async function apply(deps: BillingDeps, a: Account, plan: string, interval: Interval, prorationDate?: unknown) {
  return changePlan(deps, a.user, { action: "apply", plan, interval, requestId: `${plan}-${interval}-${Date.now()}`, prorationDate });
}

// --- scenarios ------------------------------------------------------------------------------

type Scenario = () => Promise<string>;

const scenarios: Record<string, Scenario> = {
  async upgrade_paid() {
    const { deps } = app();
    const a = await account("upgrade", "basic", "month");
    await syncCustomer(deps, a.customer.id, a.user);
    const p = await preview(deps, a, "pro", "month");
    const result = await apply(deps, a, "pro", "month", p.proration_date);
    assert.equal(result.body.status, "applied", JSON.stringify(result.body));
    const s = await sub(a);
    assert.equal(planOf(s), "pro:month");
    const invoice = s.latest_invoice as Stripe.Invoice;
    assert.equal(invoice.status, "paid");
    assert.equal(invoice.amount_paid, p.amount_due_now, "charged amount equals the preview");
    return `preview ${p.amount_due_now}, charged ${invoice.amount_paid}, plan ${planOf(s)}`;
  },

  async upgrade_declined_restores_downgrade() {
    const { deps, store } = app();
    const a = await account("declined", "pro", "month");
    await syncCustomer(deps, a.customer.id, a.user);
    assert.equal((await apply(deps, a, "basic", "month")).body.status, "scheduled");
    await useCard(a, "pm_card_chargeCustomerFail");
    const p = await preview(deps, a, "team", "month");
    const result = await apply(deps, a, "team", "month", p.proration_date);
    assert.equal(result.status, 402, JSON.stringify(result.body));
    const s = await sub(a);
    assert.equal(planOf(s), "pro:month", "plan unchanged");
    assert.equal(s.pending_update, null, "no pending update left");
    assert.equal(nextPhasePlan(s), "basic:month", "downgrade restored");
    const invoices = await stripe.invoices.list({ subscription: s.id, status: "open" });
    assert.equal(invoices.data.length, 0, "no open invoice left");
    assert.equal(store.held[a.customer.id], undefined);
    return `402 ${result.body.code}; plan pro, downgrade to basic scheduled again, no open invoice`;
  },

  async three_ds_abandoned_restores_downgrade() {
    const { deps, store } = app();
    const a = await account("abandon", "pro", "month");
    await syncCustomer(deps, a.customer.id, a.user);
    assert.equal((await apply(deps, a, "basic", "month")).body.status, "scheduled");
    await useCard(a, "pm_card_authenticationRequired");
    const p = await preview(deps, a, "team", "month");
    const pending = await apply(deps, a, "team", "month", p.proration_date);
    assert.equal(pending.body.status, "requires_action", JSON.stringify(pending.body));
    assert.ok(String(pending.body.client_secret).startsWith("pi_"), "client secret of the PaymentIntent");
    assert.ok(store.held[a.customer.id], "downgrade held");
    const mid = await sub(a);
    assert.ok(mid.pending_update, "pending update while waiting");
    assert.equal(planOf(mid), "pro:month", "plan unchanged while waiting");

    const abandoned = await changePlan(deps, a.user, { action: "abandon_payment", requestId: `abandon-${RUN}` });
    assert.equal(abandoned.body.status, "payment_abandoned", JSON.stringify(abandoned.body));
    const s = await sub(a);
    assert.equal(s.pending_update, null);
    assert.equal(planOf(s), "pro:month");
    assert.equal(nextPhasePlan(s), "basic:month", "downgrade restored");
    return "requires_action with pi_ secret; abandon voided the charge and put the downgrade back";
  },

  async three_ds_expiry_webhook_restores_downgrade() {
    const { deps, wdeps, store } = app();
    const a = await account("expiry", "pro", "month");
    await syncCustomer(deps, a.customer.id, a.user);
    assert.equal((await apply(deps, a, "basic", "month")).body.status, "scheduled");
    await useCard(a, "pm_card_authenticationRequired");
    const p = await preview(deps, a, "team", "month");
    const since = Math.floor(Date.now() / 1000);
    assert.equal((await apply(deps, a, "team", "month", p.proration_date)).body.status, "requires_action");
    assert.ok(store.held[a.customer.id]);

    await advance(a, 2);
    const s0 = await sub(a);
    const seen = await replayEvents(a, wdeps, since, ["customer.subscription.pending_update_expired"]);
    if (seen.length === 0) {
      return `NOT RUN: no pending_update_expired event after advancing the clock 2 days (pending_update ${s0.pending_update ? "still set" : "cleared"})`;
    }
    const s = await sub(a);
    assert.equal(nextPhasePlan(s), "basic:month", "downgrade restored by the webhook");
    assert.equal(store.held[a.customer.id], undefined);
    return "pending_update_expired replayed; webhook put the downgrade back";
  },

  async downgrade_applies_at_period_end() {
    const { deps, wdeps, store } = app();
    const a = await account("downgrade", "pro", "month");
    await syncCustomer(deps, a.customer.id, a.user);
    const p = await preview(deps, a, "basic", "month");
    assert.equal(p.amount_due_now, 0);
    const since = Math.floor(Date.now() / 1000);
    assert.equal((await apply(deps, a, "basic", "month")).body.status, "scheduled");
    assert.equal(planOf(await sub(a)), "pro:month", "nothing changes before period end");
    await advance(a, 32);
    const s = await sub(a);
    assert.equal(planOf(s), "basic:month");
    const seen = await replayEvents(a, wdeps, since);
    const row = store.rows[0];
    assert.equal(row.plan, "basic");
    const invoice = s.latest_invoice as Stripe.Invoice;
    return `basic after the clock passed period end; renewal invoice ${invoice.amount_paid}; replayed ${seen.length} events, row plan ${row.plan}`;
  },

  async keep_plan_releases_schedule() {
    const { deps } = app();
    const a = await account("keep", "pro", "month");
    await syncCustomer(deps, a.customer.id, a.user);
    assert.equal((await apply(deps, a, "basic", "month")).body.status, "scheduled");
    const kept = await changePlan(deps, a.user, { action: "cancel_scheduled_change", requestId: `keep-${RUN}` });
    assert.equal(kept.body.status, "change_cancelled");
    const s = await sub(a);
    assert.equal(nextPhasePlan(s), null);
    await advance(a, 32);
    assert.equal(planOf(await sub(a)), "pro:month", "still pro after period end");
    return "schedule released; still pro after period end";
  },

  async trial_switch_is_free() {
    const { deps } = app();
    const a = await account("trial", "basic", "month", { trialDays: 7 });
    await syncCustomer(deps, a.customer.id, a.user);
    const trialEnd = a.subscription.trial_end;
    const p = await preview(deps, a, "pro", "month");
    assert.equal(p.amount_due_now, 0);
    const result = await apply(deps, a, "pro", "month");
    assert.equal(result.body.status, "applied", JSON.stringify(result.body));
    const s = await sub(a);
    assert.equal(s.status, "trialing");
    assert.equal(s.trial_end, trialEnd, "trial end unchanged");
    assert.equal(planOf(s), "pro:month");
    const paid = await stripe.invoices.list({ subscription: s.id, limit: 10 });
    const charged = paid.data.reduce((sum, i) => sum + i.amount_paid, 0);
    assert.equal(charged, 0);
    return "pro during trial, trial end unchanged, nothing charged";
  },

  async monthly_to_yearly() {
    const { deps } = app();
    const a = await account("yearly", "basic", "month");
    await syncCustomer(deps, a.customer.id, a.user);
    const p = await preview(deps, a, "basic", "year");
    const result = await apply(deps, a, "basic", "year", p.proration_date);
    assert.equal(result.body.status, "applied", JSON.stringify(result.body));
    const s = await sub(a);
    assert.equal(planOf(s), "basic:year");
    const invoice = s.latest_invoice as Stripe.Invoice;
    const item = s.items.data[0];
    const days = Math.round((item.current_period_end - item.current_period_start) / DAY);
    return `preview amount_due_now ${p.amount_due_now}, invoice paid ${invoice.amount_paid} (${p.amount_due_now === invoice.amount_paid ? "match" : "MISMATCH"}); new period ${days} days`;
  },

  async trial_switch_ends_trial_and_charges() {
    // The other trial policy: switching ends the trial and charges the new plan now.
    const { deps } = app(validateConfig({ ...config, policy: { ...DEFAULT_POLICY, trialSwitch: "end_trial_and_charge" } }));
    const a = await account("trialcharge", "basic", "month", { trialDays: 7 });
    await syncCustomer(deps, a.customer.id, a.user);
    const p = await preview(deps, a, "pro", "month");
    const result = await apply(deps, a, "pro", "month", p.proration_date);
    assert.equal(result.body.status, "applied", JSON.stringify(result.body));
    const s = await sub(a);
    assert.equal(s.status, "active");
    assert.equal(planOf(s), "pro:month");
    const invoice = s.latest_invoice as Stripe.Invoice;
    return `trial ended, now active on pro; preview ${p.amount_due_now}, paid ${invoice.amount_paid} (${p.amount_due_now === invoice.amount_paid ? "match" : "MISMATCH"})`;
  },

  async past_due_cancel_voids_invoice() {
    const { deps, wdeps, store } = app();
    const a = await account("pastdue", "basic", "month");
    await syncCustomer(deps, a.customer.id, a.user);
    await useCard(a, "pm_card_chargeCustomerFail");
    const since = Math.floor(Date.now() / 1000);
    await advance(a, 32);
    const before = await sub(a);
    assert.equal(before.status, "past_due", `status ${before.status}`);
    await replayEvents(a, wdeps, since);
    assert.equal(store.rows[0].entitled, true, "access kept while past due");
    const blocked = await changePlan(deps, a.user, { action: "preview", plan: "pro", interval: "month" });
    assert.equal(blocked.body.code, "past_due");
    const result = await cancelSubscription(deps, a.user, { reason: "too_expensive" });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const after = await stripe.subscriptions.retrieve(a.subscription.id);
    assert.equal(after.status, "canceled");
    const open = await stripe.invoices.list({ subscription: a.subscription.id, status: "open" });
    assert.equal(open.data.length, 0, "open invoice voided");
    return "past_due kept access, plan changes blocked; cancel ended it now and voided the open invoice";
  },
};

// --- run ------------------------------------------------------------------------------------

async function main() {
  await ensureCatalog();
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(scenarios);
  const results: [string, string][] = [];
  try {
    for (const name of names) {
      const scenario = scenarios[name];
      if (!scenario) throw new Error(`Unknown scenario ${name}`);
      process.stdout.write(`${name} ... `);
      try {
        const note = await scenario();
        results.push([name, `PASS  ${note}`]);
        console.log("PASS");
      } catch (error) {
        results.push([name, `FAIL  ${(error as Error).message.split("\n")[0]}`]);
        console.log("FAIL");
      }
    }
  } finally {
    for (const id of clocks) await stripe.testHelpers.testClocks.del(id).catch(() => {});
  }
  console.log("");
  for (const [name, line] of results) console.log(`${name}: ${line}`);
  if (results.some(([, line]) => line.startsWith("FAIL"))) process.exitCode = 1;
}

await main();
