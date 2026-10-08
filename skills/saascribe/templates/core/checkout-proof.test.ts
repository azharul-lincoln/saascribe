// Run with Node 22.18+ (`node --test core/*.test.ts`) or Deno 2 (`deno test core/`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkIntent, checkSession, hashCheckoutNonce, newCheckoutNonce, parseCheckoutProof } from "./checkout-proof.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const NOW = 1_790_000_000;
const MAX_AGE = 30 * 24 * 60 * 60;
const SETUP_ID = "seti_1AbC";
const SETUP_SECRET = `${SETUP_ID}_secret_XyZ`;

function intent(object: "setup_intent" | "payment_intent", extra: Record<string, unknown> = {}): Any {
  return {
    object,
    client_secret: object === "setup_intent" ? SETUP_SECRET : "pi_1AbC_secret_XyZ",
    status: "succeeded",
    customer: "cus_1",
    created: NOW - 60,
    ...extra,
  };
}

const NONCE = "n".repeat(43);
const HASH = "ab".repeat(32);

function session(extra: Record<string, unknown> = {}): Any {
  return {
    mode: "subscription",
    status: "complete",
    customer: "cus_1",
    subscription: "sub_1",
    created: NOW - 60,
    metadata: { checkout_nonce_hash: HASH },
    ...extra,
  };
}

// --- parseCheckoutProof -----------------------------------------------------------------

test("parseCheckoutProof: accepts a setup or payment intent with its own secret", () => {
  assert.deepEqual(parseCheckoutProof({ intentId: SETUP_ID, clientSecret: SETUP_SECRET }), {
    kind: "intent",
    intentId: SETUP_ID,
    clientSecret: SETUP_SECRET,
  });
  assert.deepEqual(parseCheckoutProof({ intentId: "pi_9", clientSecret: "pi_9_secret_a" }), {
    kind: "intent",
    intentId: "pi_9",
    clientSecret: "pi_9_secret_a",
  });
});

test("parseCheckoutProof: accepts a checkout session id with its nonce", () => {
  assert.deepEqual(parseCheckoutProof({ sessionId: "cs_test_a1B2", nonce: NONCE }), { kind: "session", sessionId: "cs_test_a1B2", nonce: NONCE });
  assert.deepEqual(parseCheckoutProof({ sessionId: "cs_live_a1B2", nonce: NONCE }), { kind: "session", sessionId: "cs_live_a1B2", nonce: NONCE });
});

test("parseCheckoutProof: a session id alone is not proof", () => {
  assert.equal(parseCheckoutProof({ sessionId: "cs_test_a1B2" }), null);
  assert.equal(parseCheckoutProof({ sessionId: "cs_test_a1B2", nonce: "short" }), null);
});

test("checkout nonce: random, url-safe, and its hash is stable hex", async () => {
  const a = newCheckoutNonce();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, newCheckoutNonce());
  assert.equal(await hashCheckoutNonce("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("parseCheckoutProof: refuses missing, foreign or mismatched values", () => {
  assert.equal(parseCheckoutProof(null), null);
  assert.equal(parseCheckoutProof({ email: "a@b.c" }), null);
  assert.equal(parseCheckoutProof({ intentId: "cus_1", clientSecret: "cus_1_secret_a" }), null);
  assert.equal(parseCheckoutProof({ intentId: SETUP_ID, clientSecret: "seti_other_secret_a" }), null);
  assert.equal(parseCheckoutProof({ intentId: SETUP_ID, clientSecret: 42 }), null);
  assert.equal(parseCheckoutProof({ intentId: "seti_1;drop", clientSecret: "seti_1;drop_secret_a" }), null);
  assert.equal(parseCheckoutProof({ sessionId: "cs_test_a;drop", nonce: NONCE }), null);
  assert.equal(parseCheckoutProof({ sessionId: "{CHECKOUT_SESSION_ID}", nonce: NONCE }), null);
});

// --- checkIntent ------------------------------------------------------------------------

test("checkIntent: a succeeded setup intent proves the customer", () => {
  assert.deepEqual(checkIntent(intent("setup_intent"), SETUP_SECRET, NOW, MAX_AGE), { ok: true, customerId: "cus_1" });
  assert.deepEqual(checkIntent(intent("setup_intent", { customer: { id: "cus_2" } }), SETUP_SECRET, NOW, MAX_AGE), {
    ok: true,
    customerId: "cus_2",
  });
});

test("checkIntent: a wrong secret is refused, even with the right prefix", () => {
  assert.deepEqual(checkIntent(intent("setup_intent"), `${SETUP_ID}_secret_other`, NOW, MAX_AGE), { ok: false, reason: "secret_mismatch" });
  assert.deepEqual(checkIntent(intent("setup_intent", { client_secret: null }), SETUP_SECRET, NOW, MAX_AGE), {
    ok: false,
    reason: "secret_mismatch",
  });
});

test("checkIntent: an unfinished card step is refused; a processing payment is accepted", () => {
  assert.deepEqual(checkIntent(intent("setup_intent", { status: "requires_payment_method" }), SETUP_SECRET, NOW, MAX_AGE), {
    ok: false,
    reason: "status_requires_payment_method",
  });
  assert.deepEqual(checkIntent(intent("setup_intent", { status: "processing" }), SETUP_SECRET, NOW, MAX_AGE), {
    ok: false,
    reason: "status_processing",
  });
  assert.deepEqual(checkIntent(intent("payment_intent", { status: "processing" }), "pi_1AbC_secret_XyZ", NOW, MAX_AGE), {
    ok: true,
    customerId: "cus_1",
  });
});

test("checkIntent: no customer or an old checkout is refused", () => {
  assert.deepEqual(checkIntent(intent("setup_intent", { customer: null }), SETUP_SECRET, NOW, MAX_AGE), { ok: false, reason: "no_customer" });
  assert.deepEqual(checkIntent(intent("setup_intent", { created: NOW - MAX_AGE - 1 }), SETUP_SECRET, NOW, MAX_AGE), {
    ok: false,
    reason: "expired",
  });
});

// --- checkSession -----------------------------------------------------------------------

test("checkSession: a completed subscription session proves the customer, trials included", () => {
  assert.deepEqual(checkSession(session(), HASH, NOW, MAX_AGE), { ok: true, customerId: "cus_1" });
  assert.deepEqual(checkSession(session({ payment_status: "no_payment_required", customer: { id: "cus_2" } }), HASH, NOW, MAX_AGE), {
    ok: true,
    customerId: "cus_2",
  });
});

test("checkSession: a wrong or missing nonce hash is refused", () => {
  assert.deepEqual(checkSession(session(), "cd".repeat(32), NOW, MAX_AGE), { ok: false, reason: "nonce_mismatch" });
  assert.deepEqual(checkSession(session({ metadata: {} }), HASH, NOW, MAX_AGE), { ok: false, reason: "nonce_mismatch" });
});

test("checkSession: open, expired, payment-mode, customerless or old sessions are refused", () => {
  assert.deepEqual(checkSession(session({ status: "open" }), HASH, NOW, MAX_AGE), { ok: false, reason: "status_open" });
  assert.deepEqual(checkSession(session({ status: "expired" }), HASH, NOW, MAX_AGE), { ok: false, reason: "status_expired" });
  assert.deepEqual(checkSession(session({ mode: "payment" }), HASH, NOW, MAX_AGE), { ok: false, reason: "mode_payment" });
  assert.deepEqual(checkSession(session({ customer: null }), HASH, NOW, MAX_AGE), { ok: false, reason: "no_customer" });
  assert.deepEqual(checkSession(session({ subscription: null }), HASH, NOW, MAX_AGE), { ok: false, reason: "no_subscription" });
  assert.deepEqual(checkSession(session({ created: NOW - MAX_AGE - 1 }), HASH, NOW, MAX_AGE), { ok: false, reason: "expired" });
});
