// Run with Node 22.18+ (`node --test`) or Deno 2 (`deno test`). No network: Stripe is faked below,
// except `webhooks`, which is the real SDK so signatures are checked for real.
import { test } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { type BillingConfig, DEFAULT_POLICY, validateConfig } from "../core/config.ts";
import { hashCheckoutNonce } from "../core/checkout-proof.ts";
import type { BillingDeps, EmailMessage, HeldChange, ModeSource, StripeMode, SubscriberRow, SubscriberStore, SubscriberWrite } from "../ports.ts";
import { STRIPE_API_VERSION } from "./stripe-client.ts";
import { handleWebhook } from "./webhook.ts";
import { changePlan } from "./change-plan.ts";
import { cancelSubscription } from "./cancel.ts";
import { createSubscriptionFirst } from "./checkout.ts";
import { completePostPaymentSignup } from "./post-payment.ts";
import { applyState, readFresh } from "./sync.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

const config: BillingConfig = validateConfig({
  plans: [{ id: "basic", rank: 1 }, { id: "pro", rank: 2 }, { id: "team", rank: 3 }],
  productMetadataKey: "plan",
  currency: "usd",
  intervals: ["month"],
  policy: DEFAULT_POLICY,
});

// --- fakes ----------------------------------------------------------------------------------

function list<T>(items: T[]) {
  const page = { data: items, has_more: false };
  return Object.assign(Promise.resolve(page), {
    async *[Symbol.asyncIterator]() {
      yield* items;
    },
  });
}

const product = (id: string, plan: string) => ({ id, object: "product", active: true, created: 1, metadata: { plan } });
const price = (id: string, prod: Any, amount: number) => ({
  id,
  object: "price",
  active: true,
  created: 1,
  currency: "usd",
  unit_amount: amount,
  recurring: { interval: "month", interval_count: 1 },
  product: prod,
});
const PRICES = {
  basic: price("price_basic", product("prod_basic", "basic"), 1000),
  pro: price("price_pro", product("prod_pro", "pro"), 3000),
  team: price("price_team", product("prod_team", "team"), 9000),
};

function subscription(id: string, p: Any, status: string, extra: Record<string, unknown> = {}): Any {
  return {
    id,
    object: "subscription",
    customer: "cus_1",
    status,
    created: NOW - 10 * DAY,
    trial_end: null,
    cancel_at_period_end: false,
    cancel_at: null,
    default_payment_method: "pm_1",
    default_source: null,
    pending_setup_intent: null,
    pending_update: null,
    schedule: null,
    latest_invoice: null,
    metadata: {},
    cancellation_details: null,
    ended_at: null,
    items: {
      data: [{ id: `si_${id}`, price: { id: p.id, product: p.product.id, recurring: p.recurring }, current_period_start: NOW - 10 * DAY, current_period_end: NOW + 20 * DAY }],
    },
    ...extra,
  };
}

interface World {
  customers: Record<string, Any>;
  subs: Any[];
  invoices: Any[];
  calls: string[];
  /** What `subscriptions.update` answers for a price change. */
  onUpdate?: (id: string, params: Any) => Any;
  sessions?: Record<string, Any>;
}

function fakeStripe(world: World): Stripe {
  const real = new Stripe("sk_test_fake", { apiVersion: STRIPE_API_VERSION });
  const missing = () => Object.assign(new Error("No such object"), { code: "resource_missing" });
  const sub = (id: string) => world.subs.find((s) => s.id === id);
  return {
    webhooks: real.webhooks,
    prices: { list: () => list(Object.values(PRICES)) },
    customers: {
      retrieve: async (id: string) => world.customers[id] ?? Promise.reject(missing()),
      list: ({ email }: Any) => list(Object.values(world.customers).filter((c: Any) => c.email === email)),
      create: async (params: Any) => {
        world.calls.push("customers.create");
        const c = { id: `cus_${Object.keys(world.customers).length + 1}`, ...params };
        world.customers[c.id] = c;
        return c;
      },
      update: async (id: string, params: Any) => {
        world.calls.push(`customers.update:${id}`);
        return Object.assign(world.customers[id], params);
      },
    },
    subscriptions: {
      list: ({ customer }: Any) => list(world.subs.filter((s) => s.customer === customer)),
      retrieve: async (id: string) => sub(id) ?? Promise.reject(missing()),
      update: async (id: string, params: Any) => {
        world.calls.push(`subscriptions.update:${id}:${JSON.stringify(Object.keys(params).sort())}`);
        if (params.items && world.onUpdate) return world.onUpdate(id, params);
        return Object.assign(sub(id), params.cancel_at_period_end !== undefined ? { cancel_at_period_end: params.cancel_at_period_end } : {});
      },
      cancel: async (id: string) => {
        world.calls.push(`subscriptions.cancel:${id}`);
        return Object.assign(sub(id), { status: "canceled" });
      },
      create: async () => {
        world.calls.push("subscriptions.create");
        return { id: "sub_new", pending_setup_intent: { client_secret: "seti_1_secret_x" }, latest_invoice: null, trial_end: NOW + 7 * DAY };
      },
    },
    subscriptionSchedules: {
      release: async (id: string) => {
        world.calls.push(`schedules.release:${id}`);
        for (const s of world.subs) if (s.schedule?.id === id || s.schedule === id) s.schedule = null;
      },
      create: async () => {
        world.calls.push("schedules.create");
        return { id: "sched_new", phases: [{ start_date: NOW - 10 * DAY, end_date: NOW + 20 * DAY }] };
      },
      retrieve: async (id: string) => ({ id, phases: [{ start_date: NOW - 10 * DAY, end_date: NOW + 20 * DAY }] }),
      update: async (id: string) => {
        world.calls.push(`schedules.update:${id}`);
      },
    },
    invoices: {
      retrieve: async (id: string) => world.invoices.find((i) => i.id === id) ?? Promise.reject(missing()),
      list: ({ subscription: s, status }: Any) => list(world.invoices.filter((i) => i.subscription === s && i.status === status)),
      voidInvoice: async (id: string) => {
        world.calls.push(`invoices.void:${id}`);
        // Voiding the invoice of a pending update discards the update, as Stripe does.
        for (const s of world.subs) if (s.pending_update && (s.latest_invoice?.id ?? s.latest_invoice) === id) s.pending_update = null;
      },
      createPreview: async (params: Any) => {
        world.calls.push(`invoices.createPreview:${JSON.stringify(params.subscription_details)}`);
        return { amount_due: 0, total_taxes: [], lines: { data: [] }, next_payment_attempt: null };
      },
    },
    paymentIntents: { retrieve: async (id: string) => ({ id, status: world.invoices.find((i) => i.pi === id)?.piStatus }) },
    checkout: { sessions: { retrieve: async (id: string) => world.sessions?.[id] ?? Promise.reject(missing()) } },
  } as unknown as Stripe;
}

function memoryStore(): SubscriberStore & { rows: (SubscriberRow & SubscriberWrite)[]; held: Record<string, HeldChange> } {
  const rows: (SubscriberRow & SubscriberWrite)[] = [];
  const held: Record<string, HeldChange> = {};
  let lastToken = 0;
  const find: SubscriberStore["find"] = async ({ userId, customerId, email }) =>
    (userId && rows.find((r) => r.userId === userId)) ||
    (customerId && rows.find((r) => r.stripeCustomerId === customerId)) ||
    (email && rows.find((r) => r.email.toLowerCase() === email.toLowerCase())) ||
    null;
  return {
    rows,
    find,
    listAll: async () => rows,
    nextSyncToken: async () => ++lastToken,
    held,
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
    save: async (write) => {
      const existing = await find({ userId: write.userId, customerId: write.stripeCustomerId, email: write.email }) as Any;
      const previousPlan = existing?.plan ?? null;
      if (existing && existing.syncToken > write.syncToken) {
        return { rowId: existing.id, userId: existing.userId, previousPlan, saved: false };
      }
      if (existing) {
        Object.assign(existing, write, { id: existing.id, userId: existing.userId ?? write.userId, plan: write.plan ?? existing.plan });
        return { rowId: existing.id, userId: existing.userId, previousPlan, saved: true };
      }
      const row = { ...write, id: `row_${rows.length + 1}` };
      rows.push(row);
      return { rowId: row.id, userId: row.userId, previousPlan, saved: true };
    },
  };
}

function setup(world: World, mode: StripeMode = "live") {
  const sent: EmailMessage[] = [];
  const store = memoryStore();
  const stripe = fakeStripe(world);
  const deps: BillingDeps = {
    config,
    stripe,
    mode,
    store,
    mailer: { send: async (m) => void sent.push(m) },
    log: { info: () => {}, error: () => {} },
    copy: { supportEmail: "help@example.com", appUrl: "https://app.example.com", billingPath: "/billing", postCheckoutPath: "/welcome", cancelReasons: ["too_expensive"] },
    identity: {
      findByEmail: async () => null,
      createUnconfirmedUser: async () => ({ userId: "user_new", confirmUrl: "https://auth.example.com/verify?token=t" }),
    },
  };
  return { deps, store, sent, stripe };
}

const user = { id: "user_1", email: "a@example.com", emailVerified: true };
const baseWorld = (subs: Any[], extra: Partial<World> = {}): World => ({
  customers: { cus_1: { id: "cus_1", object: "customer", email: "a@example.com" } },
  subs,
  invoices: [],
  calls: [],
  ...extra,
});

// --- sync -----------------------------------------------------------------------------------

test("sync: an older Stripe read that saves last is refused, and the plan side effect ends on the newer plan", async () => {
  const world = baseWorld([subscription("sub_1", PRICES.basic, "active")]);
  const { deps, store } = setup(world);
  const changes: string[] = [];
  deps.onPlanChange = async ({ to }) => void changes.push(to);
  await applyState(deps, await readFresh(deps, "cus_1"), { email: user.email, userId: user.id });

  // Webhook A reads Stripe while the customer is on Pro; webhook B reads after a move to Team.
  world.subs[0] = subscription("sub_1", PRICES.pro, "active");
  const older = await readFresh(deps, "cus_1");
  world.subs[0] = subscription("sub_1", PRICES.team, "active");
  const newer = await readFresh(deps, "cus_1");

  // B saves first; A, finishing late, must not put Pro back.
  assert.equal((await applyState(deps, newer, { email: user.email, userId: user.id })).saved, true);
  const late = await applyState(deps, older, { email: user.email, userId: user.id });
  assert.equal(late.saved, false);
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0].plan, "team");
  assert.equal(changes.at(-1), "team");
});

// --- webhook --------------------------------------------------------------------------------

const SECRETS = { test: "whsec_test", live: "whsec_live" };
const modes = (active: StripeMode | Error): ModeSource => ({
  activeMode: async () => {
    if (active instanceof Error) throw active;
    return active;
  },
  credentials: (mode) => ({ mode, secretKey: `sk_${mode}_x`, webhookSecret: SECRETS[mode] }),
});

async function signed(stripe: Stripe, event: Any, secret: string) {
  const payload = JSON.stringify(event);
  return { payload, header: await stripe.webhooks.generateTestHeaderStringAsync({ payload, secret }) };
}

const subEvent = (type: string, sub: Any, livemode: boolean, previous?: Any) => ({
  id: `evt_${Math.random().toString(36).slice(2)}`,
  object: "event",
  type,
  livemode,
  created: NOW,
  data: { object: sub, ...(previous ? { previous_attributes: previous } : {}) },
});

function webhookDeps(world: World, active: StripeMode | Error) {
  const { deps, store, sent, stripe } = setup(world);
  const { stripe: _s, mode: _m, ...rest } = deps;
  return { wdeps: { ...rest, modes: modes(active), makeStripe: () => stripe }, store, sent, stripe };
}

test("webhook: a bad signature is 400 and writes nothing", async () => {
  const world = baseWorld([subscription("sub_1", PRICES.pro, "active")]);
  const { wdeps, store, stripe } = webhookDeps(world, "live");
  const { payload } = await signed(stripe, subEvent("customer.subscription.created", world.subs[0], true), SECRETS.live);
  const forged = await stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: "whsec_attacker" });
  const result = await handleWebhook(wdeps, payload, forged);
  assert.equal(result.status, 400);
  assert.equal(store.rows.length, 0);
  assert.equal((await handleWebhook(wdeps, payload, null)).status, 400);
});

test("webhook: events from the inactive mode are acknowledged and dropped", async () => {
  const world = baseWorld([subscription("sub_1", PRICES.pro, "active")]);
  const { wdeps, store, sent, stripe } = webhookDeps(world, "live");
  const { payload, header } = await signed(stripe, subEvent("customer.subscription.created", world.subs[0], false), SECRETS.test);
  const result = await handleWebhook(wdeps, payload, header);
  assert.equal(result.status, 200);
  assert.equal(result.body.ignored, "test_mode");
  assert.equal(store.rows.length, 0);
  assert.equal(sent.length, 0);
});

test("webhook: an unreadable active mode fails the delivery so Stripe retries", async () => {
  const world = baseWorld([subscription("sub_1", PRICES.pro, "active")]);
  const { wdeps, store, stripe } = webhookDeps(world, new Error("db down"));
  const { payload, header } = await signed(stripe, subEvent("customer.subscription.created", world.subs[0], true), SECRETS.live);
  assert.equal((await handleWebhook(wdeps, payload, header)).status, 500);
  assert.equal(store.rows.length, 0);
});

test("webhook: a livemode flag that contradicts the verifying secret is refused", async () => {
  const world = baseWorld([subscription("sub_1", PRICES.pro, "active")]);
  const { wdeps, stripe } = webhookDeps(world, "live");
  const { payload, header } = await signed(stripe, subEvent("customer.subscription.created", world.subs[0], false), SECRETS.live);
  assert.equal((await handleWebhook(wdeps, payload, header)).status, 400);
});

test("webhook: the row comes from all subscriptions, and 'plan active' is sent once on the card step", async () => {
  const trial = subscription("sub_1", PRICES.pro, "trialing", { default_payment_method: "pm_1", trial_end: NOW + 5 * DAY });
  const world = baseWorld([trial]);
  const { wdeps, store, sent, stripe } = webhookDeps(world, "live");
  const cardSaved = subEvent("customer.subscription.updated", trial, true, { default_payment_method: null });
  const { payload, header } = await signed(stripe, cardSaved, SECRETS.live);
  assert.equal((await handleWebhook(wdeps, payload, header)).status, 200);
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0].plan, "pro");
  assert.equal(store.rows[0].entitled, true);
  assert.deepEqual(sent.map((m) => m.dedupeKey), ["subscription_confirmed:sub_1"]);

  // A later renewal-style update (no card change) sends nothing new.
  const renewal = await signed(stripe, subEvent("customer.subscription.updated", trial, true, { status: "trialing" }), SECRETS.live);
  await handleWebhook(wdeps, renewal.payload, renewal.header);
  assert.equal(sent.length, 1);
});

test("webhook: a deleted duplicate while another plan runs sends no cancellation email", async () => {
  const running = subscription("sub_run", PRICES.pro, "active");
  const duplicate = subscription("sub_dup", PRICES.basic, "canceled", { cancellation_details: { comment: "customer:too_expensive" } });
  const world = baseWorld([running, duplicate]);
  const { wdeps, sent, stripe } = webhookDeps(world, "live");
  const { payload, header } = await signed(stripe, subEvent("customer.subscription.deleted", duplicate, true), SECRETS.live);
  await handleWebhook(wdeps, payload, header);
  assert.equal(sent.filter((m) => m.type === "subscription_cancelled").length, 0);
});

// --- change plan ----------------------------------------------------------------------------

test("change-plan: a declined upgrade voids the invoice, restores the released downgrade, and reports 402", async () => {
  const sched = { id: "sched_1", status: "active", phases: [
    { start_date: NOW - 10 * DAY, end_date: NOW + 20 * DAY, items: [{ price: "price_pro" }] },
    { start_date: NOW + 20 * DAY, end_date: NOW + 50 * DAY, items: [{ price: "price_basic" }] },
  ] };
  const pro = subscription("sub_1", PRICES.pro, "active", { schedule: sched });
  {
    const world = baseWorld([pro], {
      invoices: [{ id: "in_up", status: "open", pi: "pi_up", piStatus: "requires_payment_method", payments: { data: [{ payment: { type: "payment_intent", payment_intent: "pi_up" } }] } }],
      onUpdate: () => ({ ...pro, pending_update: { expires_at: NOW + DAY }, latest_invoice: { id: "in_up", confirmation_secret: { client_secret: "pi_up_secret" }, payments: { data: [{ payment: { type: "payment_intent", payment_intent: "pi_up" } }] } } }),
    });
    const { deps } = setup(world);
    const result = await changePlan(deps, user, { action: "apply", plan: "team", requestId: "r1", prorationDate: NOW - 30 });
    assert.equal(result.status, 402);
    assert.equal(result.body.code, "payment_failed");
    assert.ok(world.calls.includes("schedules.release:sched_1"));
    assert.ok(world.calls.includes("invoices.void:in_up"));
    assert.ok(world.calls.includes("schedules.create"), "downgrade restored");
  }
});

test("change-plan: an upgrade needing 3D Secure returns the client secret and voids nothing", async () => {
  const basic = subscription("sub_1", PRICES.basic, "active");
  const world = baseWorld([basic], {
    invoices: [{ id: "in_up", status: "open", pi: "pi_up", piStatus: "requires_action" }],
    onUpdate: () => ({ ...basic, pending_update: { expires_at: NOW + DAY }, latest_invoice: { id: "in_up", confirmation_secret: { client_secret: "pi_up_secret_abc" }, payments: { data: [{ payment: { type: "payment_intent", payment_intent: "pi_up" } }] } } }),
  });
  const { deps } = setup(world);
  const result = await changePlan(deps, user, { action: "apply", plan: "pro", requestId: "r2", prorationDate: NOW - 30 });
  assert.equal(result.body.status, "requires_action");
  assert.equal(result.body.client_secret, "pi_up_secret_abc");
  assert.equal(world.calls.filter((c) => c.startsWith("invoices.void")).length, 0);
});

/** Pro with a downgrade to Basic scheduled; the upgrade to Team then waits on 3D Secure. */
function pendingUpgradeWorld() {
  const sched = { id: "sched_1", status: "active", phases: [
    { start_date: NOW - 10 * DAY, end_date: NOW + 20 * DAY, items: [{ price: "price_pro" }] },
    { start_date: NOW + 20 * DAY, end_date: NOW + 50 * DAY, items: [{ price: "price_basic" }] },
  ] };
  const pro = subscription("sub_1", PRICES.pro, "active", { schedule: sched });
  const latest = { id: "in_up", confirmation_secret: { client_secret: "pi_up_secret" }, payments: { data: [{ payment: { type: "payment_intent", payment_intent: "pi_up" } }] } };
  return baseWorld([pro], {
    invoices: [{ id: "in_up", status: "open", pi: "pi_up", piStatus: "requires_action" }],
    onUpdate: () => Object.assign(pro, { pending_update: { expires_at: NOW + DAY }, latest_invoice: latest }),
  });
}

test("change-plan: abandoning 3D Secure voids the charge and puts the released downgrade back", async () => {
  const world = pendingUpgradeWorld();
  const { deps, store } = setup(world);
  const pending = await changePlan(deps, user, { action: "apply", plan: "team", requestId: "r5", prorationDate: NOW - 30 });
  assert.equal(pending.body.status, "requires_action");
  assert.ok(world.calls.includes("schedules.release:sched_1"));
  assert.deepEqual(store.held.cus_1, { subscriptionId: "sub_1", plan: "basic", interval: "month" });

  const abandoned = await changePlan(deps, user, { action: "abandon_payment", requestId: "r5" });
  assert.equal(abandoned.body.status, "payment_abandoned");
  assert.ok(world.calls.includes("invoices.void:in_up"));
  assert.ok(world.calls.includes("schedules.create"), "downgrade restored");
  assert.equal(store.held.cus_1, undefined);
});

test("webhook: an expired pending update puts the held downgrade back; an applied one drops it", async () => {
  for (const type of ["customer.subscription.pending_update_expired", "customer.subscription.pending_update_applied"]) {
    const world = pendingUpgradeWorld();
    const { wdeps, store, stripe } = webhookDeps(world, "live");
    const deps: BillingDeps = { ...wdeps, stripe, mode: "live" };
    await changePlan(deps, user, { action: "apply", plan: "team", requestId: "r6", prorationDate: NOW - 30 });
    assert.ok(store.held.cus_1);

    world.subs[0].pending_update = null; // Stripe settled it: expired (invoice voided) or paid.
    const { payload, header } = await signed(stripe, subEvent(type, world.subs[0], true), SECRETS.live);
    assert.equal((await handleWebhook(wdeps, payload, header)).status, 200);
    assert.equal(store.held.cus_1, undefined);
    assert.equal(world.calls.includes("schedules.create"), type.endsWith("expired"), type);
  }
});

test("change-plan: a stale preview is refused before Stripe is touched", async () => {
  const world = baseWorld([subscription("sub_1", PRICES.basic, "active")]);
  const { deps } = setup(world);
  const result = await changePlan(deps, user, { action: "apply", plan: "pro", requestId: "r3", prorationDate: NOW - 3600 });
  assert.equal(result.body.code, "preview_expired");
  assert.equal(world.calls.filter((c) => c.startsWith("subscriptions.update")).length, 0);
});

test("change-plan: a downgrade is scheduled for period end, nothing is charged", async () => {
  const world = baseWorld([subscription("sub_1", PRICES.pro, "active")]);
  const { deps, sent } = setup(world);
  const result = await changePlan(deps, user, { action: "apply", plan: "basic", requestId: "r4" });
  assert.equal(result.body.status, "scheduled");
  assert.ok(world.calls.includes("schedules.create") && world.calls.includes("schedules.update:sched_new"));
  assert.equal(world.calls.filter((c) => c.startsWith("subscriptions.update")).length, 0);
  assert.equal(sent[0].type, "plan_changed");
});

test("change-plan: two paid subscriptions block any change", async () => {
  const world = baseWorld([subscription("a", PRICES.basic, "active"), subscription("b", PRICES.pro, "active")]);
  const { deps } = setup(world);
  const result = await changePlan(deps, user, { action: "preview", plan: "basic" });
  assert.equal(result.body.code, "multiple_subscriptions");
  assert.match(String(result.body.error), /help@example\.com/);
});

test("change-plan: a free trial switch previews without proration_date (Stripe refuses it with 'none')", async () => {
  const trial = subscription("sub_1", PRICES.basic, "trialing", { trial_end: NOW + 3 * DAY });
  const world = baseWorld([trial]);
  const result = await changePlan(setup(world).deps, user, { action: "preview", plan: "pro" });
  assert.equal(result.status, 200);
  assert.equal(result.body.kind, "trial_switch");
  assert.equal(result.body.amount_due_now, 0);
  const preview = world.calls.find((c) => c.startsWith("invoices.createPreview:"))!;
  assert.ok(preview.includes('"proration_behavior":"none"'));
  assert.ok(!preview.includes("proration_date"));
});

test("change-plan: an upgrade preview sends the proration_date it returns", async () => {
  const world = baseWorld([subscription("sub_1", PRICES.basic, "active")]);
  const result = await changePlan(setup(world).deps, user, { action: "preview", plan: "pro" });
  const preview = world.calls.find((c) => c.startsWith("invoices.createPreview:"))!;
  assert.ok(preview.includes(`"proration_date":${result.body.proration_date}`));
  assert.ok(preview.includes('"proration_behavior":"always_invoice"'));
});

// --- cancel ---------------------------------------------------------------------------------

test("cancel: past due ends now and voids the open invoice; active runs to period end", async () => {
  const world = baseWorld([subscription("sub_pd", PRICES.pro, "past_due")], { invoices: [{ id: "in_open", subscription: "sub_pd", status: "open" }] });
  const { deps } = setup(world);
  const result = await cancelSubscription(deps, user, { reason: "too_expensive" });
  assert.equal(result.body.mode, "now");
  assert.ok(world.calls.includes("subscriptions.cancel:sub_pd"));
  assert.ok(world.calls.includes("invoices.void:in_open"));

  const world2 = baseWorld([subscription("sub_ok", PRICES.pro, "active")]);
  const result2 = await cancelSubscription(setup(world2).deps, user, { reason: "too_expensive" });
  assert.equal(result2.body.mode, "period_end");
  assert.equal(world2.calls.filter((c) => c.startsWith("subscriptions.cancel")).length, 0);
});

test("cancel: an unknown reason is refused", async () => {
  const { deps } = setup(baseWorld([subscription("s", PRICES.pro, "active")]));
  assert.equal((await cancelSubscription(deps, user, { reason: "nope" })).status, 400);
});

// --- checkout -------------------------------------------------------------------------------

test("checkout: an email that already pays is refused before the customer is touched", async () => {
  const world = baseWorld([subscription("sub_1", PRICES.pro, "active")]);
  const { deps } = setup(world);
  const result = await createSubscriptionFirst(deps, { plan: "basic", email: "a@example.com", name: "Mallory" });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "already_subscribed");
  assert.equal(world.calls.filter((c) => c.startsWith("customers.update") || c === "subscriptions.create").length, 0);
});

test("checkout: an anonymous buyer never overwrites an existing customer's details", async () => {
  const world = baseWorld([]);
  world.customers.cus_1 = { ...world.customers.cus_1, name: "Alice", address: { country: "US", postal_code: "10001" } };
  const result = await createSubscriptionFirst(setup(world).deps, { plan: "basic", email: "a@example.com", name: "Mallory", address: { country: "GB" } });
  assert.equal(result.status, 200);
  assert.equal(world.calls.filter((c) => c.startsWith("customers.update")).length, 0);
  assert.equal(world.customers.cus_1.name, "Alice");
});

test("checkout: an abandoned checkout is cancelled and replaced", async () => {
  const abandoned = subscription("sub_old", PRICES.pro, "incomplete", { default_payment_method: null });
  const world = baseWorld([abandoned]);
  const result = await createSubscriptionFirst(setup(world).deps, { plan: "basic", email: "a@example.com" });
  assert.equal(result.status, 200);
  assert.ok(world.calls.includes("subscriptions.cancel:sub_old"));
  assert.ok(world.calls.includes("subscriptions.create"));
});

// --- post-payment ---------------------------------------------------------------------------

test("post-payment: a session id without the right nonce is 403; with it, the account is created for the customer's email", async () => {
  const nonce = "N".repeat(43);
  const session = { id: "cs_test_abc", mode: "subscription", status: "complete", customer: "cus_1", subscription: "sub_1", created: NOW - 60, metadata: { checkout_nonce_hash: await hashCheckoutNonce(nonce) } };
  const world = baseWorld([subscription("sub_1", PRICES.pro, "trialing")], { sessions: { cs_test_abc: session } });
  const { deps, store } = setup(world);

  const bad = await completePostPaymentSignup(deps, { sessionId: "cs_test_abc", nonce: "M".repeat(43) });
  assert.equal(bad.status, 403);
  assert.equal(store.rows.length, 0);

  const good = await completePostPaymentSignup(deps, { sessionId: "cs_test_abc", nonce, email: "victim@example.com" });
  assert.equal(good.status, 200);
  assert.equal(good.body.email, "a@example.com");
  assert.equal(store.rows[0].userId, "user_new");
});

test("post-payment: the account starts unconfirmed and the confirm link goes to the customer's email", async () => {
  const nonce = "N".repeat(43);
  const session = { id: "cs_test_abc", mode: "subscription", status: "complete", customer: "cus_1", subscription: "sub_1", created: NOW - 60, metadata: { checkout_nonce_hash: await hashCheckoutNonce(nonce) } };
  const world = baseWorld([subscription("sub_1", PRICES.pro, "trialing")], { sessions: { cs_test_abc: session } });
  const { deps, sent } = setup(world);
  const asked: Any[] = [];
  deps.identity = {
    findByEmail: async () => null,
    createUnconfirmedUser: async (input) => {
      asked.push(input);
      return { userId: "user_new", confirmUrl: "https://auth.example.com/verify?token=t" };
    },
  };
  const result = await completePostPaymentSignup(deps, { sessionId: "cs_test_abc", nonce, password: "ignored-now" });
  assert.equal(result.body.confirmationSent, true);
  assert.equal(asked[0].email, "a@example.com");
  assert.equal("password" in asked[0], false, "no password is set before the email is confirmed");
  assert.deepEqual(sent.map((m) => [m.type, m.to, m.data.confirmUrl]), [["confirm_email", "a@example.com", "https://auth.example.com/verify?token=t"]]);
});
