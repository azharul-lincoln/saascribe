import type { BillingDeps, BillingUser } from "../ports.ts";
import { fail, ok, type ServiceResult } from "./result.ts";
import { resolveCustomer } from "./sync.ts";

/**
 * A Stripe customer portal session for cards, invoices and billing details. Plan switching and
 * cancelling must be OFF in the portal configuration: the in-app flows own both, and the portal
 * cannot schedule a period-end downgrade between plans that are different products.
 * `scripts/check-stripe-settings.ts` verifies the configuration.
 */
export async function createPortalSession(deps: BillingDeps, user: BillingUser): Promise<ServiceResult> {
  const customer = await resolveCustomer(deps, { userId: user.id, email: user.email });
  if (!customer) return fail(404, "no_customer", "No billing account found. Contact support if you believe this is wrong.");
  const session = await deps.stripe.billingPortal.sessions.create({
    customer: customer.id,
    // The return URL is fixed server-side, never taken from the request.
    return_url: `${deps.copy.appUrl}${deps.copy.billingPath}`,
  });
  return ok({ url: session.url });
}
