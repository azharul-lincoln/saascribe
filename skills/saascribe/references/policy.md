# Billing policy decisions

Settle these with the developer before building. Each has a recommended default (what the reference app runs in
production) and the main consequence of each option. Record the answers; later steps and the UI copy depend on them.
The reference code reads them from `templates/core/config.ts` (`Policy`).

| Decision | Options | Recommended | What follows |
|---|---|---|---|
| Upgrade timing and charge | Now, charge the prorated difference now (`always_invoice`); now, add the difference to the next invoice (`create_prorations`); at period end | Now, charge now, with `payment_behavior: pending_if_incomplete` | Charge-now needs a preview, 3D Secure handling and decline handling. Next-invoice is simpler but gives the bigger plan before payment. |
| Downgrade timing | At period end through a subscription schedule; now, with a credit on the next invoice | Period end, no refund | Period end needs schedule code and an "undo" button. Now-with-credit is one API call but customers can downgrade, use credit, and upgrade again. |
| Switching during a trial | Free, keep the trial end; end the trial and charge the new plan now | Free, keep the trial end | Ending the trial on switch turns a trial switch into a charge, with the same decline handling as an upgrade. |
| Monthly and yearly | Monthly only; both | Product decision | With both: month to year (same or bigger plan) counts as an upgrade; year to month or a smaller plan counts as a downgrade at period end. |
| Access while a renewal is failing | Keep the plan while Stripe retries (`past_due` is entitled); lock at the first failure | Keep while retrying | Keeping access needs Stripe's "if all retries fail" set to cancel or mark unpaid, never "leave past due". |
| Cancel | Period end, except trial and past due end now; always period end; always now | Period end, except trial and past due | A trial has nothing paid to run out; a past-due plan has not paid for its period. Ending past due now must void the open invoice. |
| Trial | Length; card required up front or not; what happens with no card at trial end (`cancel`, `pause`, `create_invoice`) | 7 days, card up front, `cancel` | No card up front raises signups and lowers conversion; `missing_payment_method` then matters. |
| Plan changes in the Stripe customer portal | Off (in-app only); on | Off, unless every plan is a price of one product and the portal's rules match the policy | The portal can schedule period-end downgrades only between prices of the same product and applies its own proration settings. See `plan-changes.md`. |
| Tax | None; Stripe Tax (`automatic_tax`) | Depends on where the business sells | Stripe Tax needs a customer address at checkout and registrations in the dashboard. |
| Stripe mode | One mode per deployment (staging = test, production = live); runtime switch stored in the database | One per deployment | A runtime switch needs the webhook to drop the inactive mode's events and the stored customer ids to tolerate the other mode. |
| Who sends customer emails | The app; Stripe; both | The app for lifecycle emails, Stripe for nothing that duplicates them | Decide per email type in the dashboard (receipts, failed payments, upcoming renewals). |
| Preview validity | Minutes an upgrade preview's `proration_date` may be reused | 15 minutes | Longer windows let the charged amount drift from what was shown; shorter ones annoy slow readers. |

## Fixed points worth keeping

These are not options in the reference design, because the failures they prevent are costly. A project can still
decide otherwise; make it a conscious choice.

- One subscription per customer; checkout refuses an email that already has a paid plan.
- The plan comes from the price, not metadata.
- One writer for the billing row, recomputed from Stripe.
- Webhook signature always verified; the inactive mode's events dropped.
- Post-payment account creation only with proof of the checkout.
