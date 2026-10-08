---
name: saascribe
description: Use when adding or reworking Stripe subscription billing in a SaaS app, including checkout, plan upgrades and downgrades, monthly and yearly switches, trials, billing state in the app's database, Stripe webhooks, cancellation, failed or past-due payments, a billing page, or a Stripe go-live check, on any stack or database.
---

# SaaScribe: Stripe subscriptions for SaaS apps

A guide for building subscription billing on Stripe Billing, distilled from a production app. It suggests an order of
work, explains the trade-offs, and points out where integrations usually break. It is not a framework: the developer
decides, and everything should fit the project's own stack and conventions.

## How to work with this skill

- **Start from the project.** Read the existing billing code, database, auth, routing, tests and conventions before
  proposing anything. Extend what exists rather than replacing it.
- **Put decisions to the developer.** Each step lists the choices that matter, with a recommended default and what
  follows from it (`references/policy.md` collects them). Ask, record the answers somewhere the team will find them
  (a `BILLING.md`, an ADR, the project docs), then build.
- **Work in small, verified steps.** Finish one step, test it in Stripe test mode, show the developer, then move on.
- **Check Stripe's current docs before writing Stripe calls.** Stripe changes fields and defaults between API versions.
  Each reference lists the pages to read. Where the docs and this skill disagree, follow the docs and tell the developer.
  `references/api-versions.md` covers what moved up to `2026-09-30.endive`.
- **Reuse the reference code only if it helps.** `templates/` holds a tested TypeScript implementation (pure rules,
  services, a SQL schema, a Supabase adapter). Copy it, adapt parts, or just read the logic. See `templates/README.md`.

## Ideas that keep the design sound

These are recommendations with reasons, not rules. A project may choose otherwise, knowingly.

1. **Derive billing state from all of the customer's subscriptions,** and write the app's billing row in one place.
   Event order, replays and a duplicate subscription then cannot leave the row wrong.
2. **Read the plan from the price,** through a catalog keyed by product metadata. Subscription metadata goes stale.
3. **One subscription per customer.** A plan change updates it; checkout refuses an email that already pays.
4. **Stripe is the source of truth.** The webhook verifies signatures, re-reads objects and recomputes; it never
   patches the row from one payload.
5. **Test and live never mix.** Each mode has its own keys and webhook secret, and events from the inactive mode are
   acknowledged and dropped.

## Steps

The files in the "Read" column are in `references/`.

| # | Step | Goal | Read |
|---|---|---|---|
| 1 | Understand the app | Stack, plans, existing billing code and data, Stripe account state, who the customers are | this file |
| 2 | Decide the policy | Upgrade, downgrade, trial, past-due, cancel, intervals, tax, mode strategy | `policy.md` |
| 3 | Model plans in Stripe | One product per plan (or per family), prices per interval, a catalog in code | `state-model.md` |
| 4 | Billing state and storage | Row shape, single writer, customer lookup, outage behavior | `state-model.md`, `adapters.md` |
| 5 | Checkout and first account | Checkout Sessions or subscription-first, duplicate guard, post-payment proof | `checkout.md` |
| 6 | Webhook | Signature, mode filter, re-read and recompute, deduped emails | `webhooks.md` |
| 7 | Upgrades and downgrades | Preview, apply, 3D Secure, decline handling, scheduled downgrades, undo, the plan picker and confirm dialog | `plan-changes.md` |
| 8 | Cancel and failed payments | Cancel modes, resume, past-due access, retries, voiding what is owed | `failed-payments.md` |
| 9 | Billing page | Status, banners, plan picker, invoices, portal link, cancel dialog | `frontend.md` |
| 10 | Test | Unit rules, Stripe sandbox with test clocks, scenario list | `testing.md` |
| 11 | Go live | Dashboard settings, live catalog, webhooks, keys, data reset, audit | `go-live-checklist.md` |

Steps 5 to 9 can be built in another order. Step 7 is the most involved; give it its own review.

## Traps seen when building this without the skill

A baseline agent given the same task got the basics right (plan from price, signature check, preview with the same
`proration_date`) and missed these:

- Tracked one subscription id per row, so a customer billed twice went unnoticed.
- Price ids from environment variables: an archived price made every webhook for those customers fail.
- No test/live separation in the webhook.
- A declined or 3D Secure upgrade left an open invoice that could be charged hours later.
- Cancelling while past due kept retrying the unpaid invoice, so a customer who cancelled was still charged.
- Checkout could create a second subscription for an email that already paid.
- No proof of checkout on the post-payment page, so anyone could create an account for someone else's email.
- Trusted an unverified email: a session with an unconfirmed address, or an account confirmed just because someone paid
  with that address, reaches the real owner's Stripe customer (`checkout.md`).
- Chose the downgrade policy because it was easier to build, without asking.

## Reference implementation

`templates/README.md` maps the files: `core/` (pure rules with tests), `services/` (Stripe and database logic behind
small interfaces in `ports.ts`), `adapters/sql` (Postgres schema with the single writer as a SQL function),
`adapters/supabase`, `adapters/http/web-standard.ts`. Tests run with `node --test` or `deno test`, no network.
