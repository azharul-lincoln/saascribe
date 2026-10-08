import type Stripe from "stripe";

/**
 * Proof that the caller is the browser that just finished a checkout, for the post-payment
 * endpoints (does an account exist for this checkout, create it). They have no session yet, so
 * the proof is the authentication, and they act only on the email of the checkout's Stripe
 * customer, never on an email the request names. Without it anyone could create a confirmed
 * account for someone else's address or probe which emails have accounts.
 *
 * Two shapes, one per checkout flow:
 * - Checkout Sessions: `success_url` carries `{CHECKOUT_SESSION_ID}`. A session id sits in the URL,
 *   browser history and referrers, so it is not a secret. Checkout therefore also hands the
 *   browser a random nonce (kept in `sessionStorage`) and stores only its SHA-256 on the session
 *   (`metadata.checkout_nonce_hash`). The proof is the session id plus that nonce.
 * - Subscription-first with the Payment Element: Stripe's return URL carries the intent id and its
 *   client secret (`setup_intent` + `setup_intent_client_secret`, or the `payment_intent` pair).
 *   Only that browser has the secret.
 *
 * Pure checks; `services/post-payment.ts` retrieves the objects.
 */

export type CheckoutProof =
  | { kind: "session"; sessionId: string; nonce: string }
  | { kind: "intent"; intentId: string; clientSecret: string };

/** The proof from a request body, or null when it is missing or malformed. */
export function parseCheckoutProof(body: unknown): CheckoutProof | null {
  if (!body || typeof body !== "object") return null;
  const { sessionId, nonce, intentId, clientSecret } = body as Record<string, unknown>;
  if (typeof sessionId === "string") {
    if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) return null;
    if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(nonce)) return null;
    return { kind: "session", sessionId, nonce };
  }
  if (typeof intentId !== "string" || typeof clientSecret !== "string") return null;
  if (!/^(seti|pi)_[A-Za-z0-9]+$/.test(intentId)) return null;
  if (!clientSecret.startsWith(`${intentId}_secret_`)) return null;
  return { kind: "intent", intentId, clientSecret };
}

export type ProofCheck = { ok: true; customerId: string } | { ok: false; reason: string };

function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

/** Metadata key on the Checkout Session that holds the nonce hash. */
export const NONCE_METADATA_KEY = "checkout_nonce_hash";

/** A new random nonce for the browser, base64url, 32 bytes. */
export function newCheckoutNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Hex SHA-256 of the nonce; only this is stored on the session. */
export async function hashCheckoutNonce(nonce: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const idOf = (value: string | { id: string } | null | undefined) => (typeof value === "string" ? value : value?.id);

type ProofIntent = Pick<
  Stripe.SetupIntent | Stripe.PaymentIntent,
  "object" | "client_secret" | "status" | "customer" | "created"
>;

/**
 * A retrieved intent proves a finished checkout when the secret matches, the card step went
 * through (a payment may still be `processing` for bank debits), it has a customer, and it is recent.
 */
export function checkIntent(intent: ProofIntent, clientSecret: string, now: number, maxAgeSeconds: number): ProofCheck {
  if (!intent.client_secret || !timingSafeEqual(intent.client_secret, clientSecret)) {
    return { ok: false, reason: "secret_mismatch" };
  }
  const settled = intent.object === "setup_intent"
    ? intent.status === "succeeded"
    : intent.status === "succeeded" || intent.status === "processing";
  if (!settled) return { ok: false, reason: `status_${intent.status}` };
  const customerId = idOf(intent.customer as string | { id: string } | null);
  if (!customerId) return { ok: false, reason: "no_customer" };
  if (now - intent.created > maxAgeSeconds) return { ok: false, reason: "expired" };
  return { ok: true, customerId };
}

type ProofSession = Pick<Stripe.Checkout.Session, "status" | "mode" | "customer" | "created" | "subscription" | "metadata">;

/**
 * A retrieved Checkout Session proves a finished checkout when the nonce hash matches, it is a
 * completed subscription session with a customer, and it is recent. `payment_status` is not checked: a trial completes as
 * `no_payment_required`, and an async payment method completes as `unpaid` until it settles;
 * the subscription status decides access either way.
 */
export function checkSession(session: ProofSession, nonceHash: string, now: number, maxAgeSeconds: number): ProofCheck {
  const stored = session.metadata?.[NONCE_METADATA_KEY];
  if (!stored || !timingSafeEqual(stored, nonceHash)) return { ok: false, reason: "nonce_mismatch" };
  if (session.mode !== "subscription") return { ok: false, reason: `mode_${session.mode}` };
  if (session.status !== "complete") return { ok: false, reason: `status_${session.status}` };
  const customerId = idOf(session.customer as string | { id: string } | null);
  if (!customerId) return { ok: false, reason: "no_customer" };
  if (!session.subscription) return { ok: false, reason: "no_subscription" };
  if (now - session.created > maxAgeSeconds) return { ok: false, reason: "expired" };
  return { ok: true, customerId };
}
