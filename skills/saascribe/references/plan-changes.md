# Upgrades, downgrades and plan switches

The most involved part of subscription billing. This file walks through the backend, the UI and the tests for changing
the plan of an existing subscription. It describes one sound design and its alternatives; the developer chooses.

**Before writing code, read Stripe's current pages** and compare them with this file. Stripe changes parameters and
defaults between API versions (this file reflects `2026-09-30.endive`, checked 2026-10-08). Where they differ, follow
Stripe and tell the developer what changed.

- Change the price: https://docs.stripe.com/billing/subscriptions/change-price
- Prorations: https://docs.stripe.com/billing/subscriptions/prorations
- Pending updates: https://docs.stripe.com/billing/subscriptions/pending-updates
- Subscription schedules: https://docs.stripe.com/billing/subscriptions/subscription-schedules
- Billing mode (classic and flexible): https://docs.stripe.com/billing/subscriptions/billing-mode/compare
- Invoice preview: https://docs.stripe.com/api/invoices/create_preview
- Subscription update: https://docs.stripe.com/api/subscriptions/update
- Customer portal configuration: https://docs.stripe.com/customer-management/configure-portal
- Changelog: https://docs.stripe.com/changelog

## The kinds of change

| Kind | Example | Default handling | Alternatives |
|---|---|---|---|
| Upgrade | Basic to Pro; Pro monthly to Pro yearly | Now; charge the prorated difference now; plan unchanged if the charge fails | Now, difference on the next invoice |
| Downgrade | Pro to Basic; Pro yearly to Pro monthly | At the end of the paid period, through a subscription schedule; no refund | Now, with credit on the next invoice |
| Trial switch | Any change while trialing | Now, free, trial end unchanged | End the trial and charge the new plan now |
| Keep current plan | Undo a scheduled downgrade | Release the schedule | |

**Up or down:** compare plan ranks, and intervals if you sell both. A practical rule: a plan at least as big on an interval
at least as long moves up (Pro monthly to Pro yearly, Pro monthly to Team yearly); anything else moves down, because the
customer has already paid for the longer or bigger term.

**When to refuse** (each with its own error code and message, so the UI can say what to do next):

| Situation | Why |
|---|---|
| No live subscription | Nothing to change; send to checkout |
| More than one paid subscription | A duplicate; changing one leaves the other billing. Support resolves it first |
| `past_due` or `unpaid` | The card failed; fix the payment first |
| Set to cancel | Resume first, then change |
| More than one item | The flow assumes one plan price per subscription |
| Same plan and interval | Nothing to do (unless a downgrade is scheduled: then it means "keep") |
| Target already scheduled | The change is already on its way |

Reference: `templates/core/change-rules.ts` (`classifyChange`, `changeStep`, `isProrationDateUsable`).

## Backend shape

One endpoint (or four) behind the user's session. Nothing in the request identifies the account; it comes from the session.

| Action | Input | Output |
|---|---|---|
| `preview` | target plan and interval | kind, amount due now, tax, when it takes effect, next charge date and amount, and a `proration_date` for charge-now changes |
| `apply` | target, a client `requestId`, the preview's `proration_date` | `applied`, `scheduled`, or `requires_action` with a client secret, or an error code |
| `cancel_scheduled_change` | `requestId` | `change_cancelled` |
| `sync` | | the recomputed state, after 3D Secure |
| `abandon_payment` | `requestId` | `payment_abandoned` after the customer closed or failed 3D Secure |

Every action ends by recomputing the billing row from Stripe (`state-model.md`) and returning it, so the page can render
the new state without waiting for the webhook.

Reference: `templates/services/change-plan.ts`.

## Preview

```ts
const prorationDate = Math.floor(Date.now() / 1000);
const invoice = await stripe.invoices.createPreview({
  customer,
  subscription: sub.id,
  subscription_details: {
    items: [{ id: item.id, price: target.id, quantity: item.quantity ?? 1 }],
    proration_behavior: "always_invoice",          // the same value apply will use
    proration_date: prorationDate,                 // not with proration_behavior "none", not with an anchor reset
    // billing_cycle_anchor: { type: "now" },      // only when the interval changes (see below); then drop proration_date
  },
  // automatic_tax: { enabled: true },             // if Stripe Tax is on
});
```

- Stripe prorates to the second. Return `prorationDate` to the browser and require the same value on `apply`, so the
  charge equals what the customer saw. Refuse a stale one (the reference allows 15 minutes; Stripe itself only requires
  the date to fall inside the current period and the current schedule phase).
- Proration lines are those with `line.parent.subscription_item_details.proration === true` (since basil; there is no
  `line.proration` any more). For a same-interval upgrade, the amount due now is the sum of proration lines, or
  `amount_due` when the preview holds nothing else (that also reflects tax and credit balance).
- With an anchor reset (interval change) or a trial ended now, the whole preview invoice is due now. Checked in a
  sandbox with test clocks: monthly $10 to yearly $100 previewed and charged $90; a trial ended into a $30 plan
  previewed and charged $30.
- Stripe refuses `proration_date` together with `billing_cycle_anchor: { type: "now" }` ("You cannot specify
  `proration_date` when `billing_cycle_anchor=now`"). For an interval change, send neither on the preview nor on the
  update; Stripe prorates to the second of the update, so the charge can differ from the preview by about a cent. Keep
  the preview TTL check anyway.
- For a scheduled downgrade there is nothing to preview from Stripe: amount due now is 0, the new price starts at the
  current period end.

## Apply: upgrade, charged now

1. Re-check the preview's `proration_date`.
2. If a downgrade is scheduled, hold it somewhere durable, then release the schedule (a subscription managed by a
   schedule should not be updated directly). The charge may not settle in this request (3D Secure, an abandoned tab),
   so memory is not enough: the reference keeps it in a `held_change` column on the billing row, outside the mirrored
   fields. If a stale `pending_update` exists from an earlier failed attempt, void its open invoice.
3. Update:

```ts
const updated = await stripe.subscriptions.update(sub.id, {
  items: [{ id: item.id, price: target.id, quantity: item.quantity ?? 1 }],  // keep the item id, or Stripe adds a second item
  proration_behavior: "always_invoice",
  proration_date,
  payment_behavior: "pending_if_incomplete",       // a failed charge leaves the plan unchanged
  // billing_cycle_anchor: { type: "now" },        // interval change only, and then without proration_date
  metadata: { plan: "pro" },                      // optional, for humans; the plan is read from the price
  expand: ["latest_invoice.confirmation_secret"],
}, { idempotencyKey: `change-plan:${userId}:${requestId}:upgrade` });
```

Pending updates accept only some parameters: items (price, quantity, discounts), `proration_behavior`,
`proration_date`, `billing_cycle_anchor`, `trial_end`, `trial_from_plan`, `metadata`, discounts and a few more. Not
`automatic_tax` and not `default_payment_method`; set those on the subscription separately.

4. Read the outcome:

| Result | Meaning | Do |
|---|---|---|
| No `pending_update` on the returned subscription | Paid; the plan changed | Recompute the row; answer `applied` |
| `pending_update` and the invoice's PaymentIntent is `requires_action` | The bank wants 3D Secure | Answer `requires_action` with `latest_invoice.confirmation_secret.client_secret` |
| `pending_update`, any other PaymentIntent status | Declined | See below |

The PaymentIntent's status is not on the invoice. Retrieve it: the invoice's `payments` list (expand `latest_invoice.payments`)
holds its id; a deeper expand exceeds Stripe's four-level limit.

**3D Secure.** The browser calls `stripe.handleNextAction({ clientSecret })` (Stripe.js; it throws if the
PaymentIntent is not `requires_action`), then calls `sync`. A successful payment applies the pending update. Poll
`sync` briefly if the webhook has not landed yet. `invoice.paid` and `customer.subscription.pending_update_applied`
confirm it server-side; drop the held downgrade then, because the upgrade replaced it.

**Abandoned 3D Secure.** The customer closes the dialog, the challenge fails, or the tab dies. Stripe keeps the
pending update and its open invoice for about 23 hours, and the downgrade you released is gone in the meantime. Two
paths put it back, and the held downgrade must be handed to only one of them (take it and clear it atomically):

- The browser calls `abandon_payment` when `handleNextAction` errors or the dialog closes: void the invoice (this
  discards the pending update), then restore the held downgrade. If the void fails because the invoice was paid a
  moment ago, the upgrade stands; drop the hold.
- `customer.subscription.pending_update_expired` is the backstop when the browser never calls: Stripe has voided the
  invoice; restore the held downgrade.

Before restoring, re-read the subscription and skip if it moved on (ended, set to cancel, a new schedule, or a charge
still pending). A new downgrade, "keep my plan" or a successful upgrade replaces the hold. Reference:
`restoreHeldChange` in `templates/services/change-plan.ts`.

**Declined.** Two reasonable choices; pick one with the developer:

- **Leave the account exactly as it was** (reference): void the invoice, which discards the pending update, and put back
  the held downgrade schedule. The customer updates the card and tries again from a fresh preview.
- **Let them retry the same charge:** keep the invoice open, collect a new payment method, attach it, then
  `invoices.pay`. Paying applies the update. Stripe voids the invoice itself when the pending update expires (about 23
  hours, sooner if the period or trial ends first) and sends `customer.subscription.pending_update_expired`.

Either way, do not send the "payment failed" email for this invoice: the dialog has already told the customer, and
`invoice.payment_failed` also fires for 3D Secure (`webhooks.md`).

## Apply: upgrade with the difference on the next invoice

`proration_behavior: "create_prorations"`, no `payment_behavior`, no preview TTL. Nothing can be declined today; the
customer gets the bigger plan before paying for it. Show the preview's proration lines as "added to your next invoice".

## Apply: downgrade at period end

Stripe's recipe, in two calls:

```ts
// 1. Create a schedule from the subscription. Nothing else may be set in this call.
const schedule = await stripe.subscriptionSchedules.create({ from_subscription: sub.id });
const current = schedule.phases[0];

// 2. Replace the phases. Anything left out is unset, so re-send every setting you rely on.
await stripe.subscriptionSchedules.update(schedule.id, {
  end_behavior: "release",                       // the default; the subscription continues on its own afterwards
  phases: [
    {
      items: [{ price: currentPriceId, quantity }],
      start_date: current.start_date,
      end_date: current.end_date,
      default_payment_method,                      // or the first renewal on the new plan has no card
      discounts: discountIds,                      // the current phase's coupons, as ids; omitting them ends the discount
      metadata: sub.metadata,
      proration_behavior: "none",
      // automatic_tax: { enabled: true },
    },
    {
      items: [{ price: targetPriceId, quantity }],
      duration: { interval: targetInterval, interval_count: 1 },  // `iterations` was removed in 2025-09-30.clover
      default_payment_method,
      discounts: discountIds,
      metadata: { ...sub.metadata, plan: "basic" },
      proration_behavior: "none",
    },
  ],
});
```

- If the subscription already has an active schedule, update that one instead of creating another.
- The schedule stays attached through its last phase after the change has happened. "A change is pending" therefore
  means a phase that has not started yet, not "a schedule exists".
- A phase transition discards any pending update; do not mix a scheduled downgrade with an open upgrade charge.
- Trialing subscriptions would need `trial_end` on each phase; the default policy treats trial changes as trial switches
  instead, so this does not arise.

**Keep my plan:** `subscriptionSchedules.release(schedule.id)`. The subscription stays on its current price.

## Apply: downgrade now, with credit

`subscriptions.update` with the new price and `proration_behavior: "create_prorations"`. Unused time becomes a credit on
the next invoice. Simple, but customers can downgrade, keep the credit and upgrade again; decide whether that matters.

## Trial switches

- **Free, keep the trial:** update the price with `proration_behavior: "none"` and no `proration_date` (Stripe refuses the
  pair). The trial end stays; the first invoice uses the new price.
- **End the trial and charge:** `trial_end: "now"` with `payment_behavior: "pending_if_incomplete"`. Ending a trial
  always produces a full-period invoice, so the proration setting is not what triggers the charge. Handle 3D Secure and
  declines as for an upgrade.
- Stripe now labels `trial_end`-based free trials "legacy" and points new integrations to trial offers. Check
  https://docs.stripe.com/billing/subscriptions/trials/free-trials before building trials from scratch.

## Monthly and yearly

- Under **flexible** billing mode (the default for new subscriptions since 2025-09-30.clover) Stripe never resets the
  billing anchor on its own. Send `billing_cycle_anchor: { type: "now" }` (an object since endive) on an interval change
  made now, in both the preview and the update, and leave `proration_date` out of both (Stripe refuses the pair). Under **classic** mode an interval change resets the anchor and charges
  immediately even with `proration_behavior: "none"`.
- Year to month waits for the end of the paid year, through the schedule recipe above with a monthly `duration`.
- Existing subscriptions created before a project moved to flexible stay classic; test both if you have both.

## Idempotency and concurrency

- The browser generates a `requestId` per dialog opening; derive idempotency keys from it per Stripe call
  (`...:upgrade`, `...:schedule:create`, `...:schedule:update`). A double click then applies once.
- Re-read the subscription state at the start of every action; never trust the state the dialog was opened with.

## Webhook side

- `customer.subscription.updated` with `previous_attributes.items` and a different plan is the authoritative "plan
  changed" signal, for a change made now and for a scheduled downgrade reaching its date. Send the "plan changed" email
  from there (dedupe by event id), and the "downgrade scheduled" email from `apply` (dedupe by schedule and date).
- Recompute the row on every subscription event, as everywhere else.

## Should the Stripe customer portal do this instead?

The portal can switch plans with its own proration settings and can schedule period-end downgrades
(`schedule_at_period_end` with `decreasing_item_amount` or `shortening_interval`). But period-end downgrades work only
between prices of the **same product**, its trial behavior defaults to ending the trial, and it shows Stripe's UI.

- All plans are prices of one product and the portal's behavior matches the policy: the portal is enough; turn on
  `subscription_update` with the products and prices allowed.
- One product per plan, a free trial switch, or an in-app experience: build the flow above and turn plan switching
  off in the portal, so there are not two ways to change plans with different rules.

## UI

**Plan picker** (on the billing page; the same cards as pricing):

| State of a card | Button |
|---|---|
| Current plan, nothing scheduled | "Current plan", disabled |
| Current plan, downgrade scheduled | "Keep <plan>" (calls apply with the current plan, or `cancel_scheduled_change`) |
| The scheduled target | "Starts <date>", disabled |
| Bigger | "Upgrade" |
| Smaller | "Downgrade" |
| Any, while trialing | "Switch" |
| Any, while blocked (past due, set to cancel, duplicate) | Disabled, with the reason and the fix |

**Confirm dialog:** open it with a fresh `requestId`, load the preview, then state plainly:

- what changes and when ("Pro starts now" / "Basic starts on 12 March");
- what is charged today, tax shown if any ("$32.40 today, the prorated difference for the rest of this month");
- the next charge date and amount;
- for a downgrade, what the customer loses and that there is no refund;
- for a trial switch, that nothing is charged and the trial end is unchanged.

**After confirm:**

1. `applied` or `scheduled`: refresh the billing state, close, confirm.
2. `requires_action`: run `handleNextAction`; on success call `sync` (poll a few times); on failure or when the customer
   closes the dialog, call `abandon_payment`, then say the bank did not confirm and nothing changed.
3. `preview_expired`: reload the preview and say the amount was updated.
4. `payment_failed`: say the card was declined and the plan is unchanged; offer "update card".
5. Any other error code: show its message; it already says what to do.

Copy for every sentence about timing and money comes from the policy decisions; review it whenever a decision changes.

## Tests

From `testing.md`, the plan-change rows: upgrade succeeds (amount equals the preview), upgrade declines (plan unchanged,
invoice void, scheduled downgrade still there), 3D Secure, 3D Secure abandoned with a downgrade scheduled (downgrade
back, invoice void), downgrade scheduled and applied by advancing a test clock,
"keep plan", trial switch, monthly to yearly. Add unit tests for the classification and policy mapping before touching
Stripe; `templates/core/subscription-state.test.ts` has a set to start from.
