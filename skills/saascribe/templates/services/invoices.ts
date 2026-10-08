import type { BillingDeps, BillingUser } from "../ports.ts";
import { fail, ok, type ServiceResult } from "./result.ts";
import { resolveCustomer } from "./sync.ts";

const INVOICE_LIMIT = 12;

/**
 * Recent invoices for the billing page. Read only. No customer in the active mode (comped, never
 * paid, or a customer from the other mode) is an empty list; only a Stripe failure is an error.
 */
export async function listInvoices(deps: BillingDeps, user: BillingUser): Promise<ServiceResult> {
  try {
    const customer = await resolveCustomer(deps, { userId: user.id, email: user.email });
    if (!customer) return ok({ invoices: [], hasMore: false });
    const page = await deps.stripe.invoices.list({ customer: customer.id, limit: INVOICE_LIMIT });
    return ok({
      invoices: page.data
        .filter((invoice) => invoice.status !== "draft")
        .map((invoice) => ({
          id: invoice.id,
          number: invoice.number ?? null,
          created: new Date(invoice.created * 1000).toISOString(),
          total: invoice.total,
          currency: invoice.currency,
          status: invoice.status,
          description: invoice.lines?.data?.[0]?.description ?? null,
          hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
          invoicePdf: invoice.invoice_pdf ?? null,
        })),
      hasMore: page.has_more,
    });
  } catch (error) {
    deps.log.error("Listing invoices failed", { message: (error as Error).message });
    return fail(502, "stripe_unavailable", "Could not load your invoices.");
  }
}
