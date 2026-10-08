# Testing billing

Test in layers, cheapest first. Use a Stripe sandbox of its own for this app, never the live account and never another
product's account.

## 1. Rules without Stripe

The decisions that are easy to get subtly wrong are pure functions: which subscription is primary, entitled or not,
upgrade or downgrade, what a policy means in Stripe parameters, whether a preview is still usable, whether checkout proof
holds. Unit test them with small Stripe-shaped fixtures. `templates/core/*.test.ts` has a set to start from.

## 2. Services with a fake Stripe

Fake the few Stripe methods a service calls and assert on the calls: a declined upgrade voids its invoice, a past-due
cancel voids open invoices, checkout refuses a paying email before touching the customer, the webhook drops the other
mode. The real SDK's `webhooks.generateTestHeaderStringAsync` signs test payloads. See `templates/services/services.test.ts`.

A fake proves the logic, not the wiring. Run the type checker as well (`tsc --noEmit`, `deno check`, or your stack's
equivalent): a fake store or fake Stripe accepts whatever shape the test hands it, so a mismatched argument between two
services can pass every test and still fail in production.

## 3. Stripe test mode, end to end

- Forward webhooks locally: `stripe listen --forward-to localhost:<port>/<webhook path>`.
- Move time with **test clocks** (create the customer on a clock, then advance it) to see renewals, trial ends and
  scheduled downgrades happen. Note that Stripe leaves test-clock customers out of email search and unfiltered lists.
- Test cards: `4242424242424242` succeeds; `4000002760003184` always asks for 3D Secure; `4000000000000341` attaches but
  declines on charge (good for a renewal or upgrade decline); `4000000000009995` declines for insufficient funds.
  Check the current list at https://docs.stripe.com/testing.

## Scenario list

| Area | Scenario | Expect |
|---|---|---|
| Checkout | New buyer with trial | Subscription trialing with a saved card; row entitled; one "plan active" email |
| Checkout | Same email again | Refused (`already_subscribed`); no change to the customer |
| Checkout | Abandon, then retry | Old incomplete subscription cancelled silently; one live subscription |
| Post-payment | Proof from another browser or a forged nonce | 403; no account created |
| Upgrade | Card succeeds | Plan changes now; prorated invoice paid; amount matches the preview |
| Upgrade | Card declines | Plan unchanged; invoice voided; a previously scheduled downgrade still scheduled |
| Upgrade | 3D Secure | Browser completes the challenge; sync shows the new plan |
| Upgrade | 3D Secure abandoned, downgrade was scheduled | Dialog closed: invoice voided, plan unchanged, downgrade scheduled again |
| Sync | Two writes for one customer, older read saved last | Row keeps the newer read |
| Downgrade | Scheduled | Plan unchanged until period end; banner shows the date; advancing the clock applies it |
| Downgrade | Undo | "Keep plan" releases the schedule; nothing changes at period end |
| Trial | Switch plan | Plan changes now, nothing charged, trial end unchanged (with the default policy) |
| Interval | Monthly to yearly | Charged now for the year minus credit; new period starts now |
| Renewal | Card fails | `past_due`, access kept, banner shown, plan changes blocked |
| Renewal | Retries exhausted | `canceled` or `unpaid`; access ends; email sent |
| Cancel | While past due | Ends now; open invoice void; no later charge |
| Cancel | Active, then resume | Ends at period end; resume clears it |
| Webhook | Event from the other mode | 200, nothing written |
| Webhook | Same event twice | Same row; one email |

## Before calling it done

Run the audit (`templates/services/audit.ts` or your own query) against test mode: no duplicate live subscriptions, no
rows that disagree with Stripe, portal and webhook settings as intended.
