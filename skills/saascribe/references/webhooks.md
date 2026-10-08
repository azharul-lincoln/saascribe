# The Stripe webhook

## What it does

Keeps the app's billing row in step with Stripe and sends lifecycle emails. It is the backstop for every other path:
if a page load or a plan change failed to sync, the next event fixes it.

## Events worth handling

| Event | Action |
|---|---|
| `customer.subscription.created`, `.updated`, `.deleted` | Recompute the customer's row; send "plan active", "plan changed", "cancelled" emails when they apply |
| `customer.subscription.pending_update_expired` | Put back a downgrade an unpaid upgrade had replaced (`plan-changes.md`), then recompute |
| `customer.subscription.pending_update_applied` | Drop that held downgrade (the upgrade was paid), then recompute |
| `invoice.paid` | Recompute; send a receipt when `amount_paid > 0` (skip the $0 invoice that opens a trial) |
| `invoice.payment_failed` | Send "payment failed", except for a plan-change charge (see below) |
| `checkout.session.completed` | Recompute, so the row exists before the buyer reaches the post-payment page |
| `customer.updated` | Optional: mirror name, phone, address edited in the portal |

## How it should behave

- **Verify the signature on the raw body**, with each mode's signing secret. There should be no unsigned code path, even
  "for setup". On Deno and edge runtimes pass `Stripe.createSubtleCryptoProvider()` to `constructEventAsync`.
- **Drop the inactive mode's events.** Check that `event.livemode` matches the secret that verified it, then compare with
  the app's active mode and answer 200 with nothing else when they differ. If the active mode cannot be read, return
  500 so Stripe retries, rather than guessing.
- **Use the payload for ids and `previous_attributes` only.** Re-read objects with your SDK client: the payload follows
  the webhook endpoint's API version, which may differ from your code's.
- **Recompute, do not patch.** Call the single writer (`state-model.md`) for the customer. Order and replays then do not
  matter.
- **Throw on real failures** (500) so Stripe redelivers; return 200 for events you deliberately ignore.

## Emails without duplicates

Give every email a dedupe key and store it before sending; Stripe redelivers events, and two events can describe the
same change.

| Email | When | Dedupe key |
|---|---|---|
| Plan active | First event where a card stands behind the subscription: compare the payload with the payload overlaid by `previous_attributes`. A trial ending or a recovered payment is not this moment. | `subscription_confirmed:<subscription id>` |
| Plan changed | `customer.subscription.updated` with `previous_attributes.items` and a different plan | `plan_changed:<event id>` |
| Cancelled | `.deleted`, the customer is no longer entitled, there was a card, and the cancellation comment is not one of your own cleanups | `subscription_cancelled:<event id>` |
| Receipt | `invoice.paid` with an amount | `payment_receipt:<invoice id>` |
| Payment failed | `invoice.payment_failed`, unless the invoice is already void or paid, or the subscription has a `pending_update` (an in-app upgrade charge, which the plan dialog reports itself; 3D Secure also raises this event) | `payment_failed:<event id>` |

A delivery failure should be logged, and the key released, rather than thrown: otherwise one bad address makes Stripe
redeliver the event for days.

## Endpoint setup

- One endpoint per mode, created on the same API version as the code (`api_version` at creation; it cannot be changed
  later).
- Enable exactly the events above. Local development: `stripe listen --forward-to localhost:<port>/<path>`, which prints a
  temporary signing secret.
- Thin events for v1 resources (`v1.customer.subscription.updated`) are generally available since endive and can replace
  snapshot events; the design above works with snapshot events.

Reference: `templates/services/webhook.ts`.

## Docs

- Webhooks: https://docs.stripe.com/webhooks
- Versioning: https://docs.stripe.com/webhooks/versioning
- Subscription webhooks: https://docs.stripe.com/billing/subscriptions/webhooks
