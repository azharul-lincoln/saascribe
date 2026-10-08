-- Supabase-only additions, applied after ../sql/billing-schema.sql in the same migration.
-- Every billing table is written by edge functions with the service role only. Signed-in users
-- may read their own billing row; nothing else is exposed to the anon or authenticated roles.

alter table public.billing_subscribers enable row level security;
alter table public.billing_email_dedupe enable row level security;
alter table public.billing_settings enable row level security;
alter table public.billing_cancellations enable row level security;
alter table public.billing_account_details enable row level security;

drop policy if exists "Own billing row is readable" on public.billing_subscribers;
create policy "Own billing row is readable" on public.billing_subscribers
  for select to authenticated using (user_id = (select auth.uid())::text);

revoke all on function public.billing_find_subscriber(text, text, text) from public, anon, authenticated;
revoke all on function public.billing_save_subscriber(jsonb) from public, anon, authenticated;
grant execute on function public.billing_find_subscriber(text, text, text) to service_role;
grant execute on function public.billing_save_subscriber(jsonb) to service_role;
revoke all on function public.billing_next_sync_token() from public, anon, authenticated;
revoke all on sequence public.billing_sync_token_seq from public, anon, authenticated;
grant execute on function public.billing_next_sync_token() to service_role;
grant usage on sequence public.billing_sync_token_seq to service_role;
revoke all on function public.billing_hold_change(text, jsonb) from public, anon, authenticated;
revoke all on function public.billing_take_held_change(text) from public, anon, authenticated;
grant execute on function public.billing_hold_change(text, jsonb) to service_role;
grant execute on function public.billing_take_held_change(text) to service_role;

-- One auth user by email, for the post-payment page. auth.admin.listUsers() returns one page only,
-- so past 50 accounts an existing customer would read as new. Service role only: anon access would
-- let anyone enumerate accounts. has_password: the account has an email identity, not only OAuth.
create or replace function public.billing_auth_user_by_email(p_email text)
returns table (user_id uuid, has_password boolean)
language sql
stable
security definer
set search_path = ''
as $fn$
  select u.id,
         exists (select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email')
  from auth.users u
  where lower(u.email) = lower(btrim(p_email))
  order by u.created_at desc
  limit 1;
$fn$;

revoke all on function public.billing_auth_user_by_email(text) from public, anon, authenticated;
grant execute on function public.billing_auth_user_by_email(text) to service_role;
