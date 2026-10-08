import type { AccountDetails, BillingDeps, BillingUser } from "../ports.ts";
import { fail, ok, type ServiceResult } from "./result.ts";
import { resolveCustomer } from "./sync.ts";

/**
 * Optional feature: the app's account details page saves to the app first, then mirrors the
 * change onto the Stripe customer (Stripe edits come back through `customer.updated` in the
 * webhook). A Stripe failure keeps the app's save and reports `stripeSynced: false`.
 */
export async function saveAccountDetails(deps: BillingDeps, user: BillingUser, details: AccountDetails): Promise<ServiceResult> {
  if (!deps.profiles) throw new Error("saveAccountDetails needs deps.profiles");
  const name = typeof details.name === "string" ? details.name.trim().slice(0, 200) : details.name;
  const phone = typeof details.phone === "string" ? details.phone.trim().slice(0, 40) : details.phone;
  if (name === "") return fail(400, "name_required", "Enter your name.");
  const clean: AccountDetails = { name, phone, address: details.address };
  await deps.profiles.writeDetails(user.id, clean, new Date());

  try {
    const customer = await resolveCustomer(deps, { userId: user.id, email: user.email });
    if (customer) {
      await deps.stripe.customers.update(customer.id, {
        ...(clean.name !== undefined ? { name: clean.name ?? "" } : {}),
        ...(clean.phone !== undefined ? { phone: clean.phone ?? "" } : {}),
        ...(clean.address ? { address: { ...clean.address } as Record<string, string> } : {}),
      });
    }
    return ok({ saved: true, stripeSynced: true });
  } catch (error) {
    deps.log.error("Mirroring account details to Stripe failed", { message: (error as Error).message });
    return ok({ saved: true, stripeSynced: false });
  }
}
