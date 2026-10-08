# Run with the skill (GREEN), 2026-10-08

Setup: same scratch app and the same task prompt as the baseline (`baseline-findings.md`), in a fresh copy at
`/tmp/saascribe-green`. Fresh `claude -p` with `--plugin-dir` pointing at this repository, tools limited to
`Read Write Edit Glob Grep Skill WebFetch` (no Bash, so the agent could not run tests or `tsc` itself).
The task covers plan changes, the webhook, cancellation and failed renewals. It does not ask for checkout.

Output: `DECISIONS.md`, one migration, `supabase/functions/{billing,stripe-webhook}`, `_shared/billing/` (core,
services, store, 34 tests) and `src/billing/` (billing page, change-plan and cancel dialogs).

## Checked afterwards (by us, not by the agent)

- `deno test --no-check`: 34 passed, 0 failed.
- `deno check`: **5 type errors**, all one bug. `BillingUser` is `{ id, email }`, but `resolveCustomer` takes
  `{ userId, email }`. At runtime `userId` is `undefined`, so the stored-row lookup falls back to email only. The
  agent's own fake store hid it. A typecheck would have caught it; the agent had no permission to run one.

## Baseline gaps, row by row

| # | Gap | GREEN | Evidence |
|---|---|---|---|
| 1 | One subscription id per row | Pass | `sync.ts:40` lists `status: "all"`; `state.ts:143` `paidLiveCount`; `rules.ts:30` refuses `multiple_subscriptions`; UI banner `BillingPage.tsx:181` |
| 2 | Price ids from env vars | Pass | `catalog.ts:14` maps every price from product metadata, archived included |
| 3 | No test/live separation | Pass | `webhook.ts:57` drops events whose `livemode` disagrees with the key's mode |
| 4 | Declined or 3DS upgrade leaves an open invoice | Pass, one limit | `pending_if_incomplete` (`change-plan.ts:149`), `confirmation_secret` + `handleNextAction` (`ChangePlanDialog.tsx:64`), void on decline, released downgrade restored (`change-plan.ts:174`). Limit: an abandoned 3DS step does not restore the downgrade (see below) |
| 5 | Policy chosen for convenience | Partial | Every policy is written in `DECISIONS.md` with a reason, and the downgrade is the period-end schedule with undo. It is presented as decided, not as defaults for the owner to confirm. The prompt told the agent to make its own decisions, and `-p` mode cannot ask, so this is expected |
| 6 | Past-due cancel keeps retrying | Pass | `DECISIONS.md` cancellation table; `cancel.ts` voids open invoices after cancelling now |
| 7 | No checkout guard | Not in scope | The task does not cover checkout |
| 8 | No emails, no dedupe | Pass (decided) | App has no email provider; Stripe's own emails are switched on and the app sends none, so nothing is sent twice |
| 9 | Webhook 500 until a row with `user_id` exists | Pass | Sync is keyed by customer and email (`sync.ts:79`); 500 only on real failures |
| 10 | No post-payment proof, portal check or audit | Partial | Portal plan switching and cancellation off, written into setup. Post-payment proof is out of scope (no checkout). No audit |
| 11 | API version picked silently | Pass | `2026-09-30.endive` + stripe-node 23, with the field moves and the webhook endpoint version written down |
| 12 | Ordering by event timestamp | Different | A DB sequence token taken before reading Stripe; the writer refuses an older token. This closes a real race (two concurrent reads, the older one written last) that recompute alone does not |

Beyond the baseline: `customer.updated` moves subscriptions onto the new default card and retries the open invoice;
an unconfirmed-email guard on billing routes; RLS that removes browser writes; a Stripe-outage fallback.

## Findings for the skill (addressed 2026-10-08, see the end of this file)

1. **Abandoned 3D Secure after a released downgrade.** If the customer closes the 3DS step, the pending update expires
   about 23 hours later and the downgrade they had scheduled is gone. `plan-changes.md` and
   `templates/services/change-plan.ts` both have the same gap. The GREEN agent spotted it and listed it as a known limit.
2. **Concurrent sync writes.** Recompute-on-every-write still lets an older Stripe read land after a newer one when two
   webhooks race. `state-model.md` does not mention it; `billing-schema.sql` serializes the write but does not
   compare read order. The GREEN agent's sync token is one answer.
3. **Run the typecheck.** The only bug found was a type error. `testing.md` could say plainly that a fake-Stripe suite
   does not replace `tsc` / `deno check`.

## What changed after this run

1. Held change: the released downgrade is stored on the billing row (`held_change`, via `billing_hold_change` /
   `billing_take_held_change`) before release, and put back by `abandon_payment` from the browser or by the
   `customer.subscription.pending_update_expired` webhook. Covered in `plan-changes.md` and by two service tests.
2. Sync token: `billing_next_sync_token()` before every Stripe read (`readFresh`), and `billing_save_subscriber`
   refuses a lower token. Covered in `state-model.md`, one service test, and a Postgres check.
3. `testing.md` now says a fake-Stripe suite does not replace the type checker.
