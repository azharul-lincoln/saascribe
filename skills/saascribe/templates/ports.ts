import type Stripe from "stripe";
import type { BillingConfig, Interval } from "./core/config.ts";

/**
 * The seams between the billing services and the app. The services never import a database
 * client, an auth library, an email provider or a runtime API; the app passes these in.
 *
 * Ready-made implementations live in `adapters/`. Writing a new one: see `references/adapters.md`.
 */

export type StripeMode = "test" | "live";

export interface StripeCredentials {
  mode: StripeMode;
  secretKey: string | null;
  webhookSecret: string | null;
}

/**
 * Which Stripe mode the app runs in, and the credentials for each mode. Credentials always come
 * from environment secrets, never the database.
 */
export interface ModeSource {
  /**
   * The active mode. Must throw when it cannot be read, never guess: the webhook uses it to drop
   * the other mode's events, and a wrong guess would drop real ones.
   */
  activeMode(): Promise<StripeMode>;
  credentials(mode: StripeMode): StripeCredentials;
}

/** The app's billing row for one account, as the services read it. */
export interface SubscriberRow {
  id: string;
  userId: string | null;
  email: string;
  stripeCustomerId: string | null;
  entitled: boolean;
  plan: string | null;
  interval: Interval | null;
}

/** Everything the single writer stores. Dates are ISO strings or null. */
export interface SubscriberWrite {
  email: string;
  userId: string | null;
  stripeCustomerId: string | null;
  entitled: boolean;
  status: string | null;
  plan: string | null;
  interval: Interval | null;
  currentPeriodEnd: string | null;
  trialEnd: string | null;
  cancelAt: string | null;
  scheduledPlan: string | null;
  scheduledInterval: Interval | null;
  scheduledAt: string | null;
  paidSubscriptionCount: number;
  /** From `nextSyncToken()`, taken before the Stripe read this write comes from. */
  syncToken: number;
}

/**
 * A scheduled change (usually a downgrade) released so a charge-now change could replace it. Held
 * until that charge settles: put back if it is declined, abandoned or expires, dropped if it is paid.
 */
export interface HeldChange {
  subscriptionId: string;
  plan: string;
  interval: Interval;
}

export interface SubscriberLookup {
  userId?: string | null;
  customerId?: string | null;
  email?: string | null;
}

/**
 * Storage for billing rows. One row per account. Only `services/sync.ts` calls `save`.
 *
 * Contract (`adapters/sql/billing-schema.sql` implements it; `references/adapters.md` explains it):
 * - `find` tries user id, then Stripe customer id, then email compared case-insensitively, and
 *   returns the most recently updated match, never an error for duplicates.
 * - `nextSyncToken` returns a number larger than every one returned before (a database sequence).
 * - `save` updates the row `find` returns for the same keys, or inserts one. It never replaces
 *   an existing `userId` with a different one, and keeps `plan`/`interval` when the write has none.
 *   It refuses (`saved: false`, row unchanged) a write whose `syncToken` is lower than the row's,
 *   checked under the same row lock as the update. A concurrent insert of the same email must end
 *   as one row (retry the update on a unique violation).
 */
export interface SubscriberStore {
  find(keys: SubscriberLookup): Promise<SubscriberRow | null>;
  nextSyncToken(): Promise<number>;
  /** `previousPlan` is the row's plan before this write; when `saved` is false, the plan it keeps. */
  save(write: SubscriberWrite): Promise<{ rowId: string; userId: string | null; previousPlan: string | null; saved: boolean }>;
  /**
   * Holds (or clears, with null) the released change on the customer's row. Returns false when the
   * customer has no row yet. Separate from `save`: the held change is not mirrored from Stripe.
   */
  holdChange(customerId: string, change: HeldChange | null): Promise<boolean>;
  /** Returns the held change and clears it atomically, so two callers can never both restore it. */
  takeHeldChange(customerId: string): Promise<HeldChange | null>;
  /** Every row, for the read-only audit. */
  listAll(): Promise<SubscriberRow[]>;
}

/** The app's user accounts, for the post-payment signup only. */
export interface Identity {
  findByEmail(email: string): Promise<{ userId: string; hasPassword: boolean } | null>;
  /**
   * Creates an UNCONFIRMED account with no password and returns a one-time link that confirms the
   * email and signs the person in, where they choose a password. Never a confirmed account: the
   * checkout proves who paid, not who owns the email they typed. Returns `exists` instead of throwing
   * when the email is taken. The link is sent by the caller through the Mailer.
   */
  createUnconfirmedUser(input: { email: string; redirectTo: string; metadata?: Record<string, string> }): Promise<
    { userId: string; confirmUrl: string } | { exists: true }
  >;
}

export type EmailType =
  | "welcome"
  | "confirm_email"
  | "subscription_confirmed"
  | "payment_receipt"
  | "payment_failed"
  | "subscription_cancelled"
  | "plan_changed";

export interface EmailMessage {
  to: string;
  type: EmailType;
  /** The same key never sends twice, across webhook retries and replays. */
  dedupeKey: string;
  userId: string | null;
  data: Record<string, unknown>;
}

/**
 * Sends lifecycle emails. Must be idempotent per `dedupeKey` and must not throw for a delivery
 * failure the webhook should not retry (log it instead): a throw makes Stripe redeliver the event.
 */
export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

/** Account details mirrored between the app and the Stripe customer (optional feature). */
export interface AccountDetails {
  name?: string | null;
  phone?: string | null;
  address?: Stripe.Address | null;
}

export interface ProfileStore {
  /** When the app last saved these details, or null. A Stripe edit older than this is stale. */
  detailsUpdatedAt(userId: string): Promise<Date | null>;
  writeDetails(userId: string, details: AccountDetails, at: Date): Promise<void>;
}

export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/** A record of why someone cancelled, if the app keeps one (optional). */
export interface CancellationRecord {
  userId: string;
  email: string;
  subscriptionId: string;
  plan: string | null;
  mode: "now" | "period_end";
  reason: string;
  note: string | null;
  effectiveAt: string;
}

/** What the services need, built once per request by the HTTP adapter. */
export interface BillingDeps {
  config: BillingConfig;
  stripe: Stripe;
  mode: StripeMode;
  store: SubscriberStore;
  mailer: Mailer;
  log: Logger;
  /** Required for the post-payment endpoints. */
  identity?: Identity;
  /** Required for the profile sync feature. */
  profiles?: ProfileStore;
  /** Optional side effect when an account's plan changes (e.g. raise a usage limit). Must be idempotent. */
  onPlanChange?: (change: { userId: string; from: string; to: string }) => Promise<void>;
  recordCancellation?: (records: CancellationRecord[]) => Promise<void>;
  copy: BillingCopy;
}

/** Customer-facing text the services return. Keep it plain; the frontend may override by `code`. */
export interface BillingCopy {
  supportEmail: string;
  /** App URL the portal and checkout return to, e.g. `https://app.example.com`. */
  appUrl: string;
  /** Path of the billing page, e.g. `/settings/billing`. */
  billingPath: string;
  /** Path Stripe returns to after checkout, e.g. `/welcome`. `?session_id=` is appended for Sessions. */
  postCheckoutPath: string;
  cancelReasons: readonly string[];
}

/** The authenticated caller, resolved by the HTTP adapter from the session. */
export interface BillingUser {
  id: string;
  email: string;
  /**
   * Whether the user proved they own `email` (clicked a confirmation link, signed in with a provider
   * that verifies it). The HTTP adapter refuses unverified users: billing finds the Stripe customer by
   * email, so an unverified address would reach whoever really owns it.
   */
  emailVerified: boolean;
}
