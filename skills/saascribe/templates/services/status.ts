import type { BillingDeps, BillingUser } from "../ports.ts";
import { ok, type ServiceResult } from "./result.ts";
import { applyState, describeState, readFresh, resolveCustomer } from "./sync.ts";

/**
 * The billing page's read: re-derives the account's state from Stripe and saves it through the
 * single writer, so a page load and a webhook can never disagree.
 *
 * A Stripe failure must never look like "no plan": the answer then comes from the stored row
 * with `stale: true`, and nothing is written, so an outage cannot downgrade a paying customer.
 */
export async function getBillingStatus(deps: BillingDeps, user: BillingUser): Promise<ServiceResult> {
  try {
    const customer = await resolveCustomer(deps, { userId: user.id, email: user.email });
    if (!customer) return ok({ stale: false, subscription: null });
    const fresh = await readFresh(deps, customer.id);
    await applyState(deps, fresh, { email: user.email, userId: user.id }).catch((error) =>
      deps.log.error("Row sync on status check failed", { message: (error as Error).message })
    );
    return ok({ stale: false, subscription: describeState(fresh.state) });
  } catch (error) {
    deps.log.error("Stripe unreachable on status check; answering from the stored row", { message: (error as Error).message });
    const row = await deps.store.find({ userId: user.id, email: user.email });
    return ok({
      stale: true,
      subscription: row ? { entitled: row.entitled, plan: row.plan, interval: row.interval } : null,
    });
  }
}
