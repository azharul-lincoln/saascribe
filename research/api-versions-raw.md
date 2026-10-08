# Stripe API versions: acacia (2024-12-18) vs basil vs clover vs dahlia vs endive (latest)

Researched 2026-10-07. "Latest" = **2026-09-30.endive** (not dahlia). `CL` = `https://docs.stripe.com/changelog`. `TYPES` = local stripe-node 23.0.0 `node_modules/stripe/esm/resources/*.d.ts`.

## 1. Subscription period dates
- **Answer:** moved to subscription items in **2025-03-31.basil**.
- **acacia:** `subscription.current_period_start/end`.
- **latest:** removed from Subscription; `items.data[].current_period_start/end`. `customer.subscription.updated` `previous_attributes` now reports item period changes. TYPES: only `SubscriptionItems.d.ts` has them; `subscriptions.list` filters on min item `current_period_end`.
- **Source:** CL/basil/2025-03-31/deprecate-subscription-current-period-start-and-end

## 2. Invoice -> subscription id
- **Answer:** `invoice.parent.subscription_details.subscription` (check `parent.type === 'subscription_details'`), since basil.
- **acacia:** `invoice.subscription`, `invoice.subscription_details`.
- **latest:** `invoice.subscription`, `subscription_details`, `quote`, `subscription_proration_date` removed. Line items: `line.parent.subscription_item_details.subscription_item`; `type`, `proration`, `proration_details`, `subscription` removed from line items. `invoices.list({subscription, status})` params still exist (TYPES `InvoiceListParams`).
- **Source:** CL/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects

## 3. Client secret for 3DS on a pending_if_incomplete + always_invoice update
- **Answer:** `invoice.payment_intent` is gone (basil). Use `invoice.confirmation_secret.client_secret` (includable, so you must `expand`). Its `type` is "currently always payment_intent", so it is the PaymentIntent client secret.
- **acacia:** `expand: ['latest_invoice.payment_intent']`, then `.client_secret`.
- **latest:** `payment_intent`, `charge`, `paid`, `paid_out_of_band` removed from Invoice; `payments` (InvoicePayment list, also includable) and `confirmation_secret` added. Docs name both `latest_invoice.confirmation_secret` and `latest_invoice.payments.data.payment.payment_intent.client_secret`. Docs show `expand: ['latest_invoice.confirmation_secret']` on **subscriptions.create**. Pending updates list `expand` as allowed on update. **UNCONFIRMED:** a doc example of that exact expand on `subscriptions.update`.
- Stripe.js: the subscription "requires action" flow says "Retrieve the PaymentIntent's client secret and pass it to stripe.handleNextAction" (works only when the PI status is `requires_action`). `confirmCardPayment` is still in Stripe.js on dahlia: `handleCardPayment`/`confirmPaymentIntent` were removed. **UNCONFIRMED:** an explicit doc statement that `confirmation_secret.client_secret` can be passed to handleNextAction. It follows from the field definition.
- **Source:** CL/basil/2025-03-31/add-support-for-multiple-partial-payments-on-invoices ; https://docs.stripe.com/api/invoices/object ; https://docs.stripe.com/billing/subscriptions/overview (Requires action) ; https://docs.stripe.com/billing/subscriptions/pending-updates ; https://docs.stripe.com/js/payment_intents/handle_next_action ; https://docs.stripe.com/billing/subscriptions/build-subscriptions.md?payment-ui=elements&api-integration=paymentintents ; CL/dahlia/2026-03-25/remove-legacy-stripejs-methods

## 4. invoices.createPreview
- **Answer:** `GET /v1/invoices/upcoming` and `/upcoming/lines` were removed in basil (stripe-node 18 dropped `retrieveUpcoming`/`listUpcomingLines`). `createPreview` needs `customer` plus one of `subscription`, `subscription_details.items`, `schedule`, `schedule_details.phases` or `invoice_items`. It can no longer preview across all of a customer's subscriptions.
- **latest params (TYPES):** `customer`, `subscription`, `subscription_details.{items, proration_behavior, proration_date, billing_cycle_anchor, billing_mode, cancel_at, cancel_now, trial_end, start_date, metadata, pause, ...}`, `automatic_tax`, `customer_details`, `schedule_details`. **endive:** `subscription_details.billing_cycle_anchor` is now an object (`{type:'now'|'unchanged'}` or `{type:'timestamp', timestamp}`).
- **Source:** CL/basil/2025-03-31/invoice-preview-api-deprecations ; CL/endive/2026-09-30/polymorphic-billing-cycle-anchor ; https://github.com/stripe/stripe-node/blob/master/CHANGELOG.md (18.0.0)

## 5. billing_mode
- **Answer:** introduced 2025-04-30 preview, GA **2025-06-30.basil**. The `billing_mode` hash shape was consolidated in 2025-06-30.preview. Flexible is the **default for new subscriptions from 2025-09-30.clover**; older request versions default to classic. You opt out with `billing_mode[type]=classic`. You cannot migrate flexible -> classic.
- **Flexible differences:** credit prorations use the originally debited amount, so a period billed across several debits gets several credits. Discounts are prorated per item. The billing_cycle_anchor is never auto-reset; a free-to-paid upgrade creates pending items unless you use `always_invoice` or `billing_cycle_anchor=now`. Equivalent credit and debit are netted on an anchor reset. Update invoices include pending invoice items, except with `pending_if_incomplete`. Customer Portal cancels set `cancel_at`, not `cancel_at_period_end`. `trial_start` means the latest trial. Mixed intervals are allowed. Item limit is 100 vs 20.
- **Schedules:** `phases[].iterations` was **removed in 2025-09-30.clover**, replaced by `phases[].duration {interval, interval_count}` (added 2025-07-30.basil). Removal covers schedule create/update and `createPreview.schedule_details`. Clover also computes the phase `end_date` with billing_cycle_anchor changes (new schedules only). TYPES: 0 occurrences of `iterations`. Note: the schedules guide still shows `iterations` in its installment examples, so that part of the doc is stale.
- **Source:** CL/basil/2025-06-30/billing-mode ; CL/clover/2025-09-30/billing-mode-default-flexible ; CL/clover/2025-09-30/remove-iterations ; CL/basil/2025-07-30/add-schedule-phase-duration ; CL/clover/2025-09-30/billing-cycle-anchor-resets-during-phase-computation ; https://docs.stripe.com/billing/subscriptions/billing-mode/compare

## 6. Subscription schedules (latest)
- **Answer:** `from_subscription` must be sent alone ("other parameters (such as phase values) cannot be set"; make two calls). It creates one phase matching the current period, with no prorations. On update you pass **all** current and future phases; omitted params are unset. Update phases accept `start_date`/`end_date` (`number|'now'`), `duration`, `proration_behavior`, `default_payment_method`, `trial`, `billing_cycle_anchor`. Create phases have `end_date` and `duration`; `start_date` is set at schedule level. `end_behavior`: `release|cancel|none|renew`. There is a top-level update `proration_behavior` and a per-phase one for transitions. A phase change discards a pending update. Nothing renamed apart from iterations -> duration.
- **Source:** https://docs.stripe.com/billing/subscriptions/subscription-schedules ; https://docs.stripe.com/billing/subscriptions/pending-updates ; TYPES `SubscriptionSchedules.d.ts`

## 7. Checkout Sessions, mode=subscription
- **ui_mode:** **2026-03-25.dahlia** renamed `hosted`->`hosted_page`, `embedded`->`embedded_page`, `custom`->`elements` and added `form`. The old values now error. `custom` itself was added in basil.
- **endive:** `payment_method_types` on create returns 400; use dynamic payment methods or `allowed_payment_method_types`.
- **Tax address:** for an existing customer use `customer_update[address]=auto` plus `billing_address_collection=required|auto`. `auto` collects the minimum fields needed for tax.
- **Trials:** `subscription_data.trial_period_days`, `payment_method_collection=if_required`, `subscription_data.trial_settings.end_behavior.missing_payment_method` = `cancel|pause|create_invoice` (TYPES).
- **Retrieve:** `status` is `open|complete|expired`. `payment_status` is `paid|unpaid|no_payment_required`. For a free trial, `paid` means the $0 trial invoice was processed; `no_payment_required` is setup mode or a billing anchor with no proration. Since basil the subscription is created only after completion, and there is no invoice until `status=complete`.
- **Source:** CL/dahlia/2026-03-25/updates-available-checkout-session-ui-modes ; CL/endive/2026-09-30/remove-payment-method-types-checkout-sessions ; https://docs.stripe.com/tax/checkout/page ; https://docs.stripe.com/payments/checkout/free-trials.md?payment-ui=stripe-hosted ; https://docs.stripe.com/api/checkout/sessions/object ; CL/basil/2025-03-31/checkout-legacy-subscription-upgrade

## 8. Webhooks
- **Answer:** an endpoint renders snapshot payloads in **its own `api_version`** (or the account default), independent of the SDK. To change it you create a new endpoint; destinations set `snapshot_api_version` at creation only. `event.livemode` is a boolean (TYPES `Events.d.ts`). Snapshot `customer.subscription.*` events still work. **Thin events for v1 resources went GA in endive** (`v1.customer.subscription.updated`, unversioned, fetch via `related_object`). The upgrades and versioning pages still say "private preview", so those pages are stale.
- **Source:** https://docs.stripe.com/webhooks/versioning ; https://docs.stripe.com/upgrades ; CL/endive/2026-09-30/thin-events-for-api-v1-resources-generally-available

## 9. Customer portal
- **Answer:** `features.subscription_update.schedule_at_period_end.conditions[].type` = `decreasing_item_amount|shortening_interval`. `products` holds up to 10 entries of `{product, prices[], adjustable_quantity}`. Also `proration_behavior`, `billing_cycle_anchor (now|unchanged)`, `trial_update_behavior`. Period-end downgrades **only work between prices of the same product**: the portal creates a subscription schedule. Nothing found saying flexible mode lifts this restriction (UNCONFIRMED either way).
- **Source:** https://docs.stripe.com/customer-management/configure-portal ; TYPES `BillingPortal/Configurations.d.ts`

## 10. Other breaking changes on the listed calls
- `subscriptions.update`/`resume`: endive `billing_cycle_anchor` is an object `{type}`. CL/endive/2026-09-30/polymorphic-billing-cycle-anchor
- `subscriptions.cancel`: `cancellation_details.reason` gains `canceled_by_retention_policy` (dahlia). CL/dahlia/2026-03-25/adds-new-cancellation-reason-subscription-test-retention-policy
- `paymentIntents`/`setupIntents` create/update/confirm: `payment_method_types` is no longer writable (400 `payment_method_types_no_longer_supported`, endive); it stays readable on the object. CL/endive/2026-09-30/removes-the-payment-method-types-parameter-from-payment-intents-and-setup-intents
- Lists: `total_count` expansion removed (basil). CL/basil/2025-03-31/deprecate-total-count-expansion
- Discounts: the `coupon` property is replaced by `source`, and promotion codes reference coupons polymorphically (clover). CL/clover/2025-09-30/add-discount-source-property
- `invoices.voidInvoice`, `customers.list({email})`, `prices.list` expand `data.product`, `webhookEndpoints.list`: no breaking change found. Params are present in TYPES (UNCONFIRMED beyond that).

## 11. Version strings
- Latest is `2026-09-30.endive` (CL). stripe-node **23.0.0 (2026-09-30) pins `2026-09-30.endive`**. 22.3.0 pinned 2026-06-24.dahlia. 21.0.0 pinned 2026-03-25.dahlia. 19.0.0 pinned clover. 18.0.0 pinned basil. 17.7.0 pinned `2025-02-24.acacia`, so `2024-12-18.acacia` is an explicit override.
- SDK breaks: v22 requires `new Stripe()` (calling `Stripe()` as a function is gone). v23 drops Node 18, removes `ErrorType`, and `verifyHeader` now defaults the tolerance.
- **Source:** https://github.com/stripe/stripe-node/blob/master/CHANGELOG.md ; TYPES `esm/apiVersion.js`

## 12. dahlia + endive breaking changes touching our surface (GA only)
- 2026-03-25.dahlia: Checkout `ui_mode` enum; Stripe.js removal of `handleCardPayment`/`confirmPaymentIntent`/`handleCardSetup`/`confirmSetupIntent`; `initCheckout`->`initCheckoutElements`; embedded init renamed; retention-policy cancellation reason; `events_from` on event destinations becomes a string. CL/dahlia
- 2026-06-24.dahlia: no billing, checkout, portal or webhook breaks (the breaks are Treasury/Payouts only). CL/dahlia
- 2026-09-30.endive: `billing_cycle_anchor` object; `payment_method_types` removed from Checkout/PI/SI; Failed Tax Calculation error (Tax/Billing/Checkout); Stripe.js `canConfirm` false while updates pending; payment request button deprecated. CL/endive
- Preview-only, not GA: `billed_until` includable (2026-05-27.preview); Checkout `collected_information.tax_ids` -> `tax_id` (2026-07-29.preview). CL/dahlia

## Code impact
- Read period end from `sub.items.data[0].current_period_end`. For multi-item subscriptions take the max or min explicitly.
- Read the subscription id via `inv.parent?.type === 'subscription_details' ? inv.parent.subscription_details.subscription : null`.
- Never read `invoice.payment_intent`/`paid`. Use `status === 'paid'`, `expand: ['latest_invoice.confirmation_secret']`, and pass `confirmation_secret.client_secret` to `stripe.handleNextAction({clientSecret})`.
- Replace `invoices.retrieveUpcoming` with `invoices.createPreview({customer, subscription, subscription_details:{items, proration_behavior, proration_date}})`.
- Pass `billing_mode:{type:'classic'}` explicitly if you need acacia proration semantics; otherwise new subscriptions are flexible.
- Use `billing_cycle_anchor: {type:'unchanged'}` (object, endive), never the string.
- Schedules: `from_subscription` alone, then update with all phases; use `duration`, never `iterations`.
- Checkout: `ui_mode: 'hosted_page'` (or omit); no `payment_method_types`; trust the session only when `status==='complete'` and `payment_status` is `paid` or `no_payment_required`.
- Webhooks: create a new endpoint with `api_version: '2026-09-30.endive'`; payload shape follows the endpoint, not the SDK.
- Portal: keep cross-product downgrades in our own code (schedule); the portal can only schedule same-product downgrades.
- SDK: `new Stripe(key, {apiVersion: '2026-09-30.endive'})`, Node >= 20.
