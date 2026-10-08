import type Stripe from "stripe";
import { type Interval, isInterval, normalizePlanId } from "../core/config.ts";
import { hashCheckoutNonce, newCheckoutNonce, NONCE_METADATA_KEY } from "../core/checkout-proof.ts";
import { getSellingPrice } from "../core/plan-catalog.ts";
import { isAbandonedCheckout, isLive, isPaidFor } from "../core/subscription-state.ts";
import type { BillingDeps, BillingUser } from "../ports.ts";
import { loadCatalog } from "./catalog.ts";
import { fail, ok, type ServiceResult } from "./result.ts";
import { readSubscriptions, resolveCustomer } from "./sync.ts";

/**
 * New subscriptions. One subscription per customer: changing plan is an update to that
 * subscription (`change-plan`), never a second checkout.
 *
 * Two flows, same guard:
 * - `createCheckoutSession`: Stripe Checkout (`hosted_page` or `embedded_page`). Recommended.
 * - `createSubscriptionFirst`: the subscription is created first (`default_incomplete`) and the
 *   app's own Payment Element confirms its setup or payment intent.
 *
 * Both endpoints may be unauthenticated (a visitor buying before having an account).
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface CheckoutInput {
  plan?: unknown;
  interval?: unknown;
  /** The buyer's email. Ignored when `user` is set: a signed-in buyer pays for their own account. */
  email?: unknown;
  /** Signed-in buyer, if any. */
  user?: BillingUser | null;
  /** Client-generated id, so a double click creates one checkout. */
  requestId?: unknown;
}

type Guarded =
  | { ok: true; customer: Stripe.Customer | null; email: string; plan: string; interval: Interval }
  | { ok: false; result: ServiceResult };

/**
 * Refuses an email that already has a paid-for subscription, before touching the customer: the
 * endpoint is unauthenticated, so it must not let anyone who knows an email change a paying
 * customer's details. Cancels a checkout that never got a card, so a retry never leaves two
 * subscriptions behind. For an anonymous buyer an existing customer is reused but never
 * overwritten (`anonymousFill`): the email they typed is not proof they own that customer.
 */
async function guard(deps: BillingDeps, input: CheckoutInput): Promise<Guarded> {
  const plan = normalizePlanId(deps.config, input.plan);
  const interval = input.interval === undefined ? deps.config.intervals[0] : input.interval;
  if (!plan || !isInterval(deps.config, interval)) {
    return { ok: false, result: fail(400, "unknown_plan", "That plan does not exist.") };
  }
  const email = (input.user?.email ?? (typeof input.email === "string" ? input.email : "")).trim();
  if (!EMAIL.test(email)) return { ok: false, result: fail(400, "bad_email", "Enter a valid email address.") };

  const customer = await resolveCustomer(deps, { userId: input.user?.id, email });
  if (customer) {
    const subscriptions = await readSubscriptions(deps.stripe, customer.id);
    const paid = subscriptions.filter((s) => isLive(s) && isPaidFor(s));
    if (paid.length > 0) {
      deps.log.info("Checkout refused: email already has a plan", { customerId: customer.id });
      return {
        ok: false,
        result: fail(409, "already_subscribed", "This email already has a plan. Sign in to change it from Billing."),
      };
    }
    for (const abandoned of subscriptions.filter((s) => isLive(s) && isAbandonedCheckout(s))) {
      await deps.stripe.subscriptions.cancel(
        abandoned.id,
        { cancellation_details: { comment: "superseded_by_checkout" } },
        { idempotencyKey: `supersede:${abandoned.id}` },
      );
      deps.log.info("Cancelled abandoned checkout", { subscriptionId: abandoned.id });
    }
  }
  return { ok: true, customer, email, plan, interval };
}

/** The details an anonymous buyer may set on an existing customer: only fields it does not have yet. */
function anonymousFill(customer: Stripe.Customer, details: { name?: string; address?: Stripe.AddressParam }) {
  return {
    name: customer.name ? undefined : details.name,
    address: customer.address ? undefined : details.address,
  };
}

const requestKey = (input: CheckoutInput) =>
  typeof input.requestId === "string" && input.requestId ? input.requestId.slice(0, 64) : crypto.randomUUID();

function trialData(deps: BillingDeps) {
  const days = deps.config.policy.trialDays;
  if (!days) return {};
  return {
    trial_period_days: days,
    trial_settings: { end_behavior: { missing_payment_method: deps.config.policy.trialMissingPaymentMethod } },
  };
}

/**
 * Stripe Checkout. The customer is created (or reused) first so every session for an email
 * shares one customer, and any other open session for it is expired: two tabs can then never
 * both complete into two subscriptions.
 *
 * Returns a `nonce` the browser keeps in `sessionStorage` and sends back with the session id
 * after checkout; only its hash is stored on the session (see `core/checkout-proof.ts`).
 */
export async function createCheckoutSession(
  deps: BillingDeps,
  input: CheckoutInput & { uiMode?: "hosted_page" | "embedded_page" },
): Promise<ServiceResult> {
  const guarded = await guard(deps, input);
  if (!guarded.ok) return guarded.result;
  const { email, plan, interval } = guarded;
  const key = requestKey(input);
  const price = getSellingPrice(await loadCatalog(deps.stripe, deps.config, deps.mode), plan, interval);

  const existing = guarded.customer;
  const customer = existing ??
    await deps.stripe.customers.create(
      { email, metadata: input.user ? { app_user_id: input.user.id } : {} },
      { idempotencyKey: `checkout-customer:${key}` },
    );
  for await (const open of deps.stripe.checkout.sessions.list({ customer: customer.id, status: "open", limit: 100 })) {
    await deps.stripe.checkout.sessions.expire(open.id).catch((error) =>
      deps.log.info("Could not expire open session", { sessionId: open.id, message: (error as Error).message })
    );
  }

  const nonce = newCheckoutNonce();
  const uiMode = input.uiMode ?? "hosted_page";
  const returnTo = `${deps.copy.appUrl}${deps.copy.postCheckoutPath}?session_id={CHECKOUT_SESSION_ID}`;
  const tax = deps.config.policy.automaticTax;
  const session = await deps.stripe.checkout.sessions.create(
    {
      mode: "subscription",
      ui_mode: uiMode,
      metadata: { [NONCE_METADATA_KEY]: await hashCheckoutNonce(nonce) },
      customer: customer.id,
      line_items: [{ price: price.id, quantity: 1 }],
      // Collect a card even for a trial, so the trial converts without a second step.
      payment_method_collection: "always",
      subscription_data: { ...trialData(deps), metadata: { plan } },
      ...(tax
        ? {
          automatic_tax: { enabled: true },
          billing_address_collection: "required" as const,
          // Checkout writes what the buyer enters back onto the customer. Anonymous buyers may only
          // fill what an existing customer lacks.
          customer_update: {
            ...(!existing || input.user || !existing.address ? { address: "auto" as const } : {}),
            ...(!existing || input.user || !existing.name ? { name: "auto" as const } : {}),
          },
        }
        : {}),
      ...(uiMode === "hosted_page"
        ? { success_url: returnTo, cancel_url: `${deps.copy.appUrl}${input.user ? deps.copy.billingPath : "/pricing"}` }
        : { return_url: returnTo }),
    },
    // No idempotency key: a replayed request would return the first session, whose nonce hash no
    // longer matches the new nonce. Expiring other open sessions above already prevents doubles.
  );
  return ok({ url: session.url ?? null, client_secret: session.client_secret ?? null, session_id: session.id, nonce });
}

export interface SubscriptionFirstInput extends CheckoutInput {
  name?: unknown;
  /** Stripe address shape. Required when automatic tax is on. */
  address?: Stripe.AddressParam;
}

/**
 * Subscription-first checkout for the app's own Payment Element. Returns the client secret of
 * the setup intent (trial) or the first invoice's payment (no trial); the browser confirms it
 * with `stripe.confirmSetup` or `stripe.confirmPayment` and Stripe redirects back with the
 * intent id and secret, which are the post-payment proof.
 */
export async function createSubscriptionFirst(deps: BillingDeps, input: SubscriptionFirstInput): Promise<ServiceResult> {
  const guarded = await guard(deps, input);
  if (!guarded.ok) return guarded.result;
  const { email, plan, interval } = guarded;
  const tax = deps.config.policy.automaticTax;
  if (tax && !input.address?.country) return fail(400, "address_required", "Enter your billing address.");
  const key = requestKey(input);
  const price = getSellingPrice(await loadCatalog(deps.stripe, deps.config, deps.mode), plan, interval);
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 200) : undefined;

  // The guard already refused a paying customer. A signed-in, verified buyer may update their own
  // customer; an anonymous one only fills what it lacks.
  const details = { name: name || undefined, address: input.address };
  const existing = guarded.customer;
  const update = existing && (input.user ? details : anonymousFill(existing, details));
  const customer = existing
    ? update && Object.values(update).some((v) => v !== undefined)
      ? await deps.stripe.customers.update(existing.id, update)
      : existing
    : await deps.stripe.customers.create(
      { email, ...details, metadata: input.user ? { app_user_id: input.user.id } : {} },
      { idempotencyKey: `checkout-customer:${key}` },
    );

  const subscription = await deps.stripe.subscriptions.create(
    {
      customer: customer.id,
      items: [{ price: price.id }],
      payment_behavior: "default_incomplete",
      payment_settings: { save_default_payment_method: "on_subscription" },
      expand: ["latest_invoice.confirmation_secret", "pending_setup_intent"],
      metadata: { plan },
      ...trialData(deps),
      ...(tax ? { automatic_tax: { enabled: true } } : {}),
    },
    { idempotencyKey: `checkout-subscription:${key}` },
  );

  const setupIntent = subscription.pending_setup_intent as Stripe.SetupIntent | null;
  const invoice = subscription.latest_invoice as Stripe.Invoice | null;
  const clientSecret = setupIntent?.client_secret ?? invoice?.confirmation_secret?.client_secret ?? null;
  if (!clientSecret) {
    deps.log.error("No client secret on new subscription", { subscriptionId: subscription.id });
    return fail(500, "server_error", "We could not start checkout. Please try again.");
  }
  return ok({
    client_secret: clientSecret,
    intent: setupIntent?.client_secret ? "setup" : "payment",
    subscription_id: subscription.id,
    trial_end: subscription.trial_end ?? null,
  });
}
