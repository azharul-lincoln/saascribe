# Stripe plan changes: raw research (API 2026-09-30.endive, stripe-node 23.0.0)

Fetched 2026-10-08 from docs.stripe.com. Types checked in `node_modules/stripe/esm/resources/*.d.ts` and `node_modules/stripe/CHANGELOG.md`.

## 1. Changing the price

**Answer**
- Update the subscription with `items: [{ id: <si_>, price: <new> }]`. If you leave out `id`, Stripe adds a second item and both prices stay active. Changing the price resets `quantity` to 1 unless you pass it. You can also call `subscription_items.update`. [CP]
- `proration_behavior` (default `create_prorations`): `create_prorations` makes proration items that wait for the next invoice; `always_invoice` makes prorations and invoices them right away; `none` makes no prorations. [PR][SU]
- Billing period: same interval keeps the dates. A different interval "is billed at the new interval, starting on the day of the change". [CP] The API reference says an interval change "reset[s] the billing date" and charges right away, even with `none`. [SU]
- Classic vs flexible: classic resets the anchor automatically on an interval change. Flexible "never automatically reset[s]" the anchor; it resets only when you pass `billing_cycle_anchor` set to anything other than `unchanged`. [BMC] Migrating to flexible is one-way. Flexible is the default from `2025-09-30.clover` on. [BM]
- What happens on flexible when a single-item monthly subscription moves to yearly without an anchor reset: **UNCONFIRMED** (no page covers it). Pass the anchor explicitly.
- In endive, `billing_cycle_anchor` on `subscriptions.update` is an OBJECT `{ type: 'now' | 'unchanged' }`. Before endive it was a string. [SU]; CHANGELOG ("Change type of ... SubscriptionUpdateParams.billing_cycle_anchor from enum to billing_cycle_anchor_param").

**Sources** [CP] https://docs.stripe.com/billing/subscriptions/change-price · [PR] https://docs.stripe.com/billing/subscriptions/prorations · [SU] https://docs.stripe.com/api/subscriptions/update · [BM] https://docs.stripe.com/billing/subscriptions/billing-mode · [BMC] https://docs.stripe.com/billing/subscriptions/billing-mode/compare

## 2. Pending updates

**Answer**
- Requires `collection_method=charge_automatically` and a supported payment method (card, Link and others). [PU]
- Supported parameters on subscription update: `expand`, `payment_behavior`, `proration_behavior`, `proration_date`, `billing_cycle_anchor`, `items` (`price`, `quantity`, `discounts`), `trial_end`, `trial_from_plan`, `metadata`, `discounts`, `cancel_at_period_end`, `coupon`, `promotion_code`, `add_invoice_items`. **`automatic_tax` and `default_payment_method` are NOT listed.** [PU]
- Expiry: `expires_at` is the earlier of `trial_end` or the earliest item `current_period_end` if either falls within 23 hours. Otherwise it is 23 hours after the request. At expiry Stripe voids the invoice and discards the update. [PU]
- The update is also auto-voided by: a billing threshold, a schedule phase transition, a later update that sends `billing_cycle_anchor`, a non-empty `items`, `trial_end` or `trial_from_plan=true`, or a later update with conflicting discount or cancel changes. [PU]
- Events: `customer.subscription.updated` (check `pending_update`), `customer.subscription.pending_update_applied`, `customer.subscription.pending_update_expired`. [PU]
- On failure, the returned subscription has `pending_update` set and the invoice stays open until expiry. Stripe's guidance:
  - Card decline: attach a new payment method, then call `invoices.pay`.
  - Authentication: follow the requires-action flow.
  - To cancel: void `latest_invoice`.
  - A successful payment applies the update and marks the invoice paid. [PU]
- On flexible with `pending_if_incomplete`, the update invoice leaves out pending invoice items that already existed. [PU][BMC]

**Sources** [PU] https://docs.stripe.com/billing/subscriptions/pending-updates

## 3. 3D Secure on an upgrade invoice

**Answer**
- Requires-action state: PaymentIntent is `requires_action`, invoice is `open`. Watch `invoice.payment_action_required`, pass the PaymentIntent client secret to **`stripe.handleNextAction`**, then confirm through `invoice.paid` that the subscription is active before provisioning. [OV]
- `handleNextAction` throws if the PaymentIntent is in any other status. It may redirect to `return_url`. [JS]
- Client secret in the current API: `invoice.confirmation_secret.client_secret`, read from `expand: ['latest_invoice.confirmation_secret']`. That field "currently contains the client_secret of the PaymentIntent". [BS]; Invoices.d.ts
- `latest_invoice.payments` gives an `InvoicePayment` list in which `payment.payment_intent` is only an ID unless expanded (InvoicePayments.d.ts). The maximum expand depth is four levels [EX], so `latest_invoice.payments.data.payment.payment_intent` (five segments) is probably too deep. Retrieve the PaymentIntent to read its `status`. Exact API error: **UNCONFIRMED**.
- For a pending update, a successful payment "immediately applies the changes". [PU]

**Sources** [OV] https://docs.stripe.com/billing/subscriptions/overview · [JS] https://docs.stripe.com/js/payment_intents/handle_next_action · [BS] https://docs.stripe.com/billing/subscriptions/build-subscriptions?payment-ui=elements&api-integration=paymentintents · [EX] https://docs.stripe.com/api/expanding_objects

## 4. Previewing a proration

**Answer**
- Use `invoices.createPreview({ customer, subscription, subscription_details: { items:[{id, price}], proration_behavior, proration_date, billing_cycle_anchor: { type: 'now'|'unchanged'|'timestamp' } } })`. [IP][PR]
- `proration_date` must be inside the current period and the current schedule phase. It requires `subscription` plus `items` or `trial_end`, and **cannot be combined with `proration_behavior: 'none'`**. [IP]
- Send the same `proration_date` on the real update so the amounts match (Stripe prorates to the second). [PR][IP] The docs give no 15-minute limit; that limit is our own choice.
- Prorations only: "consider line items where `parent.subscription_item_details.proration` is `true`". [IP]
- The default preview (`preview_mode: 'next'`) is the next invoice. `recurring` estimates the long-term bill and does not support prorations or trials. [IP]
- How to split "due now" from "next renewal" when `always_invoice` is combined with an anchor reset: **UNCONFIRMED**. Sum the proration lines for a same-interval upgrade, and confirm the interval-change case in a test clock.

**Sources** [IP] https://docs.stripe.com/api/invoices/create_preview

## 5. Downgrade at period end through a schedule

**Answer**
- Two calls:
  1. `subscriptionSchedules.create({ from_subscription })`. With `from_subscription` you cannot set other parameters, and must not set `billing_mode` because the schedule inherits it. [SS][BM]; SubscriptionSchedules.d.ts
  2. `update` with phase 0 (current price and quantity, the existing `start_date` and `end_date`) and phase 1 (new price, `duration: { interval:'month', interval_count:1 }`). [SS]
- "Include all items and settings from the current phase ... Stripe unsets omitted parameters." [SS]
- Phase fields: `items`, `start_date`, `end_date`, `duration` (recommended over manual dates), `proration_behavior` (applies on entry to the phase; default `create_prorations`), `default_payment_method`, `metadata` (merged into the subscription on phase entry), `billing_cycle_anchor` (`automatic`/`phase_start`), and `trial_end`. On trials: "you must specify the new `trial_end` on each phase". [SS]
- `iterations` was removed in `2025-09-30.clover` and does not appear in the v23 types. [MI]
- `end_behavior` defaults to `release`, which keeps the subscription running. [types]
- Undo: `release` (allowed when the schedule is `not_started` or `active`) leaves the subscription in place and drops the remaining phases. `cancel` also cancels the subscription. [SS]
- Direct subscription updates while a schedule is attached can split phases or be overwritten. Use the Schedules API, store schedule IDs, and discard them on `subscription_schedule.released`. [SS]
- A phase transition discards any pending update. [PU]

**Sources** [SS] https://docs.stripe.com/billing/subscriptions/subscription-schedules · [MI] https://docs.stripe.com/billing/subscriptions/mixed-interval?dashboard-or-api=api

## 6. Customer portal

**Answer**
- `subscription_update`: `products` (up to 10, each with `prices`), `default_allowed_updates` (`price`, `quantity`, `promotion_code`), `proration_behavior` (`none` default, `create_prorations`, `always_invoice`), `billing_cycle_anchor` (`now`/`unchanged`), `trial_update_behavior` (`end_trial` default, `continue_trial`). [PC]
- `schedule_at_period_end.conditions`:
  - `decreasing_item_amount` matches a cheaper price or lower quantity. It also matches a move to a longer interval when that is cheaper long-term.
  - `shortening_interval` matches yearly to monthly when no other item change is made.
  - The portal creates the schedule itself. [PC][CFG]
- "You can only downgrade at the end of a billing period between prices that have the same product." So cross-product period-end downgrades do not work in the portal. [CFG]
- The portal alone is enough only when all tiers are prices of ONE product. Otherwise use a custom integration. Any portal-created schedule must follow the schedule best practices. [CFG][SS]

**Sources** [PC] https://docs.stripe.com/api/customer_portal/configurations/object · [CFG] https://docs.stripe.com/customer-management/configure-portal

## 7. Trials

**Answer**
- "You can update subscriptions in a trial normally." On flexible, changes during a trial make line items the same way as outside a trial. [FT][BMC]
- The prorations table says an update during a free trial "without changing the trial status" gives a non-proration debit. That implies a price swap keeps the trial unless `trial_end` is sent. [PR] `trial_update_behavior=continue_trial` points the same way. [PC] A sentence saying exactly "`proration_behavior: none` keeps the trial": **UNCONFIRMED**.
- `trial_end: 'now'` ends the trial and starts a new billing period. Ending a trial makes a NON-proration full-period debit and always produces an invoice, so `always_invoice` is not what triggers it. [FT][PR][PU]
- `trial_end` is a supported pending-update attribute. [PU]
- Free trial periods (`trial_end`) are now labelled "Legacy". Stripe recommends trial offers for new integrations. [FT]

**Sources** [FT] https://docs.stripe.com/billing/subscriptions/trials/free-trials

## 8. Best practices and warnings

**Answer**
- Use `proration_date` from the preview. [PR]
- Pair `always_invoice` with pending updates. [CP]
- Proration lines use the discounted price and are `discountable=false`. [PR]
- An unpaid previous invoice can produce credits for time that was never paid. Use `none` and void the old invoice to avoid paying twice. [PR]
- A free-to-paid change resets the anchor on classic but not on flexible. [CP][BMC]
- Idempotency and the details of tax on prorations were not covered by the pages read: **UNCONFIRMED**.

## Corrections to our current approach

1. **Upgrade.** `billing_cycle_anchor: { type: 'now' }` is the correct endive shape for update and preview. However, `proration_date` cannot be sent to the preview together with `proration_behavior: 'none'`. On flexible the anchor must be sent explicitly on an interval change, which the plan already does. [IP][BMC]
2. **Upgrade.** Expanding `latest_invoice.payments` does not return the PaymentIntent status, and a five-level expand is probably over the limit. Retrieve the PaymentIntent, or treat `pending_update != null` plus `confirmation_secret` as the requires-action branch. [EX]
3. **Upgrade.** Voiding the invoice to cancel the pending update matches the docs. For card declines, though, Stripe's documented recovery is a new payment method plus `invoices.pay`. Do not void if you want to offer a retry. [PU]
4. **Upgrade.** The restored downgrade schedule must re-send every setting from phase 0, because omitted settings are unset. [SS]
5. **Downgrade.** Matches the documented recipe. Add `quantity` and any discounts, tax rates and metadata to both phases. If the subscription is trialing, send `trial_end` on the phases. `end_behavior: 'release'` is already the default. Phase `proration_behavior: 'none'` is harmless because a transition at a period boundary has nothing to prorate. [SS]
6. **Trial switch.** The price swap with `none` is consistent with the docs. For the `trial_end: 'now'` alternative, `always_invoice` is redundant because ending the trial already invoices. Do not send `proration_date` with `none` on its preview. [PR][IP]
