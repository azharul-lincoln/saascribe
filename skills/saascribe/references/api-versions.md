# Stripe API versions

The templates target **`2026-09-30.endive`** with **`stripe` (stripe-node) 23.x**, which pins that version by
default. Checked against Stripe's changelog and the stripe-node 23.0.0 type definitions on 2026-10-07.
Re-check `https://docs.stripe.com/changelog` before relying on this list for a later version.

## Set the version in three places

1. The SDK client: `new Stripe(key, { apiVersion: "2026-09-30.endive" })` (`services/stripe-client.ts`). Since
   stripe-node 22, `Stripe` must be called with `new`.
2. Every webhook endpoint: create it with `api_version: "2026-09-30.endive"`. Snapshot event payloads follow the
   **endpoint's** version, not the SDK's, and an endpoint's version cannot be changed later; make a new endpoint.
   The webhook handler still re-reads objects with the SDK so the code never depends on the payload shape.
3. Stripe.js on the frontend: use the current `@stripe/stripe-js`. `handleCardPayment`, `confirmPaymentIntent`,
   `handleCardSetup` and `confirmSetupIntent` were removed in 2026-03-25.dahlia; use `handleNextAction`,
   `confirmPayment` and `confirmSetup`.

## What moved, and what the templates do instead

| Topic | Old (acacia, 2024-12-18) | Now (endive) | Since |
|---|---|---|---|
| Period dates | `subscription.current_period_start/end` | `subscription.items.data[0].current_period_start/end` (`periodOf()`) | 2025-03-31.basil |
| Invoice's subscription | `invoice.subscription` | `invoice.parent?.subscription_details?.subscription` (check `parent.type === "subscription_details"`) | basil |
| Invoice payment | `invoice.payment_intent`, `invoice.paid` | `invoice.confirmation_secret` (expand), `invoice.payments` (expand), `invoice.status === "paid"` | basil |
| 3DS on an upgrade | `expand: ["latest_invoice.payment_intent"]`, `.client_secret` | `expand: ["latest_invoice.confirmation_secret"]`, pass `confirmation_secret.client_secret` to `stripe.handleNextAction` | basil |
| Proration lines | `line.proration` | `line.parent.subscription_item_details.proration` or `line.parent.invoice_item_details.proration`, by `line.parent.type` | basil |
| Upcoming invoice | `invoices.retrieveUpcoming` | `invoices.createPreview({ customer, subscription, subscription_details })` | basil |
| Billing mode | classic only | `flexible` is the default for new subscriptions; cannot go back to classic | 2025-09-30.clover |
| Schedule phase length | `phases[].iterations` | `phases[].duration: { interval, interval_count }` | clover (removed) |
| Billing anchor param | `billing_cycle_anchor: "now" \| "unchanged"` | `billing_cycle_anchor: { type: "now" \| "unchanged" }` on update, resume and preview | 2026-09-30.endive |
| Checkout `ui_mode` | `hosted`, `embedded`, `custom` | `hosted_page`, `embedded_page`, `elements`, `form` (old values error) | 2026-03-25.dahlia |
| `payment_method_types` | allowed | 400 on Checkout Session, PaymentIntent and SetupIntent writes; use dynamic payment methods | endive |
| Portal cancel | `cancel_at_period_end: true` | `cancel_at` set (flexible mode); `deriveState` treats both as "set to end" | clover |

## Flexible billing mode: what changes for plan changes

New subscriptions are flexible unless you send `billing_mode: { type: "classic" }`. The templates accept flexible:

- **The anchor never resets on its own.** Moving monthly to yearly must send `billing_cycle_anchor: { type: "now" }`,
  or the yearly price keeps the monthly anchor. `changeStep(..., intervalChanges)` sets `resetBillingCycleAnchor`.
- **Credits use what was actually charged** for the unused time, so a period paid in several debits yields several
  credit lines. Preview totals already account for this; show `amount_due`, not a hand-made sum.
- **`pending_if_incomplete` invoices leave existing pending invoice items out**, so the upgrade charge is only the
  upgrade.
- **Mixed intervals on one subscription are allowed**, but the templates still require exactly one item.

## Subscription schedules (period-end downgrade)

- `subscriptionSchedules.create({ from_subscription })` must be sent alone, then `update` with **all** phases.
  Anything an update leaves out is unset, so re-send `default_payment_method`, `metadata` and items on every phase.
- Second phase: `duration: { interval: <target interval>, interval_count: 1 }`, `end_behavior: "release"`.
- A schedule stays attached for its whole last phase after the change took effect; only a phase that has not started
  is a pending change (`scheduledChangeOf`).
- The customer portal can schedule period-end downgrades only between prices of the **same product**. With one
  product per plan, the app must run its own schedule (this skill's `change-plan`).

## Webhooks

- Snapshot `customer.subscription.*` and `invoice.*` events remain the integration path. Thin events for v1 resources
  (`v1.customer.subscription.updated`) are generally available since endive; they are optional and not used here.
- `event.livemode` tells test from live; the handler drops events from the inactive mode after verifying the signature.

## Moving an older integration to endive

An app pinned to an acacia version (stripe-node 17 or earlier) usually reads the shapes below. Its webhook endpoints
may already send newer payloads than its SDK expects, which is one more reason to re-read every object with your own
client. Search the code for each of these before switching:

| Search for | Read instead |
|---|---|
| `subscription.current_period_start` / `current_period_end` | `subscription.items.data[0].current_period_*` |
| schedule phase `iterations` | `duration: { interval, interval_count }` |
| `line.proration` on invoice lines | `line.parent.subscription_item_details.proration` |
| `latest_invoice.payment_intent` (3D Secure, first payment) | `latest_invoice.confirmation_secret.client_secret`, and `invoice.payments` for the PaymentIntent |
| `invoice.subscription` | `invoice.parent.subscription_details.subscription` |
| `billing_cycle_anchor: "now"` on update | `billing_cycle_anchor: { type: "now" }` |

Switch the SDK and the version together, fix every hit, then create new webhook endpoints on the new version.
Subscriptions created before the switch stay on `classic` billing mode; only new ones become `flexible`, so test both.

## Sources

- Changelog: `https://docs.stripe.com/changelog` (basil 2025-03-31: period dates, invoice parent, invoice payments,
  preview API; basil 2025-06-30: billing mode; clover 2025-09-30: flexible default, `iterations` removed; dahlia
  2026-03-25: Checkout `ui_mode`, Stripe.js removals; endive 2026-09-30: polymorphic `billing_cycle_anchor`,
  `payment_method_types` removal, thin v1 events GA)
- Billing mode comparison: `https://docs.stripe.com/billing/subscriptions/billing-mode/compare`
- Pending updates: `https://docs.stripe.com/billing/subscriptions/pending-updates`
- Schedules: `https://docs.stripe.com/billing/subscriptions/subscription-schedules`
- Webhook versioning: `https://docs.stripe.com/webhooks/versioning`
- Portal configuration: `https://docs.stripe.com/customer-management/configure-portal`
- stripe-node changelog: `https://github.com/stripe/stripe-node/blob/master/CHANGELOG.md`

## Not yet confirmed by a running test

- `expand: ["latest_invoice.confirmation_secret"]` on `subscriptions.update` with a pending update, and passing that
  secret to `handleNextAction`. Follows from the field definitions; the test-mode scenario list covers it.
- `trial_end: "now"` together with `payment_behavior: "pending_if_incomplete"` (policy `end_trial_and_charge`).
