# Baseline run without the skill (RED), 2026-10-07

Setup: fresh `claude -p` in `/tmp/saascribe-baseline` (scratch Supabase + React app, three monthly plans, webhook
that reads `subscription.metadata.plan`). Task: add in-app upgrades and downgrades with a price preview, a hardened
webhook, cancellation, and failed-payment handling; make and record its own policy decisions. No skill loaded.
The baseline could not run `deno`, `tsc` or `psql` (no approval in `-p` mode), so its code is unverified.

## What it got right (the skill does not need to teach these)

- Plan from the price, not `metadata.plan`.
- Signature check on the raw body; re-fetch the subscription instead of trusting the payload.
- `invoices.createPreview` with the same `proration_date` the change uses; 15-minute quote window; rejects a
  backdated or pre-renewal quote; idempotency key on the change.
- Upgrade with `always_invoice` + `pending_if_incomplete`; plan changes blocked while past due or set to cancel.
- Basil-era field paths (`items.data[].current_period_end`, `invoice.parent.subscription_details.subscription`).
- Smart Retries with "cancel the subscription" when retries fail; past_due keeps access.

## Gaps the skill must close

| # | Baseline behavior | Consequence | Skill answer |
|---|---|---|---|
| 1 | Tracks one subscription id per row; a second subscription is ignored while the first grants access | A customer billed twice is never noticed; a plan change can run on the wrong subscription | Derive state from all subscriptions; `paidLiveCount > 1` blocks changes; audit lists duplicates |
| 2 | Price ids from env vars (`STRIPE_PRICE_BASIC`...) | An archived or replaced price is unmapped; the webhook 500s on every event for those customers | Catalog from product metadata, archived prices included |
| 3 | No check of `event.livemode` or the app's active mode | Test events can write production rows once both endpoints point at one URL | Drop events from the inactive mode after the signature check |
| 4 | Declined or 3DS upgrade sends the user to the hosted invoice page; the open invoice stays open | The customer can be charged for the upgrade hours later; 3DS leaves the app | `handleNextAction` in the browser, void the invoice on decline, restore a released downgrade |
| 5 | Downgrade applies now with credit, chosen to avoid subscription schedules | Policy picked for implementation convenience, not presented to the owner | Policy is an explicit option with a recommended default; schedule code provided |
| 6 | Cancel while past_due runs to period end; the open invoice keeps being retried | A customer who cancelled is still charged | Past-due cancel ends now and voids open invoices |
| 7 | No checkout guard | Checkout again creates a second subscription | 409 `already_subscribed` before touching the customer; abandoned checkouts cancelled |
| 8 | No lifecycle emails of its own, no dedupe | Either no emails or duplicates on webhook retries | Mailer port with dedupe keys per event |
| 9 | Webhook returns 500 until a row with `user_id` metadata exists | Three days of retries for every checkout made before the row exists | Rows keyed by customer and email; the post-payment step links the user |
| 10 | No post-payment signup proof, no portal or dashboard check, no audit | Account takeover on post-payment pages; portal can still switch plans | Checkout proof; `check-stripe-settings`; read-only audit |
| 11 | Chose `2026-08-26.dahlia` with stripe-node 22.6.2 and rejected endive as one week old | Reasonable, but the choice should be the owner's and recorded | `api-versions.md` explains both; templates target endive |
| 12 | Write ordering by `stripe_event_at` plus an advisory lock | Extra machinery that re-fetching already makes unnecessary, with a known same-second bug | Recompute from Stripe on every write; no event timestamps |

The skill text should target rows 1, 3, 4, 6, 7 and 10 hardest: the baseline did not raise them at all.
Row 5 needs the policy interview step, not a rule.
