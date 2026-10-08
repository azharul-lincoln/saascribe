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
