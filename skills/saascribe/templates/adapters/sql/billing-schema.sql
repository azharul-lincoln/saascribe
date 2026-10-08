-- SaaScribe billing schema for any Postgres 13+ (plain Postgres, Supabase, Neon, RDS).
-- Apply as one migration. Supabase also applies ../supabase/supabase-extras.sql after this file.
--
-- One row per account in billing_subscribers, written only through billing_save_subscriber(), which
-- the app calls from services/sync.ts. The row mirrors Stripe; Stripe stays the source of truth.

create table if not exists public.billing_subscribers (
  id uuid primary key default gen_random_uuid(),
  -- The app's user id as text, so uuid, cuid and integer ids all fit. Null until the account exists.
  user_id text unique,
  email text not null,
  stripe_customer_id text unique,
  entitled boolean not null default false,
  status text,
  plan text,
  billing_interval text check (billing_interval in ('month', 'year')),
  current_period_end timestamptz,
  trial_end timestamptz,
  cancel_at timestamptz,
  scheduled_plan text,
  scheduled_interval text check (scheduled_interval in ('month', 'year')),
  scheduled_at timestamptz,
  -- More than one means a duplicate subscription that blocks plan changes until support resolves it.
  paid_subscription_count integer not null default 0,
  -- Token of the Stripe read that produced this row (billing_next_sync_token). An older read is refused.
  sync_token bigint not null default 0,
  -- A scheduled change released to make room for a charge-now change, held until that charge settles
  -- so a declined, abandoned or expired payment can put it back. Not a Stripe mirror: the single writer
  -- never touches it; only billing_hold_change() and billing_take_held_change() do.
  held_change jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per email regardless of case: Stripe stores the address as typed.
create unique index if not exists billing_subscribers_email_lower on public.billing_subscribers (lower(email));

-- Sync tokens order the writes. A writer takes one BEFORE it reads Stripe; the row keeps the token
-- of the read it came from, and billing_save_subscriber() refuses a write whose read started earlier.
-- Without this, two webhooks racing can land the older Stripe read last and leave the row wrong.
create sequence if not exists public.billing_sync_token_seq;

create or replace function public.billing_next_sync_token()
returns bigint
language sql
volatile
set search_path = ''
as $fn$
  select nextval('public.billing_sync_token_seq');
$fn$;

-- Finds the account's row: by user id, then Stripe customer id, then email (case-insensitive).
create or replace function public.billing_find_subscriber(p_user_id text, p_customer_id text, p_email text)
returns setof public.billing_subscribers
language sql
stable
set search_path = ''
as $fn$
  (select * from public.billing_subscribers where p_user_id is not null and user_id = p_user_id limit 1)
  union all
  (select * from public.billing_subscribers where p_customer_id is not null and stripe_customer_id = p_customer_id limit 1)
  union all
  (select * from public.billing_subscribers where p_email is not null and lower(email) = lower(btrim(p_email)) limit 1)
  limit 1;
$fn$;

-- The single writer. Updates the row billing_find_subscriber() returns, or inserts one; a concurrent
-- insert for the same email ends as one row. Never replaces an existing user_id with another, and
-- keeps plan and interval when the write has none (a customer with only ended subscriptions still
-- shows the last plan). Refuses (saved = false, row unchanged) a write whose syncToken is older than the
-- row's. Returns the row id, its user id, the plan in the row before this write, and whether it saved.
create or replace function public.billing_save_subscriber(p jsonb)
returns table (row_id uuid, user_id text, previous_plan text, saved boolean)
language plpgsql
set search_path = ''
as $fn$
#variable_conflict use_column
declare
  v_id uuid;
  v_existing public.billing_subscribers;
  v_email text := btrim(p->>'email');
  v_token bigint := (p->>'syncToken')::bigint;
begin
  if v_email is null or v_email = '' then
    raise exception 'billing_save_subscriber: email is required';
  end if;
  if v_token is null then
    raise exception 'billing_save_subscriber: syncToken is required';
  end if;

  for attempt in 1..2 loop
    select f.id into v_id from public.billing_find_subscriber(p->>'userId', p->>'stripeCustomerId', v_email) f;
    if v_id is not null then
      select * into v_existing from public.billing_subscribers s where s.id = v_id for update;
    end if;

    if v_id is not null and v_existing.id is not null then
      if v_existing.user_id is not null and p->>'userId' is not null and v_existing.user_id <> p->>'userId' then
        raise exception 'billing_save_subscriber: row % belongs to another user', v_existing.id;
      end if;
      if v_existing.sync_token > v_token then
        -- A read that started later already wrote this row; it is the newer answer.
        return query select v_existing.id, v_existing.user_id, v_existing.plan, false;
        return;
      end if;
      update public.billing_subscribers s set
        user_id = coalesce(s.user_id, p->>'userId'),
        stripe_customer_id = coalesce(p->>'stripeCustomerId', s.stripe_customer_id),
        entitled = coalesce((p->>'entitled')::boolean, false),
        status = p->>'status',
        plan = coalesce(p->>'plan', s.plan),
        billing_interval = coalesce(p->>'interval', s.billing_interval),
        current_period_end = (p->>'currentPeriodEnd')::timestamptz,
        trial_end = (p->>'trialEnd')::timestamptz,
        cancel_at = (p->>'cancelAt')::timestamptz,
        scheduled_plan = p->>'scheduledPlan',
        scheduled_interval = p->>'scheduledInterval',
        scheduled_at = (p->>'scheduledAt')::timestamptz,
        paid_subscription_count = coalesce((p->>'paidSubscriptionCount')::integer, 0),
        sync_token = v_token,
        updated_at = now()
      where s.id = v_existing.id;
      return query select v_existing.id, coalesce(v_existing.user_id, p->>'userId'), v_existing.plan, true;
      return;
    end if;

    begin
      return query
      insert into public.billing_subscribers as s (
        user_id, email, stripe_customer_id, entitled, status, plan, billing_interval, current_period_end,
        trial_end, cancel_at, scheduled_plan, scheduled_interval, scheduled_at, paid_subscription_count, sync_token
      ) values (
        p->>'userId', v_email, p->>'stripeCustomerId', coalesce((p->>'entitled')::boolean, false), p->>'status',
        p->>'plan', p->>'interval', (p->>'currentPeriodEnd')::timestamptz, (p->>'trialEnd')::timestamptz,
        (p->>'cancelAt')::timestamptz, p->>'scheduledPlan', p->>'scheduledInterval', (p->>'scheduledAt')::timestamptz,
        coalesce((p->>'paidSubscriptionCount')::integer, 0), v_token
      )
      returning s.id, s.user_id, null::text, true;
      return;
    exception when unique_violation then
      -- Another writer inserted the same email or customer between our read and insert: update it.
      null;
    end;
  end loop;
  raise exception 'billing_save_subscriber: could not save row for %', v_email;
end;
$fn$;

-- Holds (or clears, with null) the released change on the customer's row. False when no row exists yet.
create or replace function public.billing_hold_change(p_customer_id text, p_change jsonb)
returns boolean
language sql
volatile
set search_path = ''
as $fn$
  with updated as (
    update public.billing_subscribers set held_change = p_change
    where stripe_customer_id = p_customer_id
    returning 1
  )
  select exists (select 1 from updated);
$fn$;

-- Returns the held change and clears it in one step, so two callers (a webhook and the browser) can
-- never both restore it.
create or replace function public.billing_take_held_change(p_customer_id text)
returns jsonb
language sql
volatile
set search_path = ''
as $fn$
  with held as (
    select id, held_change from public.billing_subscribers
    where stripe_customer_id = p_customer_id and held_change is not null
    for update
  ),
  cleared as (
    update public.billing_subscribers s set held_change = null
    from held where s.id = held.id
    returning held.held_change
  )
  select held_change from cleared;
$fn$;

-- Email dedupe keys: a key is inserted before a send and never sent twice.
create table if not exists public.billing_email_dedupe (
  dedupe_key text primary key,
  email_type text not null,
  created_at timestamptz not null default now()
);

-- The active Stripe mode, for apps that switch test and live at runtime (mode/db-switch).
-- Credentials never live here; each mode reads its own environment secrets.
create table if not exists public.billing_settings (
  id boolean primary key default true check (id),
  stripe_mode text not null default 'test' check (stripe_mode in ('test', 'live')),
  updated_at timestamptz not null default now()
);
insert into public.billing_settings (id) values (true) on conflict (id) do nothing;

-- Why customers cancelled (optional; recordCancellation).
create table if not exists public.billing_cancellations (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  email text not null,
  stripe_subscription_id text not null,
  plan text,
  mode text not null check (mode in ('now', 'period_end')),
  reason text not null,
  note text,
  effective_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Account details mirrored with the Stripe customer (optional profile sync).
create table if not exists public.billing_account_details (
  user_id text primary key,
  full_name text,
  phone text,
  billing_address jsonb,
  updated_at timestamptz not null default now()
);
