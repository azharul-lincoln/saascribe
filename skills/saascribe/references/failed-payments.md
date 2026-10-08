# Cancel, resume and failed payments

## Cancel

Cancel every subscription that grants access, not only the primary one, so a duplicate cannot keep charging after the
customer asked to stop. For each:

1. Release any subscription schedule first (a scheduled downgrade has nothing left to switch to, and a subscription
   managed by a schedule should be changed through it).
2. End it now or at period end, by the policy (`policy.md`): `subscriptions.cancel` for now, `update({ cancel_at_period_end: true })`
   for period end.
3. If it was `past_due` or `unpaid` and ends now, void its open invoices **after** the cancel (voiding the latest invoice
   of a live past-due subscription can flip it back to active). Log a void failure loudly instead of failing the
   request: the plan is already cancelled.

Ask for a reason (a fixed list plus an optional note) and keep it; it is the cheapest churn research there is. Then
recompute the row and return when access ends.

## Resume

Undo a scheduled cancellation on the primary subscription only: `cancel_at_period_end: false`, or clear `cancel_at`
(`cancel_at: ""` in stripe-node) when the portal set a date. A subscription that already ended cannot be resumed; that
is a new checkout.

## Failed renewals

- **Stripe retries.** Configure it in the dashboard (Billing, Revenue recovery, Retries): Smart Retries on, and "if all
  retries fail" set to cancel the subscription or mark it unpaid. "Leave past due" would keep a non-paying customer on
  the plan forever under a keep-access policy.
- **While retrying** the subscription is `past_due`. With the recommended policy the customer keeps the plan, sees a
  "payment failed" banner with an "update card" action (the customer portal's payment method page works), and cannot
  change plans until it is fixed.
- **After the last retry** it becomes `canceled` or `unpaid`, which ends access; the webhook recomputes the row.
- **Emails:** one "payment failed" per failed attempt is usual; include the next retry date (`invoice.next_payment_attempt`)
  and the hosted invoice link. Decide whether Stripe's own failed-payment emails stay on.

## Docs

- Cancel subscriptions: https://docs.stripe.com/billing/subscriptions/cancel
- Revenue recovery and retries: https://docs.stripe.com/billing/revenue-recovery/smart-retries
- Subscription statuses: https://docs.stripe.com/billing/subscriptions/overview#subscription-statuses

Reference: `templates/services/cancel.ts`, `templates/core/change-rules.ts` (`cancelMode`).
