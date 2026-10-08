# Sandbox run against real Stripe, 2026-10-08

`research/sandbox-e2e.ts` runs the reference services (`templates/services/*`) against a fresh Stripe sandbox on API
`2026-09-30.endive` with stripe-node 23. Each scenario gets its own customer on its own test clock; the clocks are
deleted afterwards. The billing store is in memory. Webhooks are not delivered to an endpoint: the account's real
events are read back with `events.list`, signed locally and passed to `handleWebhook`, so the handler sees real
payload shapes.

Test payment methods: `pm_card_visa`, `pm_card_chargeCustomerFail` (attaches, declines on charge),
`pm_card_authenticationRequired` (always asks for 3D Secure).

## Results

| Scenario | Result |
|---|---|
| Upgrade, card succeeds | Pass. Preview 2000, charged 2000, plan Pro now |
| Upgrade declined, downgrade was scheduled | Pass. 402 `payment_failed`, plan unchanged, no pending update, no open invoice, downgrade scheduled again |
| Upgrade needs 3D Secure, then abandoned | Pass. `requires_action` with the PaymentIntent secret, held downgrade stored; `abandon_payment` voided the invoice and put the downgrade back |
| Upgrade needs 3D Secure, never finished | Pass. Advancing the clock 2 days produced `customer.subscription.pending_update_expired`; the webhook put the downgrade back |
| Downgrade at period end | Pass. Nothing changed before period end; after the clock passed it, Basic, renewal 1000; 24 replayed events left the row on Basic |
| Keep my plan | Pass. Schedule released; still Pro after period end |
| Trial switch, default policy | Pass. Pro during the trial, trial end unchanged, nothing charged |
| Trial switch, `end_trial_and_charge` | Pass. Trial ended, active on Pro; preview 3000, paid 3000 |
| Monthly to yearly | Pass after a fix (below). Preview 9000, paid 9000 (yearly 10000 less the unused month); new period 365 days |
| Past due, then cancel | Pass. `past_due` kept access, plan changes refused with `past_due`; cancel ended it now and voided the open invoice |

## What the run changed

- **Interval change.** Stripe refuses `proration_date` together with `billing_cycle_anchor: { type: "now" }`:
  "You cannot specify `proration_date` when `billing_cycle_anchor=now`". The reference sent both on the preview and the
  update. It now leaves `proration_date` out whenever the anchor resets. `plan-changes.md` says so.
- **"Due now" with an anchor reset** (unconfirmed in `plan-changes-raw.md`): the whole preview invoice is due now. The
  monthly-to-yearly and trial-ending cases both charged exactly the previewed amount.
- **Pending update expiry follows the test clock.** Advancing a clock two days expires the pending update and sends
  `customer.subscription.pending_update_expired`, so the backstop can be tested without waiting 23 hours.

## Not covered

- Checkout Sessions and the post-payment page (they need a browser).
- Stripe Tax, discounts and quantities above 1 on a schedule.
- A webhook endpoint receiving live deliveries; the handler was fed real events, signed locally.
- The Supabase store against PostgREST (the SQL was run in a local Postgres 14 instead).
