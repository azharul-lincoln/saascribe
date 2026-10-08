# Billing screens

Framework-neutral. Use the project's components, routing, data fetching and copy style. The plan picker and the change
dialog are covered in `plan-changes.md`; this file covers the rest.

## Pricing and checkout

- Signed-out visitors: plan cards, then checkout. Signed-in customers who already pay should not reach checkout; send them
  to the billing page with the chosen plan preselected.
- Show the trial terms the policy chose (length, card up front, first charge date).
- Handle `already_subscribed` with a sign-in link, not a generic error.
- For Checkout Sessions, keep the nonce the server returns in `sessionStorage` before redirecting (`checkout.md`).

## Post-payment page

States to design: checking, new account ("we sent a link to <email>; open it to set your password"), existing account
(sign in, or continue with the OAuth provider the account uses), and unverified (no or bad proof: sign in, or contact
support). The page that link opens asks for the password. Do not take a password before the email is confirmed
(`checkout.md`). Read the proof from the
return URL once, keep it in `sessionStorage` so a reload still works, and clear it after success. Sign out any old local
session first, so a previous user's session cannot leak into the new account.

## Billing page

| Part | Shows |
|---|---|
| Plan header | Plan, interval, status badge (Active, Trial, Past due, Ending, Inactive), next charge or trial end date |
| Banners | Set to cancel ("Keep my plan" calls resume); scheduled downgrade ("Keep <plan>"); past due ("Update card" opens the portal); duplicate subscriptions (contact support) |
| Plan picker | See `plan-changes.md` |
| Invoices | Recent invoices from Stripe (date, amount, status, hosted link, PDF); an empty list when there is no customer in this mode |
| Portal button | Cards, invoices, billing details; plan switching and cancel off in the portal configuration if the app owns them |
| Cancel | A dialog with reasons and an optional note; copy that says when access ends under the policy |

After any change (plan change, cancel, resume, return from the portal), refetch the billing status from the server
rather than updating local state by hand; the server recomputes from Stripe.

## Errors and copy

- Branch on stable error codes from the server, not on message text.
- Keep money in minor units until display; format with the currency from Stripe.
- Every sentence that describes timing or charges depends on the policy. Write it from the decisions in `policy.md`, and
  revisit it when a decision changes.
