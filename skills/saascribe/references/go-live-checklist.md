# Go-live checklist

Do these in the live account (and once in test mode, so staging matches). Stripe moves dashboard screens now and then;
look for the same setting if a label differs.

## Account

- [ ] Account activated for live payments (business details, bank account, identity).
- [ ] Public business name, support email and statement descriptor set; customers see them on receipts and bank statements.
- [ ] Two-factor authentication on for everyone with dashboard access.

## Catalog

- [ ] One live product per plan with the plan metadata key, and exactly one active price per interval sold.
- [ ] Test-mode products are not copied by hand with different ids that the code hard-codes (the catalog reads metadata).

## Keys and secrets

- [ ] Live restricted key (`rk_live_`) with only the billing permissions (`adapters.md`), stored as a server secret.
- [ ] Live webhook signing secret stored; test secrets remain for staging.
- [ ] The live mode is selected (environment variable or settings row) only after the above exist; a missing live secret
      should fail loudly, never fall back to test.

## Webhooks

- [ ] A live endpoint to the production webhook URL, created on the code's API version, with exactly the handled events.
- [ ] A test endpoint for staging. If both post to one URL, the inactive mode's events are dropped (`webhooks.md`).

## Public endpoints

- [ ] Checkout and post-payment routes are rate limited per IP and per email.
- [ ] Billing routes refuse users whose email is not verified (`checkout.md`).

## Customer portal

- [ ] Payment method update and invoice history on; customer information as wanted.
- [ ] Plan switching and cancellation off if the app owns them; otherwise configured to match the policy.
- [ ] Business links (terms, privacy) set.

## Billing settings

- [ ] Smart Retries on; "if all retries fail" cancels the subscription or marks it unpaid.
- [ ] Customer emails: decide which Stripe sends (receipts, failed payments, upcoming renewal, card expiring) so they do
      not duplicate the app's.
- [ ] Stripe Tax registrations and settings, if tax is on.

## Data

- [ ] Rows created in test mode no longer grant access in production: recompute or reset them (keep a snapshot first).
- [ ] Stored test customer ids are harmless (they read as missing in live mode and fall through to email), but decide
      whether to clear them.

## Final check

- [ ] Run the audit in live mode: settings problems at zero, catalog healthy.
- [ ] One real checkout with a real card on the cheapest plan, then cancel and refund it from the dashboard.
- [ ] Watch the webhook endpoint's delivery log for the first day.
