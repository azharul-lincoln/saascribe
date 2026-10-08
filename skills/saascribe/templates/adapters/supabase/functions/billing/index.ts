// Supabase Edge Function `billing`: every billing route behind one function.
//   POST https://<project>.supabase.co/functions/v1/billing/<route>
// Deploy with verify_jwt = false (the webhook, checkout and post-payment routes have no session);
// signed-in routes check the bearer token themselves through supabaseIdentity().authenticate.
//
// Copy `templates/core`, `templates/services`, `templates/ports.ts` and `templates/adapters` into
// `supabase/functions/_shared/billing/`, keeping the folder layout, and add the import map in
// `functions/deno.json` (see deno.json next to this file).
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { DEFAULT_POLICY, validateConfig } from "../_shared/billing/core/config.ts";
import { createBillingHandler, routeFromUrl } from "../_shared/billing/adapters/http/web-standard.ts";
import { envModeSource } from "../_shared/billing/adapters/mode/env.ts";
import {
  supabaseCancellationLog,
  supabaseDedupedMailer,
  supabaseIdentity,
  supabaseSubscriberStore,
} from "../_shared/billing/adapters/supabase/store.ts";

// Fill in your plans. Each plan is a Stripe product with metadata `plan=<id>` and one active price
// per interval you sell.
const config = validateConfig({
  plans: [
    { id: "basic", rank: 1 },
    { id: "pro", rank: 2 },
    { id: "team", rank: 3 },
  ],
  productMetadataKey: "plan",
  currency: "usd",
  intervals: ["month", "year"],
  policy: { ...DEFAULT_POLICY },
});

const env = (name: string) => Deno.env.get(name);
const admin = createClient(env("SUPABASE_URL")!, env("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const identity = supabaseIdentity(admin);
const log = {
  info: (message: string, data?: Record<string, unknown>) => console.log(`[billing] ${message}`, data ?? ""),
  error: (message: string, data?: Record<string, unknown>) => console.error(`[billing] ${message}`, data ?? ""),
};

// Replace with your provider (adapters/email). Until then emails are only logged.
const deliver = async (message: { type: string; to: string }) => log.info("Email not sent: no provider configured", { type: message.type });

const handle = createBillingHandler({
  config,
  copy: {
    supportEmail: env("BILLING_SUPPORT_EMAIL") ?? "support@example.com",
    appUrl: env("APP_URL") ?? "http://localhost:5173",
    billingPath: "/settings/billing",
    postCheckoutPath: "/welcome",
    cancelReasons: ["too_expensive", "not_enough_value", "not_using_it", "missing_feature", "switching_tool", "other"],
  },
  // Default: one mode per deployment from STRIPE_MODE. For a runtime switch use supabaseDbModeSource(admin, env).
  modes: envModeSource(env),
  ports: () => ({
    store: supabaseSubscriberStore(admin),
    mailer: supabaseDedupedMailer(admin, deliver, log),
    identity,
    recordCancellation: supabaseCancellationLog(admin),
  }),
  authenticate: (req) => identity.authenticate(req),
  // Replace with your admin rule (a role claim, an admins table).
  isAdmin: async (_req, user) => !!user && (env("BILLING_ADMIN_EMAILS") ?? "").split(",").map((e) => e.trim().toLowerCase()).includes(user.email.toLowerCase()),
  allowedOrigins: (env("BILLING_ALLOWED_ORIGINS") ?? env("APP_URL") ?? "").split(",").map((o) => o.trim()).filter(Boolean),
  webhookPath: "/functions/v1/billing/webhook",
  log,
  cryptoProvider: Stripe.createSubtleCryptoProvider(),
});

Deno.serve((req) => handle(req, routeFromUrl(req.url, "/billing/")));
