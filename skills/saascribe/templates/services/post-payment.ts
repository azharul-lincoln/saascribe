import type Stripe from "stripe";
import { checkIntent, type CheckoutProof, checkSession, hashCheckoutNonce, parseCheckoutProof } from "../core/checkout-proof.ts";
import type { BillingDeps } from "../ports.ts";
import { fail, ok, type ServiceResult } from "./result.ts";
import { syncCustomer } from "./sync.ts";

/**
 * The page a buyer lands on after checkout, before they have an account or a session. Both
 * endpoints are unauthenticated, so the checkout proof is the authentication, and they act only
 * on the email of the checkout's Stripe customer. An email in the URL is for display only.
 * No or bad proof is 403 `checkout_not_verified`; the page then offers sign-in and support.
 */

const NOT_VERIFIED = fail(403, "checkout_not_verified", "We could not confirm this checkout in this browser.");

const reject = (deps: BillingDeps, reason: string, id: string) => {
  // The intent or session id is not a secret; the client secret and nonce are never logged.
  deps.log.info("Checkout proof rejected", { reason, id });
  return null;
};

export async function verifyCheckoutProof(
  deps: BillingDeps,
  proof: CheckoutProof,
): Promise<{ customer: Stripe.Customer; email: string } | null> {
  const id = proof.kind === "session" ? proof.sessionId : proof.intentId;
  const maxAge = deps.config.policy.checkoutProofMaxAgeSeconds;
  const now = Math.floor(Date.now() / 1000);
  let check;
  try {
    if (proof.kind === "session") {
      const session = await deps.stripe.checkout.sessions.retrieve(proof.sessionId);
      check = checkSession(session, await hashCheckoutNonce(proof.nonce), now, maxAge);
    } else {
      const intent = proof.intentId.startsWith("seti_")
        ? await deps.stripe.setupIntents.retrieve(proof.intentId)
        : await deps.stripe.paymentIntents.retrieve(proof.intentId);
      check = checkIntent(intent, proof.clientSecret, now, maxAge);
    }
  } catch (error) {
    if ((error as { code?: string }).code === "resource_missing") return reject(deps, "not_found", id);
    throw error;
  }
  if (!check.ok) return reject(deps, check.reason, id);

  const customer = await deps.stripe.customers.retrieve(check.customerId);
  if ("deleted" in customer && customer.deleted) return reject(deps, "customer_deleted", id);
  const email = (customer as Stripe.Customer).email?.trim();
  if (!email) return reject(deps, "customer_without_email", id);
  return { customer: customer as Stripe.Customer, email };
}

/** Does the person who just paid already have an account, and does it have a password? */
export async function checkPostPaymentAccount(deps: BillingDeps, body: unknown): Promise<ServiceResult> {
  if (!deps.identity) throw new Error("checkPostPaymentAccount needs deps.identity");
  const proof = parseCheckoutProof(body);
  const checkout = proof ? await verifyCheckoutProof(deps, proof) : null;
  if (!checkout) return NOT_VERIFIED;
  const account = await deps.identity.findByEmail(checkout.email);
  return ok({ exists: !!account, hasPassword: account?.hasPassword ?? false, email: checkout.email });
}

/**
 * Starts the account for the checkout's customer email. The proof shows this browser paid; it does
 * not show the buyer owns the email they typed. So the account is created unconfirmed and without a
 * password, and a link goes to that email: opening it confirms the address and signs them in, and
 * the app asks for a password there. Someone paying with another person's email gets nothing; the
 * owner of the inbox gets the account. Until then, billing routes refuse the unverified user.
 */
export async function completePostPaymentSignup(deps: BillingDeps, body: unknown): Promise<ServiceResult> {
  if (!deps.identity) throw new Error("completePostPaymentSignup needs deps.identity");
  const proof = parseCheckoutProof(body);
  const checkout = proof ? await verifyCheckoutProof(deps, proof) : null;
  if (!checkout) return NOT_VERIFIED;

  const created = await deps.identity.createUnconfirmedUser({
    email: checkout.email,
    redirectTo: `${deps.copy.appUrl}${deps.copy.billingPath}`,
  });
  if ("exists" in created) return fail(409, "account_exists", "An account with this email already exists. Sign in instead.");

  let plan: string | null = null;
  try {
    const synced = await syncCustomer(deps, checkout.customer.id, { userId: created.userId, email: checkout.email });
    plan = synced?.state.plan ?? null;
  } catch (error) {
    // Never fail the signup over billing; the next status check or webhook links the row.
    deps.log.error("Row sync after signup failed", { message: (error as Error).message });
  }
  await deps.mailer.send({
    to: checkout.email,
    type: "confirm_email",
    dedupeKey: `confirm_email:${created.userId}`,
    userId: created.userId,
    data: { plan, confirmUrl: created.confirmUrl },
  });
  return ok({ email: checkout.email, confirmationSent: true });
}
