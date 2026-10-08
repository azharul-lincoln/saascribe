import type Stripe from "stripe";
import { catalogKey, type PlanCatalog } from "../core/plan-catalog.ts";
import {
  deriveState,
  isAbandonedCheckout,
  isLive,
  isPaidFor,
  periodOf,
  planOfSubscription,
  type SubscriptionState,
  toIso,
} from "../core/subscription-state.ts";
import type { BillingDeps } from "../ports.ts";
import { loadCatalog } from "./catalog.ts";
import { ok, type ServiceResult } from "./result.ts";
import { STRIPE_API_VERSION } from "./stripe-client.ts";
import { WEBHOOK_EVENTS } from "./webhook.ts";

/**
 * Read-only billing audit for the active mode. Writes nothing, cancels nothing; cleanup is a
 * human decision made in the Stripe Dashboard. Admin only.
 *
 * Reports: customers with more than one live subscription, emails with more than one Stripe
 * customer, rows that disagree with Stripe, rows with no customer in this mode, the plan catalog,
 * live trials with the evidence behind `isPaidFor`, and the dashboard settings the flows rely on.
 * Note: Stripe leaves test-clock subscriptions out of an unfiltered list.
 */

function describeSubscription(deps: BillingDeps, catalog: PlanCatalog, sub: Stripe.Subscription) {
  const setupIntent = sub.pending_setup_intent;
  return {
    id: sub.id,
    status: sub.status,
    plan: planOfSubscription(deps.config, catalog, sub),
    priceId: sub.items?.data?.[0]?.price?.id ?? null,
    itemCount: sub.items?.data?.length ?? 0,
    created: toIso(sub.created),
    currentPeriodEnd: toIso(periodOf(sub).end),
    trialEnd: toIso(sub.trial_end),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    cancelAt: toIso(sub.cancel_at),
    billingMode: sub.billing_mode?.type ?? null,
    paidFor: isPaidFor(sub),
    abandonedCheckout: isAbandonedCheckout(sub),
    hasPaymentMethod: !!(sub.default_payment_method || sub.default_source),
    pendingSetupIntent: !setupIntent ? null : typeof setupIntent === "string" ? "unexpanded" : setupIntent.status,
    hasPendingUpdate: !!sub.pending_update,
  };
}

/**
 * The dashboard settings the flows depend on, read back so they can be checked without opening
 * Stripe: the default portal configuration must not switch plans or cancel, and every webhook
 * endpoint posting to `webhookPath` must send each handled event on our API version. The
 * failed-payment retry setting has no API and is listed as a manual check.
 */
export async function checkStripeSettings(stripe: Stripe, webhookPath: string) {
  const problems: string[] = [];
  const manualChecks = [
    "Billing > Revenue recovery > Retries: 'If all retries fail' must cancel the subscription or mark it unpaid, never leave it past due.",
    "Settings > Emails: decide which customer emails Stripe sends (receipts, failed payments) so they do not duplicate the app's own.",
  ];

  let portal: unknown = null;
  try {
    const configurations = await stripe.billingPortal.configurations.list({ limit: 100 });
    const configs = configurations.data.map((c) => ({
      id: c.id,
      isDefault: c.is_default,
      active: c.active,
      switchPlans: c.features.subscription_update.enabled,
      cancel: c.features.subscription_cancel.enabled,
      updateCard: c.features.payment_method_update.enabled,
      invoiceHistory: c.features.invoice_history.enabled,
    }));
    const byDefault = configs.find((c) => c.isDefault && c.active);
    if (!byDefault) problems.push("No active default customer portal configuration");
    else {
      if (byDefault.switchPlans) problems.push("Customer portal lets customers switch plans");
      if (byDefault.cancel) problems.push("Customer portal lets customers cancel");
      if (!byDefault.updateCard) problems.push("Customer portal does not let customers update their card");
      if (!byDefault.invoiceHistory) problems.push("Customer portal hides invoice history");
    }
    portal = configs;
  } catch (error) {
    problems.push(`Could not read the customer portal configuration: ${(error as Error).message}`);
  }

  let webhooks: unknown = null;
  try {
    const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
    const ours = endpoints.data.filter((e) => e.url.includes(webhookPath));
    if (ours.length === 0) problems.push(`No webhook endpoint posts to ${webhookPath}`);
    webhooks = ours.map((e) => {
      const all = e.enabled_events.includes("*");
      const missingEvents = all ? [] : WEBHOOK_EVENTS.filter((name) => !e.enabled_events.includes(name));
      if (e.status !== "enabled") problems.push(`Webhook endpoint ${e.id} is ${e.status}`);
      if (missingEvents.length) problems.push(`Webhook endpoint ${e.id} does not send ${missingEvents.join(", ")}`);
      if (e.api_version && e.api_version !== STRIPE_API_VERSION) {
        problems.push(`Webhook endpoint ${e.id} sends ${e.api_version} payloads; the code runs ${STRIPE_API_VERSION} (works, since objects are re-read, but create a new endpoint when convenient)`);
      }
      return { id: e.id, url: e.url, status: e.status, apiVersion: e.api_version, missingEvents };
    });
  } catch (error) {
    problems.push(`Could not read the webhook endpoints: ${(error as Error).message}`);
  }
  return { problems, manualChecks, portal, webhooks };
}

export async function auditBilling(deps: BillingDeps, input: { webhookPath: string; email?: string }): Promise<ServiceResult> {
  const catalog = await loadCatalog(deps.stripe, deps.config, deps.mode, { fresh: true });

  const customers = new Map<string, { id: string; email: string | null; subs: Stripe.Subscription[]; state?: SubscriptionState }>();
  for await (
    const sub of deps.stripe.subscriptions.list({
      status: "all",
      limit: 100,
      expand: ["data.schedule", "data.pending_setup_intent", "data.customer"],
    })
  ) {
    const customer = sub.customer;
    const id = typeof customer === "string" ? customer : customer.id;
    const email = typeof customer === "object" && !("deleted" in customer && customer.deleted) ? (customer as Stripe.Customer).email : null;
    if (input.email && email?.toLowerCase() !== input.email.trim().toLowerCase()) continue;
    const entry = customers.get(id) ?? { id, email, subs: [] };
    entry.subs.push(sub);
    customers.set(id, entry);
  }
  for (const entry of customers.values()) entry.state = deriveState(deps.config, catalog, entry.id, entry.subs);

  const multipleLiveSubscriptions = [...customers.values()]
    .filter((c) => c.state!.liveCount > 1)
    .map((c) => ({
      customerId: c.id,
      email: c.email,
      paidLiveCount: c.state!.paidLiveCount,
      subscriptions: c.subs.filter(isLive).map((s) => describeSubscription(deps, catalog, s)),
    }));

  const customersByEmail = new Map<string, string[]>();
  for (const c of customers.values()) {
    if (c.email) customersByEmail.set(c.email.toLowerCase(), [...(customersByEmail.get(c.email.toLowerCase()) ?? []), c.id]);
  }
  const emailsWithMultipleCustomers = [...customersByEmail].filter(([, ids]) => ids.length > 1).map(([email, ids]) => ({ email, customerIds: ids }));

  const rows = (await deps.store.listAll()).filter((r) => !input.email || r.email.toLowerCase() === input.email.trim().toLowerCase());
  const rowMismatches: unknown[] = [];
  const rowsNotInMode: unknown[] = [];
  for (const row of rows) {
    const entry = (row.stripeCustomerId && customers.get(row.stripeCustomerId)) || customers.get(customersByEmail.get(row.email.toLowerCase())?.[0] ?? "");
    if (!entry) {
      rowsNotInMode.push({ email: row.email, stripeCustomerId: row.stripeCustomerId, plan: row.plan, entitled: row.entitled });
      continue;
    }
    const state = entry.state!;
    const planDiffers = !!state.plan && (state.plan !== row.plan || state.interval !== row.interval);
    if (!planDiffers && row.entitled === state.entitled && row.stripeCustomerId === entry.id) continue;
    rowMismatches.push({
      email: row.email,
      userId: row.userId,
      row: { plan: row.plan, interval: row.interval, entitled: row.entitled, stripeCustomerId: row.stripeCustomerId },
      stripe: { plan: state.plan, interval: state.interval, entitled: state.entitled, status: state.status, customerId: entry.id },
    });
  }

  const liveTrials = [...customers.values()].flatMap((c) =>
    c.subs.filter((s) => s.status === "trialing").map((s) => ({ email: c.email, ...describeSubscription(deps, catalog, s) }))
  );

  const catalogReport = Object.fromEntries(
    deps.config.plans.flatMap((plan) =>
      deps.config.intervals.map((interval) => {
        const key = catalogKey(plan.id, interval);
        const sellable = catalog.sellablePriceIds.get(key) ?? [];
        const price = catalog.sellingPrice.get(key);
        return [key, {
          sellingPriceId: price?.id ?? null,
          amount: price?.unit_amount ?? null,
          sellablePriceCount: sellable.length,
          problem: sellable.length === 0 ? "no active price" : sellable.length > 1 ? "more than one active price" : null,
        }];
      })
    ),
  );

  const settings = await checkStripeSettings(deps.stripe, input.webhookPath);
  return ok({
    mode: deps.mode,
    generatedAt: new Date().toISOString(),
    counts: {
      customersWithSubscriptions: customers.size,
      rows: rows.length,
      multipleLiveSubscriptions: multipleLiveSubscriptions.length,
      emailsWithMultipleCustomers: emailsWithMultipleCustomers.length,
      rowMismatches: rowMismatches.length,
      rowsNotInMode: rowsNotInMode.length,
      liveTrials: liveTrials.length,
      catalogProblems: Object.values(catalogReport).filter((c) => c.problem).length,
      settingsProblems: settings.problems.length,
    },
    catalog: catalogReport,
    stripeSettings: settings,
    multipleLiveSubscriptions,
    emailsWithMultipleCustomers,
    rowMismatches,
    rowsNotInMode,
    liveTrials,
  });
}
