// Run with Node 22.18+ (`node --test`) or Deno 2 (`deno test`). No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY, validateConfig } from "../../core/config.ts";
import { createBillingHandler, routeFromUrl } from "./web-standard.ts";

const noStore = {
  find: async () => null,
  nextSyncToken: async () => 1,
  holdChange: async () => false,
  takeHeldChange: async () => null,
  save: async () => {
    throw new Error("must not write");
  },
  listAll: async () => [],
};

const handle = createBillingHandler({
  config: validateConfig({ plans: [{ id: "pro", rank: 1 }], productMetadataKey: "plan", currency: "usd", intervals: ["month"], policy: DEFAULT_POLICY }),
  copy: { supportEmail: "s@example.com", appUrl: "https://app.example.com", billingPath: "/billing", postCheckoutPath: "/welcome", cancelReasons: ["other"] },
  modes: { activeMode: async () => "test", credentials: (mode) => ({ mode, secretKey: "sk_test_x", webhookSecret: "whsec_x" }) },
  ports: () => ({ store: noStore, mailer: { send: async () => {} } }),
  authenticate: async (req) => {
    const token = req.headers.get("Authorization");
    if (token === "Bearer good") return { id: "u1", email: "u1@example.com", emailVerified: true };
    if (token === "Bearer unverified") return { id: "u2", email: "victim@example.com", emailVerified: false };
    return null;
  },
  isAdmin: async () => false,
  allowedOrigins: ["https://app.example.com"],
  webhookPath: "/billing/webhook",
  log: { info: () => {}, error: () => {} },
});

const post = (route: string, init: RequestInit = {}) =>
  handle(new Request(`https://fn.example.com/functions/v1/billing/${route}`, { method: "POST", body: "{}", ...init }), routeFromUrl(`https://fn.example.com/functions/v1/billing/${route}`, "/billing/"));

test("routeFromUrl: known routes only", () => {
  assert.equal(routeFromUrl("https://x.co/functions/v1/billing/change-plan", "/billing/"), "change-plan");
  assert.equal(routeFromUrl("https://x.co/functions/v1/billing/post-payment/signup/", "/billing/"), "post-payment/signup");
  assert.equal(routeFromUrl("https://x.co/functions/v1/billing/../admin", "/billing/"), null);
  assert.equal(routeFromUrl("https://x.co/functions/v1/other/status", "/billing/"), null);
});

test("signed-in routes refuse a missing or bad session with 401", async () => {
  for (const route of ["status", "change-plan", "cancel", "resume", "invoices", "portal", "account-details"]) {
    assert.equal((await post(route)).status, 401, route);
    assert.equal((await post(route, { headers: { Authorization: "Bearer bad" } })).status, 401, route);
  }
});

test("a session whose email is not verified reaches no billing route, checkout included", async () => {
  for (const route of ["status", "change-plan", "cancel", "portal", "checkout-session", "checkout-subscription"]) {
    const res = await post(route, { headers: { Authorization: "Bearer unverified" } });
    assert.equal(res.status, 403, route);
    assert.equal((await res.json()).code, "email_unconfirmed", route);
  }
});

test("audit is admin only", async () => {
  assert.equal((await post("audit", { headers: { Authorization: "Bearer good" } })).status, 403);
});

test("webhook without a signature is 400, and never reaches the store", async () => {
  assert.equal((await post("webhook")).status, 400);
});

test("CORS headers only for allowed origins; GET is refused", async () => {
  const allowed = await post("status", { headers: { Origin: "https://app.example.com" } });
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), "https://app.example.com");
  const other = await post("status", { headers: { Origin: "https://evil.example.com" } });
  assert.equal(other.headers.get("Access-Control-Allow-Origin"), null);
  const get = await handle(new Request("https://fn.example.com/functions/v1/billing/status"), "status");
  assert.equal(get.status, 405);
});

test("bad JSON is 400, an unknown route is 404", async () => {
  assert.equal((await post("status", { body: "{not json", headers: { Authorization: "Bearer good" } })).status, 400);
  assert.equal((await handle(new Request("https://fn.example.com/x", { method: "POST" }), null)).status, 404);
});
