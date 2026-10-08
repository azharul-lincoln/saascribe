import type Stripe from "stripe";
import { planRank } from "../core/config.ts";
import { planOfPrice } from "../core/plan-catalog.ts";
import { hasConfirmedPayment, isLive, periodOf, planOfSubscription, toIso } from "../core/subscription-state.ts";
import type { AccountDetails, BillingDeps, ModeSource, StripeMode } from "../ports.ts";
import { loadCatalog } from "./catalog.ts";
import { restoreHeldChange } from "./change-plan.ts";
import { fail, ok, type ServiceResult } from "./result.ts";
import { syncCustomer } from "./sync.ts";

/**
 * The Stripe webhook. Rules:
 *
 * - The signature is always checked, against each mode's signing secret; there is no unsigned path.
 * - Only the mode the app runs in may write rows or send email. The other mode's events are
 *   acknowledged with 200 and dropped, so switching modes needs no cleanup in Stripe. When the
 *   active mode cannot be read the delivery fails (500) and Stripe retries, instead of a guess
 *   dropping a real event.
 * - The payload is used for ids and `previous_attributes` only. Objects are re-read with our
 *   client, because a payload follows the endpoint's API version, not ours.
 * - Rows are recomputed from all of the customer's subscriptions (`syncCustomer`), so order,
 *   replays and duplicates do not matter. A throw returns 500 and Stripe redelivers.
 * - Every email has a dedupe key, so a redelivery never sends twice.
 */

/** Every event this handler acts on. The settings check compares endpoints against this list. */
export const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.pending_update_applied",
  "customer.subscription.pending_update_expired",
  "invoice.paid",
  "invoice.payment_failed",
  "customer.updated",
] as const;

/** Cancellations made by our own code, not by the customer. They get no "cancelled" email. */
export const SILENT_CANCELLATION_COMMENTS = new Set(["superseded_by_checkout", "duplicate_cleanup"]);

export type WebhookDeps = Omit<BillingDeps, "stripe" | "mode"> & {
  modes: ModeSource;
  makeStripe: (secretKey: string) => Stripe;
  /** Needed on runtimes without Node crypto (Deno, edge): `Stripe.createSubtleCryptoProvider()`. */
  cryptoProvider?: Stripe.CryptoProvider;
};

const idOf = (value: string | { id: string } | null | undefined) => (!value ? null : typeof value === "string" ? value : value.id);

/** The subscription an invoice bills for (`invoice.subscription` moved under `parent` in basil). */
export function subscriptionIdOfInvoice(invoice: Pick<Stripe.Invoice, "parent">): string | null {
  const parent = invoice.parent;
  if (!parent || parent.type !== "subscription_details") return null;
  return idOf(parent.subscription_details?.subscription as string | { id: string } | null | undefined);
}

export async function handleWebhook(deps: WebhookDeps, rawBody: string, signature: string | null): Promise<ServiceResult> {
  if (!signature) return fail(400, "missing_signature", "Missing stripe-signature header");

  let event: Stripe.Event | null = null;
  let mode: StripeMode | null = null;
  let stripe: Stripe | null = null;
  for (const candidate of ["live", "test"] as StripeMode[]) {
    const credentials = deps.modes.credentials(candidate);
    if (!credentials.secretKey || !credentials.webhookSecret) continue;
    const client = deps.makeStripe(credentials.secretKey);
    try {
      event = await client.webhooks.constructEventAsync(rawBody, signature, credentials.webhookSecret, undefined, deps.cryptoProvider);
      mode = candidate;
      stripe = client;
      break;
    } catch {
      // Try the other mode's secret.
    }
  }
  if (!event || !mode || !stripe) return fail(400, "invalid_signature", "Invalid signature");
  if (event.livemode !== (mode === "live")) {
    deps.log.error("Event livemode does not match the secret that verified it", { eventId: event.id, mode });
    return fail(400, "mode_mismatch", "Event mode does not match its signing secret");
  }

  let active: StripeMode;
  try {
    active = await deps.modes.activeMode();
  } catch (error) {
    deps.log.error("Active mode unreadable; failing the delivery so Stripe retries", { eventId: event.id, message: (error as Error).message });
    return fail(500, "mode_unreadable", "Active Stripe mode could not be read");
  }
  if (mode !== active) {
    deps.log.info("Ignoring event from the inactive mode", { eventId: event.id, type: event.type, mode, active });
    return ok({ received: true, ignored: `${mode}_mode` });
  }

  const full: BillingDeps = { ...deps, stripe, mode };
  try {
    await dispatch(full, event);
  } catch (error) {
    deps.log.error("Webhook processing failed", { eventId: event.id, type: event.type, message: (error as Error).message });
    return fail(500, "processing_failed", "Webhook processing failed");
  }
  return ok({ received: true });
}

async function dispatch(deps: BillingDeps, event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const customerId = idOf((event.data.object as Stripe.Checkout.Session).customer as string | null);
      if (customerId) await syncCustomer(deps, customerId);
      return;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return onSubscriptionEvent(deps, event);
    case "customer.subscription.pending_update_applied":
    case "customer.subscription.pending_update_expired":
      return onPendingUpdateSettled(deps, event);
    case "invoice.paid":
      return onInvoicePaid(deps, event);
    case "invoice.payment_failed":
      return onInvoiceFailed(deps, event);
    case "customer.updated":
      return onCustomerUpdated(deps, event);
    default:
      deps.log.info("Unhandled event type", { type: event.type });
  }
}

/**
 * A charge-now plan change that waited on payment (3D Secure, a retried card) has settled. Paid:
 * the change stands, so a downgrade it replaced is dropped for good. Expired (~23 hours unpaid;
 * Stripe has voided the invoice): the downgrade is put back. The browser's `abandon_payment`
 * usually got there first; the store hands the held change to only one of them.
 */
async function onPendingUpdateSettled(deps: BillingDeps, event: Stripe.Event): Promise<void> {
  const payload = event.data.object as Stripe.Subscription;
  const customerId = idOf(payload.customer as string | { id: string });
  if (!customerId) return;
  if (event.type === "customer.subscription.pending_update_expired") {
    await restoreHeldChange(deps, customerId, payload.id, `pending-expired:${event.id}`);
  } else {
    await deps.store.takeHeldChange(customerId);
  }
  await syncCustomer(deps, customerId);
}

async function onSubscriptionEvent(deps: BillingDeps, event: Stripe.Event): Promise<void> {
  const payload = event.data.object as Stripe.Subscription;
  const customerId = idOf(payload.customer as string | { id: string });
  if (!customerId) return;
  const synced = await syncCustomer(deps, customerId);
  if (!synced) return;
  const { state, email, userId } = synced;
  const subscription = await deps.stripe.subscriptions.retrieve(payload.id);
  // The plan this event is about: a later change may already be live, so the payload decides.
  const plans = await loadCatalog(deps.stripe, deps.config, deps.mode);
  const eventPlan = planOfSubscription(deps.config, plans, payload);
  const previousAttributes = (event.data as { previous_attributes?: Partial<Stripe.Subscription> }).previous_attributes;

  // "Your plan is active" goes out once, when a card first stands behind the subscription.
  // Comparing with previous_attributes catches that moment; a trial ending or a recovered payment
  // does not send it again, and a checkout abandoned before the card step never gets it.
  const previous = event.type === "customer.subscription.updated"
    ? { ...payload, ...(previousAttributes ?? {}) } as Stripe.Subscription
    : null;
  if (event.type !== "customer.subscription.deleted" && hasConfirmedPayment(payload) && !(previous && hasConfirmedPayment(previous))) {
    await deps.mailer.send({
      to: email,
      type: "subscription_confirmed",
      dedupeKey: `subscription_confirmed:${subscription.id}`,
      userId,
      data: {
        plan: eventPlan,
        trialEnd: toIso(subscription.trial_end),
        firstChargeAt: toIso(subscription.trial_end) ?? toIso(periodOf(subscription).end),
      },
    });
  }

  // A price change on a live subscription: a change made now, a trial switch, or a scheduled
  // change reaching its date. `previous_attributes.items` is present only when items changed.
  const previousItems = (previousAttributes as { items?: Stripe.ApiList<Stripe.SubscriptionItem> } | undefined)?.items;
  if (event.type === "customer.subscription.updated" && isLive(subscription) && previousItems && eventPlan) {
    const fromPlan = planOfPrice(deps.config, plans, previousItems.data?.[0]?.price);
    if (fromPlan && (fromPlan.plan !== eventPlan.plan || fromPlan.interval !== eventPlan.interval)) {
      const onTrial = subscription.status === "trialing";
      const up = planRank(deps.config, eventPlan.plan) > planRank(deps.config, fromPlan.plan) ||
        (eventPlan.plan === fromPlan.plan && eventPlan.interval === "year");
      await deps.mailer.send({
        to: email,
        type: "plan_changed",
        dedupeKey: `plan_changed:${event.id}`,
        userId,
        data: {
          kind: up ? "upgraded" : "downgraded",
          from: fromPlan,
          to: eventPlan,
          onTrial,
          trialEnd: onTrial ? toIso(subscription.trial_end) : null,
          nextChargeAt: toIso(periodOf(subscription).end),
        },
      });
    }
  }

  if (event.type === "customer.subscription.deleted") {
    // Tell the customer only when their account actually stopped: not when a duplicate or an
    // abandoned checkout went away while another plan keeps running, and not for a checkout that
    // never got a card.
    const comment = subscription.cancellation_details?.comment ?? "";
    const hadPaymentMethod = !!(subscription.default_payment_method || subscription.default_source);
    if (!state.entitled && hadPaymentMethod && !SILENT_CANCELLATION_COMMENTS.has(comment)) {
      await deps.mailer.send({
        to: email,
        type: "subscription_cancelled",
        dedupeKey: `subscription_cancelled:${event.id}`,
        userId,
        data: { accessEnds: toIso(subscription.ended_at ?? periodOf(subscription).end) },
      });
    }
  }
}

async function onInvoicePaid(deps: BillingDeps, event: Stripe.Event): Promise<void> {
  const invoice = await deps.stripe.invoices.retrieve((event.data.object as Stripe.Invoice).id!);
  const customerId = idOf(invoice.customer as string | null);
  if (!customerId || !subscriptionIdOfInvoice(invoice)) return;
  const synced = await syncCustomer(deps, customerId);
  // The $0 invoice that opens a free trial is not a payment worth a receipt.
  if (!synced || (invoice.amount_paid ?? 0) <= 0) return;
  await deps.mailer.send({
    to: synced.email,
    type: "payment_receipt",
    dedupeKey: `payment_receipt:${invoice.id}`,
    userId: synced.userId,
    data: {
      amount: invoice.amount_paid,
      currency: invoice.currency,
      invoiceNumber: invoice.number ?? null,
      invoiceUrl: invoice.hosted_invoice_url ?? null,
      periodStart: toIso(invoice.period_start),
      periodEnd: toIso(invoice.period_end),
    },
  });
}

async function onInvoiceFailed(deps: BillingDeps, event: Stripe.Event): Promise<void> {
  const invoice = await deps.stripe.invoices.retrieve((event.data.object as Stripe.Invoice).id!);
  const customerId = idOf(invoice.customer as string | null);
  const subscriptionId = subscriptionIdOfInvoice(invoice);
  if (!customerId || !subscriptionId) return;

  // An in-app plan change charges through a pending update: a bank asking for 3D Secure also
  // raises this event, and a decline is voided by change-plan with the plan left as it was. The
  // plan dialog reports both, so this email would only be wrong there.
  const subscription = await deps.stripe.subscriptions.retrieve(subscriptionId);
  if (invoice.status === "void" || invoice.status === "paid" || subscription.pending_update) {
    deps.log.info("payment_failed email skipped for a plan-change charge", { invoiceId: invoice.id, status: invoice.status });
    return;
  }

  const synced = await syncCustomer(deps, customerId);
  if (!synced) return;
  await deps.mailer.send({
    to: synced.email,
    type: "payment_failed",
    dedupeKey: `payment_failed:${event.id}`,
    userId: synced.userId,
    data: {
      amount: invoice.amount_due,
      currency: invoice.currency,
      nextRetryAt: toIso(invoice.next_payment_attempt),
      invoiceUrl: invoice.hosted_invoice_url ?? null,
    },
  });
}

/**
 * Account details edited in the Stripe portal (optional feature). Copies only the fields this
 * event changed, so an unrelated update (invoice settings, metadata) never replaces the app's
 * name with the name on the card, and skips an event older than the app's own last save.
 */
async function onCustomerUpdated(deps: BillingDeps, event: Stripe.Event): Promise<void> {
  if (!deps.profiles) return;
  const customer = event.data.object as Stripe.Customer;
  const changed = Object.keys((event.data as { previous_attributes?: object }).previous_attributes ?? {});
  const details: AccountDetails = {};
  if (changed.includes("name")) details.name = customer.name ?? null;
  if (changed.includes("phone")) details.phone = customer.phone ?? null;
  if (changed.includes("address")) details.address = customer.address ?? null;
  if (Object.keys(details).length === 0) return;

  const row = await deps.store.find({ customerId: customer.id });
  if (!row?.userId) return;
  const eventAt = new Date(event.created * 1000);
  const savedAt = await deps.profiles.detailsUpdatedAt(row.userId);
  if (savedAt && savedAt > eventAt) {
    deps.log.info("Skipping stale customer.updated", { userId: row.userId });
    return;
  }
  await deps.profiles.writeDetails(row.userId, details, eventAt);
}
