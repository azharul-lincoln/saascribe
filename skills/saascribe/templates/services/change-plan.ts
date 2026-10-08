import type Stripe from "stripe";
import { changeStep, classifyChange, isProrationDateUsable } from "../core/change-rules.ts";
import { getSellingPrice, type PlanCatalog } from "../core/plan-catalog.ts";
import { isLive, nowSeconds, type SubscriptionPlan, type SubscriptionState, toIso } from "../core/subscription-state.ts";
import type { BillingDeps, BillingUser, EmailMessage } from "../ports.ts";
import { loadCatalog } from "./catalog.ts";
import { fail, ok, type ServiceResult } from "./result.ts";
import { applyState, describeState, readFresh, readState, resolveCustomer } from "./sync.ts";

/**
 * In-app plan changes on the customer's one subscription. Never creates a subscription.
 * The account comes from the session (`user`); nothing in the body identifies it.
 *
 * Actions:
 * - `preview` { plan, interval? }: what the change means, amounts in minor units. A charge-now
 *   change returns `proration_date`, which `apply` must send back so the charge matches.
 * - `apply` { plan, interval?, requestId, prorationDate? }: makes the change. May answer
 *   `requires_action` with a `client_secret` for `stripe.handleNextAction`, then the browser calls `sync`.
 * - `cancel_scheduled_change` { requestId }: keeps the current plan.
 * - `sync`: re-reads Stripe and returns the state (after 3D Secure).
 * - `abandon_payment` { requestId }: the customer closed or failed the 3D Secure step. Voids the
 *   open charge and puts back a downgrade the change had replaced, so nothing waits ~23 hours.
 */

const MESSAGES: Record<string, string> = {
  // "support" is replaced with the app's support address.
  unknown_plan: "That plan does not exist.",
  no_subscription: "We could not find a plan on this account. Choose a plan to start one.",
  multiple_subscriptions: "Your account has more than one active plan. Contact support and we will sort it out first.",
  past_due: "Your last payment did not go through. Update your card first, then change your plan.",
  not_active: "Your plan is not active right now, so it cannot be changed.",
  cancel_scheduled: "Your plan is set to end. Keep your plan first, then change it.",
  unsupported_subscription: "This plan cannot be changed online. Contact support.",
  same_plan: "You are already on this plan.",
  already_scheduled: "This change is already scheduled.",
  preview_expired: "The price shown is out of date. Review the change again.",
  payment_failed: "Your card was declined, so your plan has not changed. Update your card and try again.",
  no_scheduled_change: "There is no scheduled change to cancel.",
  bad_request: "Something was missing from the request. Please try again.",
};

const refuse = (deps: BillingDeps, code: string, status = 409) =>
  fail(status, code, (MESSAGES[code] ?? MESSAGES.bad_request).replace("Contact support", `Contact ${deps.copy.supportEmail}`));

const idOf = (value: string | { id: string } | null | undefined) => (!value ? undefined : typeof value === "string" ? value : value.id);

function activeScheduleId(sub: Stripe.Subscription): string | null {
  const schedule = sub.schedule;
  if (!schedule) return null;
  if (typeof schedule === "string") return schedule;
  return schedule.status === "active" || schedule.status === "not_started" ? schedule.id : null;
}

async function releaseSchedule(deps: BillingDeps, sub: Stripe.Subscription): Promise<boolean> {
  const scheduleId = activeScheduleId(sub);
  if (!scheduleId) return false;
  await deps.stripe.subscriptionSchedules.release(scheduleId);
  deps.log.info("Released schedule", { subscriptionId: sub.id, scheduleId });
  return true;
}

/**
 * Keeps the current price until the period ends, then moves to `targetPrice` for good.
 * `from_subscription` must be sent alone, then every phase is sent in full: Stripe unsets what an
 * update leaves out, the payment method in particular, or the first renewal on the new plan would
 * have no card. `duration` replaced `iterations` in 2025-09-30.clover.
 */
async function scheduleChange(
  deps: BillingDeps,
  sub: Stripe.Subscription,
  targetPrice: Stripe.Price,
  target: SubscriptionPlan,
  idempotencyKey: string,
): Promise<{ scheduleId: string; effectiveAt: number }> {
  const existing = activeScheduleId(sub);
  const schedule = existing
    ? await deps.stripe.subscriptionSchedules.retrieve(existing)
    : await deps.stripe.subscriptionSchedules.create({ from_subscription: sub.id }, { idempotencyKey: `${idempotencyKey}:create` });

  const now = nowSeconds();
  const current = schedule.phases.find((p) => p.start_date <= now && p.end_date > now) ?? schedule.phases[0];
  const paymentMethod = idOf(sub.default_payment_method as string | { id: string } | null);
  const tax = deps.config.policy.automaticTax ? { automatic_tax: { enabled: true } } : {};
  // Coupons and promotion codes carry over to both phases; dropping them here would end a
  // customer's discount as a side effect of scheduling a downgrade.
  const discounts = (current.discounts ?? []).map((d) => ({
    coupon: idOf(d.coupon as string | { id: string } | null),
    discount: idOf(d.discount as string | { id: string } | null),
    promotion_code: idOf(d.promotion_code as string | { id: string } | null),
  }));
  const quantity = sub.items.data[0].quantity ?? 1;

  await deps.stripe.subscriptionSchedules.update(
    schedule.id,
    {
      end_behavior: "release",
      proration_behavior: "none",
      phases: [
        {
          items: [{ price: sub.items.data[0].price.id, quantity }],
          start_date: current.start_date,
          end_date: current.end_date,
          default_payment_method: paymentMethod,
          metadata: sub.metadata ?? {},
          proration_behavior: "none",
          discounts,
          ...tax,
        },
        {
          items: [{ price: targetPrice.id, quantity }],
          duration: { interval: target.interval, interval_count: 1 },
          default_payment_method: paymentMethod,
          metadata: { ...(sub.metadata ?? {}), plan: target.plan },
          proration_behavior: "none",
          discounts,
          ...tax,
        },
      ],
    },
    { idempotencyKey: `${idempotencyKey}:update` },
  );
  return { scheduleId: schedule.id, effectiveAt: current.end_date };
}

/**
 * Puts back the change held when a charge-now change released it (see `HeldChange`). While a charge
 * is still pending the hold is left for later. Otherwise it is taken from the store atomically, so
 * the browser and the webhook can both call this and only one restores it, and dropped if the
 * subscription moved on in the meantime (ended, set to cancel, or a new schedule).
 */
export async function restoreHeldChange(
  deps: BillingDeps,
  customerId: string,
  subscriptionId: string,
  idempotencyKey: string,
): Promise<boolean> {
  const sub = await deps.stripe.subscriptions.retrieve(subscriptionId);
  if (sub.pending_update) return false;
  const held = await deps.store.takeHeldChange(customerId);
  if (!held || held.subscriptionId !== subscriptionId) return false;
  if (!isLive(sub) || activeScheduleId(sub) || sub.cancel_at_period_end || sub.cancel_at) {
    deps.log.info("Held change not restored; the subscription has moved on", { subscriptionId, plan: held.plan });
    return false;
  }
  const catalog = await loadCatalog(deps.stripe, deps.config, deps.mode);
  await scheduleChange(deps, sub, getSellingPrice(catalog, held.plan, held.interval), held, idempotencyKey);
  deps.log.info("Restored the scheduled change a failed charge had replaced", { subscriptionId, plan: held.plan });
  return true;
}

/** Whether an invoice line is a proration (moved under `parent` in 2025-03-31.basil). */
function isProration(line: Stripe.InvoiceLineItem): boolean {
  const parent = line.parent;
  if (!parent) return false;
  return parent.subscription_item_details?.proration === true || parent.invoice_item_details?.proration === true;
}

/**
 * What the customer pays now for a charge-now change. With an anchor reset the whole invoice is
 * due now. Otherwise a preview can also hold the next renewal, so only proration lines count,
 * unless the invoice is nothing but prorations, where `amount_due` also reflects tax and any
 * credit balance.
 */
export function amountDueNow(invoice: Pick<Stripe.Invoice, "amount_due" | "lines">, anchorReset: boolean): number {
  if (anchorReset) return Math.max(0, invoice.amount_due);
  const lines = invoice.lines?.data ?? [];
  const onlyProrations = lines.length > 0 && lines.every(isProration);
  const prorationTotal = lines.filter(isProration).reduce((sum, line) => sum + line.amount, 0);
  return Math.max(0, onlyProrations ? invoice.amount_due : prorationTotal);
}

/** Retrieves the PaymentIntent behind an invoice (`invoice.payment_intent` is gone since basil). */
async function paymentIntentOf(deps: BillingDeps, invoice: Stripe.Invoice | null): Promise<Stripe.PaymentIntent | null> {
  if (!invoice?.id) return null;
  const payments = invoice.payments?.data ?? (await deps.stripe.invoices.retrieve(invoice.id, { expand: ["payments"] })).payments?.data ?? [];
  const intent = payments.find((p) => p.payment?.type === "payment_intent")?.payment?.payment_intent;
  if (!intent) return null;
  return typeof intent === "string" ? await deps.stripe.paymentIntents.retrieve(intent) : intent;
}

export interface ChangePlanInput {
  action?: unknown;
  plan?: unknown;
  interval?: unknown;
  requestId?: unknown;
  prorationDate?: unknown;
}

export async function changePlan(deps: BillingDeps, user: BillingUser, input: ChangePlanInput): Promise<ServiceResult> {
  const action = input.action;
  const requestId = typeof input.requestId === "string" ? input.requestId.slice(0, 64) : "";
  const actions = ["preview", "apply", "cancel_scheduled_change", "sync", "abandon_payment"];
  if (typeof action !== "string" || !actions.includes(action)) return refuse(deps, "bad_request", 400);
  if (action !== "preview" && action !== "sync" && !requestId) return refuse(deps, "bad_request", 400);

  const customer = await resolveCustomer(deps, { userId: user.id, email: user.email });
  if (!customer) return refuse(deps, "no_subscription", 404);
  const catalog: PlanCatalog = await loadCatalog(deps.stripe, deps.config, deps.mode);
  const finish = async (status: string, extra: Record<string, unknown> = {}) => {
    const fresh = await readFresh(deps, customer.id, catalog);
    await applyState(deps, fresh, { email: user.email, userId: user.id });
    return ok({ status, ...extra, subscription: describeState(fresh.state) });
  };

  const state: SubscriptionState = await readState(deps, customer.id, catalog);
  const keyBase = `change-plan:${user.id}:${requestId}`;
  if (action === "sync") {
    // After 3D Secure succeeds the charge is paid and the change applied; the held change is replaced for good.
    if (state.primary && !state.primary.pending_update) await deps.store.takeHeldChange(customer.id);
    return finish("ok");
  }

  if (action === "abandon_payment") {
    const primary = state.primary;
    if (!primary?.pending_update) {
      // Paid after all (or nothing was pending): the change stands.
      await deps.store.takeHeldChange(customer.id);
      return finish("ok");
    }
    const invoiceId = idOf(primary.latest_invoice as string | { id: string } | null);
    // Voiding the invoice discards the pending update, so the charge can never be taken later.
    const voided = invoiceId
      ? await deps.stripe.invoices.voidInvoice(invoiceId).then(() => true, (error) => {
        deps.log.error("Could not void the abandoned charge", { message: (error as Error).message });
        return false;
      })
      : false;
    if (!voided) {
      // Most likely paid a moment ago: then the change stands and the held one is dropped.
      const now = await deps.stripe.subscriptions.retrieve(primary.id);
      if (!now.pending_update) await deps.store.takeHeldChange(customer.id);
      return finish(now.pending_update ? "payment_pending" : "ok");
    }
    await restoreHeldChange(deps, customer.id, primary.id, `${keyBase}:restore`);
    return finish("payment_abandoned");
  }

  if (action === "cancel_scheduled_change") {
    if (!state.scheduledChange || !state.primary) return refuse(deps, "no_scheduled_change");
    await deps.store.takeHeldChange(customer.id);
    await releaseSchedule(deps, state.primary);
    return finish("change_cancelled");
  }

  const decision = classifyChange(deps.config, state, { plan: input.plan, interval: input.interval });
  if ("refusal" in decision) return refuse(deps, decision.refusal, decision.refusal === "no_subscription" ? 404 : 409);

  const { kind, from, to } = decision;
  const primary = state.primary!;
  const item = primary.items.data[0];
  const step = changeStep(deps.config, kind, from.interval !== to.interval);
  const targetPrice = getSellingPrice(catalog, to.plan, to.interval);
  const tax = deps.config.policy.automaticTax ? { automatic_tax: { enabled: true } } : {};
  const anchor = step.when === "now" && step.resetBillingCycleAnchor ? { billing_cycle_anchor: { type: "now" as const } } : {};
  // Stripe refuses `proration_date` with `proration_behavior: "none"` and with `billing_cycle_anchor: now`
  // (an interval change). Without it, Stripe prorates to the second of `apply`, which can differ from
  // the preview by a cent.
  const pinsProrationDate = step.when === "now" && step.proration_behavior !== "none" && !step.resetBillingCycleAnchor;
  const base = { kind, from, to, currency: targetPrice.currency, new_price_amount: targetPrice.unit_amount ?? 0 };

  // ---- preview ---------------------------------------------------------------------------
  if (action === "preview") {
    if (step.when === "release_schedule") {
      return ok({ ...base, amount_due_now: 0, cancels_change_to: state.scheduledChange, next_charge_at: toIso(state.periodEnd) });
    }
    if (step.when === "period_end") {
      return ok({ ...base, amount_due_now: 0, effective_at: toIso(state.periodEnd), next_charge_at: toIso(state.periodEnd) });
    }
    // Stripe prorates to the second, so `apply` must reuse this exact moment.
    const prorationDate = nowSeconds();
    const invoice = await deps.stripe.invoices.createPreview({
      customer: customer.id,
      subscription: primary.id,
      subscription_details: {
        items: [{ id: item.id, price: targetPrice.id, quantity: item.quantity ?? 1 }],
        proration_behavior: step.proration_behavior,
        ...(pinsProrationDate ? { proration_date: prorationDate } : {}),
        ...(step.trial_end ? { trial_end: step.trial_end } : {}),
        ...anchor,
      },
      ...tax,
    });
    const dueNow = step.chargesNow ? amountDueNow(invoice, !!step.resetBillingCycleAnchor || !!step.trial_end) : 0;
    return ok({
      ...base,
      amount_due_now: dueNow,
      tax_amount: step.chargesNow ? (invoice.total_taxes ?? []).reduce((sum, t) => sum + t.amount, 0) : 0,
      proration_date: prorationDate,
      effective_at: new Date(prorationDate * 1000).toISOString(),
      trial_end: kind === "trial_switch" && !step.trial_end ? toIso(state.trialEnd) : null,
      next_charge_at: kind === "trial_switch" && !step.trial_end
        ? toIso(state.trialEnd)
        : step.resetBillingCycleAnchor || step.trial_end
        ? toIso(invoice.lines.data.find((line) => !isProration(line))?.period?.end)
        : toIso(state.periodEnd),
    });
  }

  // ---- apply -----------------------------------------------------------------------------
  if (step.when === "release_schedule") {
    await deps.store.takeHeldChange(customer.id);
    await releaseSchedule(deps, primary);
    return finish("change_cancelled", { kind, from, to });
  }

  // A failed earlier upgrade can leave a pending update and its open invoice behind. Void it so
  // it can never be paid later and apply a change nobody asked for.
  if (primary.pending_update && primary.latest_invoice) {
    await deps.stripe.invoices.voidInvoice(idOf(primary.latest_invoice as string | { id: string })!).catch((error) =>
      deps.log.error("Could not void stale pending-update invoice", { message: (error as Error).message })
    );
  }

  if (step.when === "period_end") {
    // A new scheduled change supersedes one held from an earlier, unfinished charge.
    await deps.store.takeHeldChange(customer.id);
    const { scheduleId, effectiveAt } = await scheduleChange(deps, primary, targetPrice, to, `${keyBase}:schedule`);
    await deps.mailer.send({
      to: user.email,
      type: "plan_changed",
      dedupeKey: `plan_changed:scheduled:${scheduleId}:${to.plan}:${to.interval}:${effectiveAt}`,
      userId: user.id,
      data: { kind: "downgrade_scheduled", from, to, effectiveAt: toIso(effectiveAt) },
    } satisfies EmailMessage);
    return finish("scheduled", { kind, from, to });
  }

  if (step.chargesNow && !isProrationDateUsable(deps.config, input.prorationDate, state.periodStart, nowSeconds())) {
    return refuse(deps, "preview_expired");
  }

  // A change made now replaces any scheduled downgrade. Hold it BEFORE releasing, so a declined,
  // abandoned or expired charge can put it back and leave the account exactly as it was.
  const released = state.scheduledChange;
  if (released) {
    const change = { subscriptionId: primary.id, plan: released.plan, interval: released.interval };
    let held = await deps.store.holdChange(customer.id, change);
    if (!held) {
      // No row yet for this customer: write it from Stripe, then hold.
      await applyState(deps, await readFresh(deps, customer.id, catalog), { email: user.email, userId: user.id });
      held = await deps.store.holdChange(customer.id, change);
    }
    if (!held) deps.log.error("No billing row to hold the released change on", { customerId: customer.id });
  }
  await releaseSchedule(deps, primary);

  const updated = await deps.stripe.subscriptions.update(
    primary.id,
    {
      // A price change resets quantity to 1 unless it is sent.
      items: [{ id: item.id, price: targetPrice.id, quantity: item.quantity ?? 1 }],
      proration_behavior: step.proration_behavior,
      ...(step.chargesNow && pinsProrationDate ? { proration_date: input.prorationDate as number } : {}),
      ...(step.payment_behavior ? { payment_behavior: step.payment_behavior } : {}),
      ...(step.trial_end ? { trial_end: step.trial_end } : {}),
      ...anchor,
      // No `automatic_tax` here: pending updates do not accept it, and the setting already lives on
      // the subscription from checkout.
      metadata: { plan: to.plan },
      expand: ["latest_invoice.confirmation_secret", "latest_invoice.payments"],
    },
    { idempotencyKey: `${keyBase}:${kind}` },
  );

  if (!updated.pending_update) {
    await deps.store.takeHeldChange(customer.id);
    deps.log.info("Plan changed", { kind, from, to });
    return finish("applied", { kind, from, to });
  }

  // Stripe answers 200 with a pending update when the charge did not complete.
  const invoice = updated.latest_invoice as Stripe.Invoice | null;
  const intent = await paymentIntentOf(deps, invoice);
  const clientSecret = invoice?.confirmation_secret?.client_secret ?? intent?.client_secret;
  if (intent?.status === "requires_action" && clientSecret) {
    // The held change waits: `sync` drops it once paid, `abandon_payment` or the
    // `pending_update_expired` webhook puts it back.
    deps.log.info("Plan change needs authentication", { kind, from, to });
    return ok({ status: "requires_action", kind, from, to, client_secret: clientSecret });
  }

  if (invoice?.id) {
    await deps.stripe.invoices.voidInvoice(invoice.id).catch((error) =>
      deps.log.error("Could not void declined invoice", { message: (error as Error).message })
    );
  }
  await restoreHeldChange(deps, customer.id, primary.id, `${keyBase}:restore`);
  deps.log.info("Plan change declined", { kind, from, to, intentStatus: intent?.status ?? null });
  return refuse(deps, "payment_failed", 402);
}
