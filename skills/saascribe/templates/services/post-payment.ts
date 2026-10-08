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

/**
 * Sends the person who just paid a link to their account, by email. The proof shows this browser
 * paid; it does not show the buyer owns the email they typed. So nothing is handed to the browser:
 *
 * - New email: the account is created unconfirmed and without a password, and a confirm link goes
 *   to that inbox. Opening it confirms the address and signs them in; the app asks for a password
 *   there. Until then, billing routes refuse the unverified user.
 * - Existing account: a sign-in link goes to that inbox instead.
 *
 * The answer is the same either way, so the page never reveals whether an account exists. Someone
 * paying with another person's email gets nothing; the owner of the inbox gets the account.
 */
export async function completePostPaymentSignup(deps: BillingDeps, body: unknown): Promise<ServiceResult> {
  if (!deps.identity) throw new Error("completePostPaymentSignup needs deps.identity");
  const proof = parseCheckoutProof(body);
  const checkout = proof ? await verifyCheckoutProof(deps, proof) : null;
  if (!proof || !checkout) return NOT_VERIFIED;
  const proofId = proof.kind === "session" ? proof.sessionId : proof.intentId;
  const redirectTo = `${deps.copy.appUrl}${deps.copy.billingPath}`;
  const sent = ok({ email: checkout.email, linkSent: true });

  const created = await deps.identity.createUnconfirmedUser({ email: checkout.email, redirectTo });
  if ("exists" in created) {
    const url = await deps.identity.createSignInLink({ email: checkout.email, redirectTo });
    if (url) {
      await deps.mailer.send({
        to: checkout.email,
        type: "sign_in_link",
        dedupeKey: `sign_in_link:${proofId}`,
        userId: null,
        data: { url },
      });
    }
    return sent;
  }

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
    data: { plan, url: created.confirmUrl },
  });
  return sent;
}
