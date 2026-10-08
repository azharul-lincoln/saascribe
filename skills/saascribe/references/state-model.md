# Plans, billing state and storage

## Model the plans in Stripe

- One Stripe product per plan, tagged with metadata naming the plan (for example `plan=pro`). Prices hang off the
  product: one active price per interval you sell. A price change means a new price on the same product and archiving
  the old one; existing subscribers keep the old price until moved.
- In code, build a **catalog** from `prices.list({ type: "recurring", expand: ["data.product"] })`: price id to
  `{ plan, interval }`, plus the price to sell for each `plan:interval`. Keep archived prices in the map so old
  subscriptions still resolve. Cache it for a few minutes. Never create prices from application code.
- Read a subscription's plan from its item's price through the catalog. `subscription.metadata` is written once and goes
  stale after the first change.
- Give plans a rank. Upgrade versus downgrade is a comparison of ranks (and intervals, if you sell yearly).

Reference: `templates/core/plan-catalog.ts`, `templates/core/config.ts`.

## Derive the state from all subscriptions

A customer can end up with more than one subscription: an abandoned checkout, a retry, a support mistake, a second
checkout before the guard existed. Reading "the" subscription id stored on the row hides those. Instead, list every
subscription of the customer (`status: "all"`, with `schedule` and `pending_setup_intent` expanded) and derive:

- **The primary subscription:** live and paid for first, then entitled, then live, then the bigger plan, then the newest.
  With nothing live, the newest ended one still gives the last plan.
- **Entitled:** the primary's status is `active` or `trialing` (and `past_due` if the policy keeps access while retrying).
- **Plan, interval, period end, trial end, set-to-cancel** (`cancel_at_period_end` or a `cancel_at` date; the portal under
  flexible billing mode sets `cancel_at`), **scheduled change** (a schedule phase that has not started yet).
- **Paid live count:** more than one is a duplicate. Block plan changes and show it in the audit.

Since API `2025-03-31.basil` the period dates live on subscription items (`items.data[0].current_period_end`), not on the
subscription.

Reference: `templates/core/subscription-state.ts` (`deriveState`, `isPaidFor`, `isAbandonedCheckout`, `scheduledChangeOf`).

## One writer for the app's billing row

Everything that learns something about a customer calls one function that re-reads Stripe and rewrites the row: the
webhook, the billing page load, plan change, cancel, resume, the post-payment signup. Nothing patches the row from a
single event. Typical row:

| Field | Note |
|---|---|
| `user_id` | Null until the account exists (checkout often comes first). Never replaced by a different user. |
| `email` | Unique case-insensitively; Stripe stores the address as typed. |
| `stripe_customer_id` | Unique. Replaced when the app switches Stripe mode. |
| `entitled`, `status`, `plan`, `interval` | Keep the last plan when the customer has only ended subscriptions. |
| `current_period_end`, `trial_end`, `cancel_at`, scheduled plan and date | For the billing page without a Stripe call. |
| `paid_subscription_count` | Duplicate detector. |

Make the write atomic: find by user id, then customer id, then email; update or insert; on a unique-key conflict retry
the update. The reference does this in one SQL function (`templates/adapters/sql/billing-schema.sql`,
`billing_save_subscriber`), which any Postgres client or ORM can call.

Re-reading Stripe does not order two writers by itself: two webhooks for one customer can read Stripe in one order and
save in the other, and the older read then wins. Take a monotonic token (a database sequence) before each Stripe read,
store it on the row, and have the writer refuse a write whose token is lower than the stored one, under the same row
lock as the update. The reference does this with `billing_next_sync_token()` and the `syncToken` check in
`billing_save_subscriber`; services call `readFresh` (token, then read) before `applyState`. A per-customer lock held
across the Stripe read also works, but keeps a database lock open during a network call.

If a plan change has side effects in the app (higher usage limits, unlocked features), run them from the writer when the
stored plan differs from the new one, before saving, and make them idempotent. Then whichever path sees the change first
applies it, and a failed save repeats it rather than skipping it. If the save is then refused as older, the side
effect ran on the older plan: run it once more towards the plan the row keeps, so the newest plan wins.

## Finding the customer

- For a signed-in user, skip a row that already belongs to another user, and a customer found by email that is
  linked to another user: by `metadata.app_user_id`, or by the row that stores its id. Write `app_user_id` onto the
  customer the first time a row links it to a user, so the claim holds even after the row's email changes. An address can move between accounts (one user changes theirs, another
  registers it); the email alone would then hand over the first user's billing. When a user changes their email, update
  the billing row and the Stripe customer too, or the old address keeps pointing at their row.

- Use the stored `stripe_customer_id` first. Stripe's email search is case-sensitive and does not return test-clock
  customers.
- Fall back to the email as typed and lowercased. A stored id from the other mode returns `resource_missing`; treat it as
  "not found here" and fall through.

## When Stripe is down

A failed Stripe call must never look like "no plan". Answer from the stored row, mark it stale, and do not write. Access
checks that gate the whole app should fail open on an inconclusive answer, so a paying customer is never locked out by
an outage.

## Docs

- Subscriptions overview: https://docs.stripe.com/billing/subscriptions/overview
- Products and prices: https://docs.stripe.com/products-prices/how-products-and-prices-work
- Subscription object: https://docs.stripe.com/api/subscriptions/object
