import type Stripe from "stripe";
import type { BillingConfig } from "../../core/config.ts";
import type { AccountDetails, BillingCopy, BillingDeps, BillingUser, Logger, ModeSource } from "../../ports.ts";
import { auditBilling } from "../../services/audit.ts";
import { cancelSubscription, resumeSubscription } from "../../services/cancel.ts";
import { changePlan } from "../../services/change-plan.ts";
import { createCheckoutSession, createSubscriptionFirst } from "../../services/checkout.ts";
import { listInvoices } from "../../services/invoices.ts";
import { createPortalSession } from "../../services/portal.ts";
import { completePostPaymentSignup } from "../../services/post-payment.ts";
import { saveAccountDetails } from "../../services/profile.ts";
import type { ServiceResult } from "../../services/result.ts";
import { getBillingStatus } from "../../services/status.ts";
import { createStripe } from "../../services/stripe-client.ts";
import { handleWebhook } from "../../services/webhook.ts";

/**
 * Billing over Web-standard `Request` -> `Response`: Deno.serve, Supabase Edge Functions, Next.js
 * route handlers, Hono, Bun, Cloudflare Workers. Express wraps this (`express.ts`).
 *
 * Every route is POST with a JSON body. Who may call what:
 * - Public (no session): `checkout-session`, `checkout-subscription`,
 *   `post-payment/signup` (the checkout proof is the authentication), `webhook` (Stripe signature).
 * - Signed in: `status`, `change-plan`, `cancel`, `resume`, `invoices`, `portal`, `account-details`.
 * - Admin: `audit`.
 */

type Ports = Pick<BillingDeps, "store" | "mailer" | "identity" | "profiles" | "onPlanChange" | "recordCancellation">;

export interface BillingHttpOptions {
  config: BillingConfig;
  copy: BillingCopy;
  modes: ModeSource;
  /** Built per request; usually service-role database clients and the email provider. */
  ports: () => Ports;
  authenticate: (req: Request) => Promise<BillingUser | null>;
  isAdmin: (req: Request, user: BillingUser | null) => Promise<boolean>;
  /** Origins allowed to call the browser-facing routes, e.g. `["https://app.example.com"]`. */
  allowedOrigins: readonly string[];
  /** Path the Stripe webhook endpoints post to, for the settings check, e.g. `/functions/v1/billing/webhook`. */
  webhookPath: string;
  log?: Logger;
  makeStripe?: (secretKey: string) => Stripe;
  cryptoProvider?: Stripe.CryptoProvider;
}

export type BillingRoute =
  | "checkout-session"
  | "checkout-subscription"
  | "post-payment/signup"
  | "webhook"
  | "status"
  | "change-plan"
  | "cancel"
  | "resume"
  | "invoices"
  | "portal"
  | "account-details"
  | "audit";

const ROUTES: ReadonlySet<string> = new Set<BillingRoute>([
  "checkout-session", "checkout-subscription", "post-payment/signup", "webhook", "status",
  "change-plan", "cancel", "resume", "invoices", "portal", "account-details", "audit",
]);

/** `/functions/v1/billing/change-plan` with prefix `/functions/v1/billing/` -> `change-plan`. */
export function routeFromUrl(url: string, prefix: string): BillingRoute | null {
  const path = new URL(url).pathname;
  const index = path.indexOf(prefix);
  const route = index >= 0 ? path.slice(index + prefix.length).replace(/\/+$/, "") : "";
  return ROUTES.has(route) ? route as BillingRoute : null;
}

const consoleLog: Logger = {
  info: (message, data) => console.log(`[billing] ${message}`, data ?? ""),
  error: (message, data) => console.error(`[billing] ${message}`, data ?? ""),
};

const MAX_BODY_BYTES = 64 * 1024;

export function createBillingHandler(options: BillingHttpOptions) {
  const log = options.log ?? consoleLog;
  const makeStripe = options.makeStripe ?? createStripe;

  const cors = (req: Request): Record<string, string> => {
    const origin = req.headers.get("Origin");
    if (!origin || !options.allowedOrigins.includes(origin)) return {};
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      Vary: "Origin",
    };
  };
  const send = (req: Request, result: ServiceResult) =>
    new Response(JSON.stringify(result.body), { status: result.status, headers: { ...cors(req), "Content-Type": "application/json" } });
  const error = (req: Request, status: number, code: string, message: string) => send(req, { status, body: { code, error: message } });

  async function deps(): Promise<BillingDeps> {
    const mode = await options.modes.activeMode();
    const secretKey = options.modes.credentials(mode).secretKey;
    if (!secretKey) throw new Error(`No Stripe secret key for ${mode} mode`);
    return { config: options.config, copy: options.copy, stripe: makeStripe(secretKey), mode, log, ...options.ports() };
  }

  return async function handle(req: Request, route: BillingRoute | null): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
    if (req.method !== "POST") return error(req, 405, "method_not_allowed", "Use POST.");
    if (!route) return error(req, 404, "not_found", "Unknown billing route.");

    try {
      const raw = await req.text();
      if (route === "webhook") {
        return send(req, await handleWebhook(
          { config: options.config, copy: options.copy, log, modes: options.modes, makeStripe, cryptoProvider: options.cryptoProvider, ...options.ports() },
          raw,
          req.headers.get("stripe-signature"),
        ));
      }
      if (raw.length > MAX_BODY_BYTES) return error(req, 413, "too_large", "Request too large.");
      let body: Record<string, unknown> = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return error(req, 400, "bad_json", "Request body must be JSON.");
      }
      const user = await options.authenticate(req);
      // Billing finds the Stripe customer by email, so an unverified address must reach nothing.
      if (user && !user.emailVerified) {
        return error(req, 403, "email_unconfirmed", "Confirm your email address first, then try again.");
      }

      switch (route) {
        case "checkout-session":
          return send(req, await createCheckoutSession(await deps(), { ...body, user, uiMode: body.uiMode === "embedded_page" ? "embedded_page" : "hosted_page" }));
        case "checkout-subscription":
          return send(req, await createSubscriptionFirst(await deps(), { ...body, user } as Parameters<typeof createSubscriptionFirst>[1]));
        case "post-payment/signup":
          return send(req, await completePostPaymentSignup(await deps(), body));
        case "audit": {
          if (!(await options.isAdmin(req, user))) return error(req, 403, "forbidden", "Admins only.");
          return send(req, await auditBilling(await deps(), { webhookPath: options.webhookPath, email: typeof body.email === "string" ? body.email : undefined }));
        }
      }

      if (!user) return error(req, 401, "unauthenticated", "Please sign in again.");
      switch (route) {
        case "status":
          return send(req, await getBillingStatus(await deps(), user));
        case "change-plan":
          return send(req, await changePlan(await deps(), user, body));
        case "cancel":
          return send(req, await cancelSubscription(await deps(), user, body));
        case "resume":
          return send(req, await resumeSubscription(await deps(), user));
        case "invoices":
          return send(req, await listInvoices(await deps(), user));
        case "portal":
          return send(req, await createPortalSession(await deps(), user));
        case "account-details":
          return send(req, await saveAccountDetails(await deps(), user, body as AccountDetails));
      }
      return error(req, 404, "not_found", "Unknown billing route.");
    } catch (caught) {
      log.error("Billing route failed", { route, message: (caught as Error).message });
      return error(req, 500, "server_error", "Something went wrong. Please try again in a moment.");
    }
  };
}
