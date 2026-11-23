-- stripe-subscription-sync: Supabase row level security and grants. Run after schema.sql.
-- Roles: service_role (server only, writes), authenticated (reads own rows), anon (nothing).
-- No SECURITY DEFINER: the functions run as the caller, and only service_role may call them.

alter table public.stripe_events         enable row level security;
alter table public.stripe_customer_links enable row level security;
alter table public.stripe_subscriptions  enable row level security;

-- Tables: start from nothing, then grant explicitly. No DELETE for anyone: rows are never deleted.
revoke all on table public.stripe_events, public.stripe_customer_links, public.stripe_subscriptions
  from public, anon, authenticated, service_role;

grant select, insert, update
  on table public.stripe_events, public.stripe_customer_links, public.stripe_subscriptions
  to service_role;

-- Authenticated users may read only their own subscription rows. No policies exist for the other
-- two tables, so RLS denies every row there to anon and authenticated.
grant select on table public.stripe_subscriptions to authenticated;

create policy stripe_subscriptions_select_own
  on public.stripe_subscriptions
  for select
  to authenticated
  using (user_id = (select auth.uid())::text);

-- Functions: Postgres grants EXECUTE to PUBLIC by default, so revoke from PUBLIC as well.
revoke execute on function
  public.claim_event(text, text, uuid),
  public.finish_event(text, uuid, text, text),
  public.holds_event_claim(text, uuid),
  public.get_subscription_revision(text),
  public.apply_subscription_snapshot(text, integer, uuid, text, jsonb),
  public.list_user_subscriptions(text),
  public.link_customer(text, text, text, uuid),
  public.find_user_for_customer(text)
  from public, anon, authenticated;

grant execute on function
  public.claim_event(text, text, uuid),
  public.finish_event(text, uuid, text, text),
  public.holds_event_claim(text, uuid),
  public.get_subscription_revision(text),
  public.apply_subscription_snapshot(text, integer, uuid, text, jsonb),
  public.list_user_subscriptions(text),
  public.link_customer(text, text, text, uuid),
  public.find_user_for_customer(text)
  to service_role;
