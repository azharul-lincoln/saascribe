import type { SupabaseClient } from "@supabase/supabase-js";
import type { Interval } from "../../core/config.ts";
import type { AccountDetails, CancellationRecord, HeldChange, Identity, Mailer, EmailMessage, Logger, ModeSource, ProfileStore, StripeCredentials, StripeMode, SubscriberRow, SubscriberStore, BillingUser } from "../../ports.ts";

/**
 * Supabase implementations of the ports, over the tables in `sql/billing-schema.sql` and
 * `supabase-extras.sql`. Every client passed here must be a service-role client.
 */

interface RowRecord {
  id: string;
  user_id: string | null;
  email: string;
  stripe_customer_id: string | null;
  entitled: boolean;
  plan: string | null;
  billing_interval: Interval | null;
}

const toRow = (r: RowRecord): SubscriberRow => ({
  id: r.id,
  userId: r.user_id,
  email: r.email,
  stripeCustomerId: r.stripe_customer_id,
  entitled: r.entitled,
  plan: r.plan,
  interval: r.billing_interval,
});

export function supabaseSubscriberStore(admin: SupabaseClient): SubscriberStore {
  return {
    async find(keys) {
      const { data, error } = await admin.rpc("billing_find_subscriber", {
        p_user_id: keys.userId ?? null,
        p_customer_id: keys.customerId ?? null,
        p_email: keys.email ?? null,
      });
      if (error) throw new Error(`billing_find_subscriber failed: ${error.message}`);
      const row = (data as RowRecord[] | null)?.[0];
      return row ? toRow(row) : null;
    },
    async nextSyncToken() {
      const { data, error } = await admin.rpc("billing_next_sync_token");
      if (error) throw new Error(`billing_next_sync_token failed: ${error.message}`);
      // bigint arrives as a number or a string depending on the client; a sequence stays far below 2^53.
      return Number(data);
    },
    async save(write) {
      const { data, error } = await admin.rpc("billing_save_subscriber", { p: write });
      if (error) throw new Error(`billing_save_subscriber failed: ${error.message}`);
      const saved = (data as { row_id: string; user_id: string | null; previous_plan: string | null; saved: boolean }[])[0];
      return { rowId: saved.row_id, userId: saved.user_id, previousPlan: saved.previous_plan, saved: saved.saved };
    },
    async holdChange(customerId, change) {
      const { data, error } = await admin.rpc("billing_hold_change", { p_customer_id: customerId, p_change: change });
      if (error) throw new Error(`billing_hold_change failed: ${error.message}`);
      return data === true;
    },
    async takeHeldChange(customerId) {
      const { data, error } = await admin.rpc("billing_take_held_change", { p_customer_id: customerId });
      if (error) throw new Error(`billing_take_held_change failed: ${error.message}`);
      return (data as HeldChange | null) ?? null;
    },
    async listAll() {
      const rows: SubscriberRow[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await admin
          .from("billing_subscribers")
          .select("id, user_id, email, stripe_customer_id, entitled, plan, billing_interval")
          .order("created_at")
          .range(from, from + 999);
        if (error) throw new Error(`billing_subscribers read failed: ${error.message}`);
        rows.push(...(data as RowRecord[]).map(toRow));
        if (!data || data.length < 1000) return rows;
      }
    },
  };
}

/** Supabase Auth: the caller from the request's bearer token, and the post-payment account steps. */
export function supabaseIdentity(admin: SupabaseClient): Identity & { authenticate(req: Request): Promise<BillingUser | null> } {
  return {
    async authenticate(req) {
      const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
      if (!token) return null;
      const { data, error } = await admin.auth.getUser(token);
      if (error || !data.user?.email) return null;
      return { id: data.user.id, email: data.user.email, emailVerified: Boolean(data.user.email_confirmed_at) };
    },
    async createUnconfirmedUser({ email, redirectTo, metadata }) {
      // An invite link creates the user unconfirmed and without a password; opening it confirms the
      // email and signs them in. generateLink does not send anything: the caller mails the link.
      const { data, error } = await admin.auth.admin.generateLink({ type: "invite", email, options: { redirectTo, data: metadata } });
      if (error) {
        // The auth service enforces one account per email, case-insensitively.
        if ((error as { code?: string }).code === "email_exists" || /already (been )?registered/i.test(error.message)) return { exists: true };
        throw error;
      }
      return { userId: data.user.id, confirmUrl: data.properties.action_link };
    },
    async createSignInLink({ email, redirectTo }) {
      const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email, options: { redirectTo } });
      if (error) {
        if ((error as { status?: number }).status === 404 || /not found/i.test(error.message)) return null;
        throw error;
      }
      return data.properties.action_link;
    },
  };
}

/**
 * Wraps an email provider with the dedupe table. The key is inserted first; a duplicate key means
 * the email was already sent (or is being sent) and nothing happens. A failed delivery removes the
 * key and is logged, not thrown, so one bad address cannot make Stripe redeliver an event forever.
 */
export function supabaseDedupedMailer(admin: SupabaseClient, deliver: (message: EmailMessage) => Promise<void>, log: Logger): Mailer {
  return {
    async send(message) {
      const { error } = await admin.from("billing_email_dedupe").insert({ dedupe_key: message.dedupeKey, email_type: message.type });
      if (error?.code === "23505") return;
      if (error) throw new Error(`billing_email_dedupe insert failed: ${error.message}`);
      try {
        await deliver(message);
      } catch (deliveryError) {
        await admin.from("billing_email_dedupe").delete().eq("dedupe_key", message.dedupeKey);
        log.error("Email delivery failed", { type: message.type, dedupeKey: message.dedupeKey, message: (deliveryError as Error).message });
      }
    },
  };
}

/**
 * Runtime test/live switch stored in `billing_settings` (optional; `mode/env.ts` is the default).
 * Cached for a few seconds, because warm edge instances keep module state between requests.
 * `activeMode` throws when the row cannot be read; the webhook relies on that.
 */
export function supabaseDbModeSource(admin: SupabaseClient, readEnv: (name: string) => string | undefined): ModeSource {
  let cached: { mode: StripeMode; at: number } | null = null;
  const read = (name: string) => readEnv(name)?.trim() || null;
  return {
    async activeMode() {
      if (cached && Date.now() - cached.at < 5_000) return cached.mode;
      const { data, error } = await admin.from("billing_settings").select("stripe_mode").eq("id", true).single();
      if (error) throw new Error(`billing_settings read failed: ${error.message}`);
      cached = { mode: data.stripe_mode === "live" ? "live" : "test", at: Date.now() };
      return cached.mode;
    },
    credentials(mode): StripeCredentials {
      const suffix = mode === "live" ? "LIVE" : "TEST";
      return { mode, secretKey: read(`STRIPE_SECRET_KEY_${suffix}`), webhookSecret: read(`STRIPE_WEBHOOK_SECRET_${suffix}`) };
    },
  };
}

/** Account details for the optional profile sync, in `billing_account_details`. */
export function supabaseProfileStore(admin: SupabaseClient): ProfileStore {
  return {
    async detailsUpdatedAt(userId) {
      const { data, error } = await admin.from("billing_account_details").select("updated_at").eq("user_id", userId).maybeSingle();
      if (error) throw new Error(`billing_account_details read failed: ${error.message}`);
      return data?.updated_at ? new Date(data.updated_at) : null;
    },
    async writeDetails(userId, details: AccountDetails, at) {
      const fields: Record<string, unknown> = { user_id: userId, updated_at: at.toISOString() };
      if (details.name !== undefined) fields.full_name = details.name;
      if (details.phone !== undefined) fields.phone = details.phone;
      if (details.address !== undefined) fields.billing_address = details.address;
      const { error } = await admin.from("billing_account_details").upsert(fields, { onConflict: "user_id" });
      if (error) throw new Error(`billing_account_details write failed: ${error.message}`);
    },
  };
}

export function supabaseCancellationLog(admin: SupabaseClient) {
  return async (records: CancellationRecord[]) => {
    const { error } = await admin.from("billing_cancellations").insert(records.map((r) => ({
      user_id: r.userId,
      email: r.email,
      stripe_subscription_id: r.subscriptionId,
      plan: r.plan,
      mode: r.mode,
      reason: r.reason,
      note: r.note,
      effective_at: r.effectiveAt,
    })));
    if (error) throw new Error(`billing_cancellations insert failed: ${error.message}`);
  };
}
