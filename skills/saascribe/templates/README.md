# Reference implementation (optional)

Tested TypeScript that implements the guide. Use all of it, parts of it, or none: the references in `../references/`
describe the ideas independently of this code. Everything targets Stripe API `2026-09-30.endive` with `stripe` 23.x.

| Path | What | Depends on |
|---|---|---|
| `core/config.ts` | Plans, ranks, intervals, the `Policy` type and its defaults | nothing |
| `core/plan-catalog.ts` | Prices to plans, the selling price per plan and interval | `stripe` types |
| `core/subscription-state.ts` | `deriveState` and its predicates (paid for, abandoned, confirmed, scheduled change) | `stripe` types |
| `core/change-rules.ts` | `classifyChange`, `changeStep` (policy to Stripe parameters), preview validity, `cancelMode` | `stripe` types |
| `core/checkout-proof.ts` | Post-payment proof for both checkout flows | Web Crypto |
| `ports.ts` | The interfaces the services need (store, identity, mailer, mode, profile, logger) | |
| `services/*.ts` | Checkout, plan change, cancel and resume, webhook, post-payment, status, invoices, portal, profile, audit | `core`, `ports`, `stripe` |
| `adapters/sql/billing-schema.sql` | Postgres tables and the single writer as SQL functions | Postgres 13+ |
| `adapters/supabase/` | RLS and auth lookup SQL, store and identity over supabase-js, an edge function with every route | Supabase |
| `adapters/http/web-standard.ts` | All routes behind one `(Request) => Response` handler | Web APIs |
| `adapters/mode/env.ts` | One Stripe mode per deployment from environment variables | |

## Using it

1. Copy `core/`, `ports.ts`, `services/` and the adapters you want into the project, keeping the relative layout.
2. Fill in the plans and policy in a `validateConfig({...})` call (see `adapters/supabase/functions/billing/index.ts`).
3. Apply `adapters/sql/billing-schema.sql` (and `adapters/supabase/supabase-extras.sql` on Supabase) as a migration, or
   implement `SubscriberStore` on the project's own tables.
4. Wire routes with `adapters/http/web-standard.ts` or call the services from the framework's own handlers.
5. Replace the placeholder email delivery with a provider.

Edit freely: error messages, routes, the row shape, which services exist. Keep the tests running as you change the rules.

## Running the tests

From the package root (`npm install` first):

```
npm test            # node --test, Node 22.18 or later
npm run typecheck   # tsc strict
deno test --no-lock --allow-env skills/saascribe/templates/
```

The tests need no network and no database. The SQL was checked against a local Postgres 14; the supabase-js store and
the edge function were type-checked but not run against a live Supabase project, and no test calls the real Stripe API:
run the scenario list in `../references/testing.md` in a Stripe sandbox before relying on it.
