import type Stripe from "stripe";
import { cancelMode } from "../core/change-rules.ts";
import { deriveState, entitledStatuses, periodOf, planOfSubscription, toIso } from "../core/subscription-state.ts";
import type { BillingDeps, BillingUser, CancellationRecord } from "../ports.ts";
import { loadCatalog } from "./catalog.ts";
import { fail, ok, type ServiceResult } from "./result.ts";
import { applyState, readFresh, readSubscriptions, resolveCustomer } from "./sync.ts";

async function releaseSchedule(deps: BillingDeps, sub: Stripe.Subscription) {
  const schedule = sub.schedule;
  if (!schedule) return;
  const status = typeof schedule === "string" ? null : schedule.status;
  if (status && status !== "active" && status !== "not_started") return;
  await deps.stripe.subscriptionSchedules.release(typeof schedule === "string" ? schedule : schedule.id);
}

/**
 * Voids what an overdue plan still owes, so cancelling never leads to a later charge. Runs after
 * the cancel: voiding the latest invoice of a live past_due subscription can move it back to active.
 */
async function voidOpenInvoices(deps: BillingDeps, subscriptionId: string) {
  try {
    for await (const invoice of deps.stripe.invoices.list({ subscription: subscriptionId, status: "open", limit: 100 })) {
      await deps.stripe.invoices.voidInvoice(invoice.id);
      deps.log.info("Voided unpaid invoice", { subscriptionId, invoiceId: invoice.id });
    }
  } catch (error) {
    // The plan is already cancelled; failing the request now would tell the customer it was not.
    deps.log.error("VOID FAILED, void the open invoice by hand", { subscriptionId, message: (error as Error).message });
  }
}

/**
 * Cancels every subscription that grants the product, so a duplicate cannot keep charging after
 * the customer asked to stop. How each one ends follows `policy.cancel` (`cancelMode`); the
 * primary subscription decides what is reported back.
 */
export async function cancelSubscription(
  deps: BillingDeps,
  user: BillingUser,
  input: { reason?: unknown; note?: unknown },
): Promise<ServiceResult> {
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim() : null;
  if (!deps.copy.cancelReasons.includes(reason)) return fail(400, "bad_reason", "Please choose a reason for cancelling.");
  if (note && note.length > 1000) return fail(400, "note_too_long", "Your note is too long.");

  const customer = await resolveCustomer(deps, { userId: user.id, email: user.email });
  if (!customer) return fail(404, "no_subscription", "We could not find a subscription to cancel.");

  const catalog = await loadCatalog(deps.stripe, deps.config, deps.mode);
  const entitled = entitledStatuses(deps.config);
  const targets = (await readSubscriptions(deps.stripe, customer.id)).filter((s) => entitled.has(s.status));
  const primary = deriveState(deps.config, catalog, customer.id, targets).primary;
  if (!primary) return fail(404, "no_subscription", "We could not find an active subscription to cancel.");

  const records: CancellationRecord[] = [];
  for (const subscription of targets) {
    // A scheduled change is dropped first: a subscription managed by a schedule must be changed
    // through it, and there is nothing left to switch to.
    await releaseSchedule(deps, subscription);
    const status = subscription.status;
    const mode = cancelMode(deps.config, status);
    if (mode === "now") {
      await deps.stripe.subscriptions.cancel(subscription.id, {
        cancellation_details: { comment: `customer:${reason}`.slice(0, 500) },
      });
      if (status === "past_due" || status === "unpaid") await voidOpenInvoices(deps, subscription.id);
    } else {
      await deps.stripe.subscriptions.update(subscription.id, { cancel_at_period_end: true });
    }
    records.push({
      userId: user.id,
      email: user.email,
      subscriptionId: subscription.id,
      plan: planOfSubscription(deps.config, catalog, subscription)?.plan ?? null,
      mode,
      reason,
      note,
      effectiveAt: mode === "now" ? new Date().toISOString() : toIso(periodOf(subscription).end) ?? new Date().toISOString(),
    });
  }

  if (deps.recordCancellation) {
    await deps.recordCancellation(records).catch((error) => deps.log.error("Could not record cancellation", { message: (error as Error).message }));
  }
  try {
    await applyState(deps, await readFresh(deps, customer.id, catalog), { email: user.email, userId: user.id });
  } catch (error) {
    // The webhook for the same change syncs the row again.
    deps.log.error("Row sync after cancel failed", { message: (error as Error).message });
  }

  const reported = records[targets.indexOf(primary)];
  return ok({ mode: reported.mode, effective_at: reported.effectiveAt });
}

/** Undoes a cancellation set to happen at period end. Only the primary subscription comes back. */
export async function resumeSubscription(deps: BillingDeps, user: BillingUser): Promise<ServiceResult> {
  const customer = await resolveCustomer(deps, { userId: user.id, email: user.email });
  if (!customer) return fail(404, "no_subscription", "We could not find a subscription to resume.");
  const catalog = await loadCatalog(deps.stripe, deps.config, deps.mode);
  const entitled = entitledStatuses(deps.config);
  // `cancel_at` covers a cancellation made in the Stripe portal under flexible billing mode.
  const cancelling = (await readSubscriptions(deps.stripe, customer.id))
    .filter((s) => entitled.has(s.status) && (s.cancel_at_period_end || s.cancel_at));
  const subscription = deriveState(deps.config, catalog, customer.id, cancelling).primary;
  if (!subscription) return fail(404, "nothing_to_resume", "There is no scheduled cancellation to undo.");

  await deps.stripe.subscriptions.update(
    subscription.id,
    subscription.cancel_at_period_end ? { cancel_at_period_end: false } : { cancel_at: "" },
  );
  try {
    await applyState(deps, await readFresh(deps, customer.id, catalog), { email: user.email, userId: user.id });
  } catch (error) {
    deps.log.error("Row sync after resume failed", { message: (error as Error).message });
  }
  return ok({ resumed: true });
}
