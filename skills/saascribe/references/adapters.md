# Fitting the design to a stack

The reference code talks to the outside world through a few small interfaces (`templates/ports.ts`). Implement only
the ones you need, in whatever the project already uses. Or skip the interfaces and write the logic directly against
your stack; the ideas in `state-model.md` and `webhooks.md` are what matter.

| Port | Job | Notes for common stacks |
|---|---|---|
| `SubscriberStore` | Find and save the billing row; list rows for the audit | Any Postgres client or ORM can call the SQL functions in `adapters/sql/billing-schema.sql` (`billing_find_subscriber`, `billing_save_subscriber`, `billing_next_sync_token`, `billing_hold_change`, `billing_take_held_change`). With Prisma: `prisma.$queryRaw`. With Drizzle: `db.execute(sql\`...\`)`. If you prefer ORM code over a SQL function, keep the same behavior: find by user, customer, then email; update or insert in a transaction; refuse a write whose `syncToken` is below the row's; retry once on a unique violation; take the held change and clear it in one statement. MySQL and SQLite: same logic, with a unique index on the lowercased email. |
| `Identity` | Find an account by email; after payment, create an unconfirmed account with no password and return a confirm link | Supabase Auth (reference), Auth.js, Clerk, Better Auth, a users table. Look up by email directly; avoid paged admin lists. |
| `Mailer` | Send lifecycle emails once per dedupe key | Wrap any provider (Resend, Postmark, SES, SendGrid) with a dedupe table: insert the key, send, delete the key if delivery fails. |
| `ModeSource` | Active Stripe mode and each mode's secrets | `adapters/mode/env.ts` (one mode per deployment) or a settings row (`adapters/supabase/store.ts`, `supabaseDbModeSource`). Must throw when unreadable. |
| `ProfileStore` | Optional account-details sync | Any table keyed by user id with an updated-at time. |

## HTTP

`adapters/http/web-standard.ts` turns the services into one `(Request) => Response` handler with routes such as
`change-plan` and `webhook`. It runs as is on Deno, Supabase Edge Functions, Bun, Hono, Cloudflare Workers and Next.js
route handlers (`export async function POST(req: Request) { return handle(req, "change-plan"); }`).

Express needs the raw body for the webhook: mount `express.raw({ type: "application/json" })` on the webhook route
before any JSON parser, then build a `Request` from it, or call `handleWebhook(deps, req.body.toString("utf8"),
req.headers["stripe-signature"])` directly.

Whatever the framework, keep: the webhook route unauthenticated but signature-checked; checkout and post-payment
routes public; everything else behind the app's session; the audit admin-only; CORS limited to the app's origins.

## Runtime notes

- Deno and edge runtimes: import with `npm:stripe@^23` (or an import map), and pass `Stripe.createSubtleCryptoProvider()`
  for webhook verification.
- Create the Stripe client in one module with the pinned API version (`templates/services/stripe-client.ts`), so every
  call uses the same version and object shapes.
- Use a restricted key (`rk_`) with only the permissions the billing code needs: write on Customers, Subscriptions,
  Subscription schedules, Invoices, Checkout Sessions, Customer portal, SetupIntents, PaymentIntents; read on Prices,
  Products, Webhook endpoints.
