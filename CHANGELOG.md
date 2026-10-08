# Changelog

## 0.1.1 (2026-10-08)

- Renamed from `saascribe-lincoln` to `saascribe`: the plugin, the marketplace and the repository
  (`azharul-lincoln/saascribe`). As a plugin the command is now `/saascribe:saascribe`.
- The post-payment page answers the same way whether or not an account exists, and sends a confirm link or a sign-in
  link by email. The account-check route is removed.
- Customer lookup never returns a row or customer that belongs to another user, even when the email matches. The first
  link writes `metadata.app_user_id` onto the Stripe customer, so the claim survives a change of the row's email.
- Docs: what the public checkout reveals, rate limits on public routes, and new go-live checks.

## 0.1.0 (2026-10-08)

First version.

- Skill `saascribe`: an eleven-step guide for Stripe subscription billing, with references for policy, state, checkout,
  webhooks, plan changes, cancellation and failed payments, billing screens, stack adapters, testing, go-live and
  Stripe API versions up to `2026-09-30.endive`.
- Optional reference implementation in TypeScript: pure rules, services, a Postgres schema, a Supabase adapter and a
  Web-standard HTTP handler, with tests that run on Node and Deno without network.
- Writes are ordered by a sync token taken before each Stripe read, so an older read can never overwrite a newer one.
- A downgrade released for an upgrade is held until the charge settles and put back when 3D Secure is abandoned
  (`abandon_payment`) or the pending update expires (`customer.subscription.pending_update_expired`).
- Unverified emails reach nothing: billing routes refuse a session whose email is not verified, the post-payment page
  creates an unconfirmed account and mails a confirm link instead of taking a password, and an anonymous checkout never
  overwrites an existing customer's details.
