# Checkout and the first account

## Pick a checkout flow

| Flow | How | When it fits |
|---|---|---|
| **Checkout Sessions** (recommended by Stripe) | `checkout.sessions.create({ mode: "subscription", ui_mode: "hosted_page" or "embedded_page" })` | Most apps. Stripe handles the payment form, 3D Secure, trials, tax address collection, dynamic payment methods. |
| **Subscription first** | Create the subscription with `payment_behavior: "default_incomplete"` and `payment_settings.save_default_payment_method: "on_subscription"`, then confirm its setup intent (trial) or first payment with the Payment Element (`stripe.confirmSetup` / `stripe.confirmPayment`) | The checkout must live inside the app's own form, with fields Stripe Checkout does not collect. |

Do not pass `payment_method_types`; since `2026-09-30.endive` it returns 400 on Checkout Sessions, PaymentIntents and
SetupIntents. Since `2026-03-25.dahlia` the `ui_mode` values are `hosted_page`, `embedded_page`, `elements`, `form`.

## Keep it to one subscription per customer

Before creating anything, find the customer for the email (stored id first, then email) and list its subscriptions:

- **Any live, paid-for subscription:** refuse with a clear code (the reference uses 409 `already_subscribed`) and point
  to Billing, where plan changes happen. Refuse before updating the customer: this endpoint is usually public, and
  must not let anyone who knows an email change a paying customer's name or address.
- **Abandoned checkouts** (`incomplete`, or a trial whose setup intent never succeeded and that has no payment method):
  cancel them, with a cancellation comment your webhook treats as silent (no "cancelled" email).
- **Checkout Sessions:** reuse one customer per email and expire its other open sessions before creating a new one, so
  two tabs cannot both complete into two subscriptions.

A signed-in buyer pays for their own account: take the email from the session, not the form.

## Trials

- Sessions: `subscription_data.trial_period_days`, `subscription_data.trial_settings.end_behavior.missing_payment_method`,
  and `payment_method_collection` (`always` to require a card up front, `if_required` to allow none).
- Subscription first: `trial_period_days` and `trial_settings` on the subscription; the client secret comes from
  `pending_setup_intent`.
- Stripe now labels `trial_period_days` / `trial_end` free trials "legacy" and points new integrations to trial offers.
  Read https://docs.stripe.com/billing/subscriptions/trials/free-trials and decide with the developer; the rest of this
  guide works with either.
- "Confirmed" for a trial means a payment method is saved on the subscription (`default_payment_method`), not just that
  the subscription exists.

## Tax

With Stripe Tax: `automatic_tax: { enabled: true }`, and collect an address (`billing_address_collection: "required"`
and `customer_update: { address: "auto" }` on Sessions; required billing address in your own form otherwise).

## The post-payment page: create the account from proof, not from an email

Many apps take payment before the account exists. The page Stripe returns to then creates the account or signs the
person in. It has no session, so it needs another proof that this browser completed this checkout:

- **Subscription first:** Stripe's return URL carries the intent id and its client secret
  (`setup_intent` + `setup_intent_client_secret`, or the `payment_intent` pair). The secret is in the URL too, so it can
  leak through history the same way; the design below keeps a leaked proof harmless, and the nonce scheme from
  Sessions can be added (hash in the subscription metadata) if you want it tighter.
  Retrieve the intent, compare the secret in constant time, require `succeeded` (or `processing` for a payment), a
  customer, and a recent `created`.
- **Checkout Sessions:** `success_url` carries `{CHECKOUT_SESSION_ID}`, but a session id sits in the URL, history and
  referrers, so it is not a secret on its own. Give the browser a random nonce when it starts checkout (kept in
  `sessionStorage`), store only its hash in the session metadata, and require the nonce back. Then require
  `status: "complete"`, `mode: "subscription"`, a customer and a subscription.

Then act only on the email of that Stripe customer. An email in the URL is for display. Without valid proof, answer 403
and offer sign-in and support.

Hand nothing to the browser and answer the same way every time: "we sent a link to <email>". A new email gets a confirm
link (below); an existing account gets a sign-in link. Then a proof that leaks, or a buyer who typed someone else's
email, only ever sends that inbox a link, and the page never reveals whether an account exists.

The proof shows who paid, not who owns the email they typed. Do not create a confirmed account with a password from it:
anyone could pay with someone else's email and hold a confirmed account in that person's name, which their later
sign-in, password reset or OAuth login then joins (account pre-hijacking). Create the account unconfirmed and without a
password, mail a one-time link to the customer email, and ask for the password on the page the link opens. Another
choice is to verify the email (a code) before checkout, then a confirmed account is safe.

## What the public checkout reveals

Refusing an email that already pays (409 `already_subscribed`) tells an anonymous caller that the address has a plan.
That is the price of never charging someone twice, much like "this email is already registered" on a signup form. Rate
limit the public checkout endpoints, per IP and per email. If that disclosure matters for your product, answer
anonymous callers the same way every time and send the "you already have a plan, sign in" message by email instead.

## Verified email on every billing route

Billing finds the Stripe customer by email when no customer id is stored yet. A signed-in user whose email is not
verified would then reach whoever really owns that address: their plan, their invoices, their cancel button. Refuse
unverified users on every billing route, checkout included (the reference: `BillingUser.emailVerified`, 403
`email_unconfirmed`).

## Anonymous checkout and an existing customer

The checkout endpoint is public. When the typed email matches an existing customer with no paid plan, reuse it (so
retries do not pile up customers) but never overwrite its name or address: fill only what is empty, and on Checkout
Sessions send `customer_update` only for empty fields. A signed-in, verified buyer may update their own customer. Look up an existing account directly by email (a paged admin list misses accounts past
the first page).

Reference: `templates/core/checkout-proof.ts`, `templates/services/checkout.ts`, `templates/services/post-payment.ts`.

## Docs

- Build a subscriptions integration: https://docs.stripe.com/billing/subscriptions/build-subscriptions
- Checkout free trials: https://docs.stripe.com/payments/checkout/free-trials
- Checkout Session object: https://docs.stripe.com/api/checkout/sessions/object
- Stripe Tax in Checkout: https://docs.stripe.com/tax/checkout
