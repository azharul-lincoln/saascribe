# SaaScribe

A Claude Code skill for building Stripe subscription billing into a SaaS app: checkout, plan upgrades and downgrades,
monthly and yearly switches, trials, billing state in your database, the Stripe webhook, cancellation, failed payments,
the billing page, testing and go-live.

It is a guide, not a framework. Claude reads your project first, puts the policy decisions to you with a recommended
default for each, and builds in small steps that you test as you go. It works with any stack and database. An optional,
tested TypeScript reference implementation is included for teams that want a head start.

Distilled from the billing of a production SaaS. Targets Stripe API `2026-09-30.endive` (stripe-node 23).

## What you get

- **Policy decisions, laid out:** upgrade charge timing, downgrade at period end or now, trial switches, access while a
  renewal fails, cancel behavior, intervals, tax, test and live separation.
- **Upgrades and downgrades end to end:** price preview, charge now with 3D Secure in the browser, decline handling that
  leaves the plan unchanged, period-end downgrades through subscription schedules, "keep my plan", and the plan picker and
  confirm dialog.
- **Billing state you can trust:** derived from all of a customer's subscriptions and written in one place, so webhook
  order, replays and duplicate subscriptions cannot leave it wrong.
- **A hardened webhook:** signature checks, test and live separation, objects re-read in your API version, emails with
  dedupe keys.
- **Safe checkout:** one subscription per customer, abandoned checkout cleanup, and post-payment account creation that
  requires proof of the checkout.
- **Testing and go-live:** a test-mode scenario list with test clocks and cards, and a dashboard checklist.

## Install

Pick one of the two; installing both loads the skill twice.

As a plugin (recommended, gets updates). The slash command is `/saascribe:saascribe`:

```
/plugin marketplace add azharul-lincoln/saascribe
/plugin install saascribe@saascribe
```

As a personal skill, for a plain `/saascribe` command:

```
git clone https://github.com/azharul-lincoln/saascribe.git
ln -s "$(pwd)/saascribe/skills/saascribe" ~/.claude/skills/saascribe
```

Either way Claude also picks the skill up on its own when you ask for subscription billing work.

## Use

In your app's repository, start Claude Code and ask for what you need, for example "add Stripe subscriptions with
in-app upgrades and downgrades", or run the skill's slash command. Claude will read the project, ask you the policy
questions, and work through the steps in `skills/saascribe/SKILL.md`.

## Layout

```
skills/saascribe/
  SKILL.md          the guide: steps, ideas, common traps
  references/       one file per topic, read on demand
  templates/        optional reference implementation with tests (see templates/README.md)
research/           notes from building the skill: Stripe API changes, runs with and without the skill, and
                    sandbox-e2e.ts, which runs the reference services against a real Stripe sandbox
```

## Developing the reference code

```
npm install
npm test            # Node 22.18+
npm run typecheck
deno test --no-lock --allow-env skills/saascribe/templates/

# Against your own Stripe sandbox (never live): put STRIPE_SECRET_KEY=sk_test_... in .env.test, then
node --env-file=.env.test research/sandbox-e2e.ts
```

## License

MIT. See `LICENSE`.
