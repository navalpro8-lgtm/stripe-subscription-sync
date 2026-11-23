-- stripe-subscription-sync: tables and atomic functions. Plain Postgres (tested on 17).
-- Supabase-specific RLS and grants live in supabase.sql. Design: docs/SYNC_MODEL.md.
--
-- Rows in these tables are never physically deleted by this module.

-- ---------------------------------------------------------------- tables

-- One counter for "which happened first" comparisons, so they never depend on clocks.
-- An event takes a value when it first arrives; every Stripe read takes one just before it starts.
create sequence public.stripe_sync_seq;

create table public.stripe_events (
  event_id     text primary key,
  event_type   text not null,
  status       text not null
               check (status in ('processing', 'succeeded', 'failed', 'skipped', 'ignored')),
  received_seq bigint not null default nextval('public.stripe_sync_seq'),  -- first arrival
  claimed_by   uuid,
  claimed_at   timestamptz,
  attempts     integer not null default 0,
  last_error   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- One Stripe customer belongs to one application user. A user may have several customers.
create table public.stripe_customer_links (
  stripe_customer_id text primary key,
  user_id            text not null check (user_id <> ''),
  linked_by_event    text not null,
  created_at         timestamptz not null default now()
);

create table public.stripe_subscriptions (
  subscription_id      text primary key,
  user_id              text not null check (user_id <> ''),
  customer_id          text not null,
  status               text not null,  -- no CHECK, so a new Stripe status does not break writes
  price_id             text not null,
  product_id           text not null,
  quantity             integer,
  current_period_start timestamptz not null,
  current_period_end   timestamptz not null,
  items                jsonb not null    -- every subscription item, in Stripe's order (see Snapshot)
                       check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) > 0),
  cancel_at_period_end boolean not null,
  cancel_at            timestamptz,
  canceled_at          timestamptz,
  ended_at             timestamptz,
  trial_end            timestamptz,
  tombstoned_at        timestamptz,    -- set once the status is terminal; the row is then frozen
  revision             integer not null check (revision > 0),
  read_seq             bigint not null,  -- taken just before the Stripe read this row came from
  last_event_id        text not null,
  updated_at           timestamptz not null default now()
);

create index stripe_subscriptions_user_id_idx on public.stripe_subscriptions (user_id);

-- ---------------------------------------------------------------- event claims

-- Returns 'claimed', 'done' (already finished: acknowledge) or 'busy' (another worker holds a
-- fresh claim: do not acknowledge). A failed event, or a claim older than 120 seconds, is taken
-- over atomically by the ON CONFLICT ... WHERE clause.
create function public.claim_event(p_event_id text, p_event_type text, p_token uuid)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_status text;
begin
  insert into public.stripe_events as e (event_id, event_type, status, claimed_by, claimed_at, attempts)
  values (p_event_id, p_event_type, 'processing', p_token, now(), 1)
  on conflict (event_id) do update
    set status = 'processing', claimed_by = excluded.claimed_by, claimed_at = now(),
        attempts = e.attempts + 1, last_error = null, updated_at = now()
    where e.status = 'failed'
       or (e.status = 'processing' and e.claimed_at < now() - interval '120 seconds')
  returning e.status into v_status;

  if found then
    return 'claimed';
  end if;

  select e.status into v_status from public.stripe_events e where e.event_id = p_event_id;
  return case when v_status = 'processing' then 'busy' else 'done' end;
end;
$$;

-- Marks the outcome only if the caller still holds the claim. Returns false if it does not.
create function public.finish_event(p_event_id text, p_token uuid, p_status text, p_error text)
returns boolean
language plpgsql
set search_path = public
as $$
begin
  if p_status not in ('succeeded', 'failed', 'skipped', 'ignored') then
    raise exception 'finish_event: invalid status %', p_status;
  end if;

  update public.stripe_events
     set status = p_status, last_error = p_error, updated_at = now()
   where event_id = p_event_id and claimed_by = p_token and status = 'processing';
  return found;
end;
$$;

-- Locks the event row and checks the claim. Called first inside the write functions, so a
-- takeover cannot happen between this check and the write (it waits for our commit).
create function public.holds_event_claim(p_event_id text, p_token uuid)
returns boolean
language plpgsql
set search_path = public
as $$
begin
  perform 1 from public.stripe_events
   where event_id = p_event_id and claimed_by = p_token and status = 'processing'
   for update;
  return found;
end;
$$;

-- ---------------------------------------------------------------- subscriptions

-- Called just before fetching from Stripe. Returns the stored revision (0 if no row), a read_seq
-- marking the start of this read, and whether the stored row already came from a read that
-- started after this event first arrived (that read then already reflects the event's change).
create function public.begin_subscription_read(p_subscription_id text, p_event_id text)
returns jsonb
language sql
volatile
set search_path = public
as $$
  select jsonb_build_object(
    'revision',   coalesce(s.revision, 0),
    'read_seq',   nextval('public.stripe_sync_seq')::text,
    'superseded', coalesce(s.read_seq > e.received_seq, false))
  from (select 1) as one
  left join public.stripe_subscriptions s on s.subscription_id = p_subscription_id
  left join public.stripe_events e on e.event_id = p_event_id;
$$;

-- Compare-and-swap write. Returns 'applied', 'conflict', 'claim_lost', 'tombstoned' or
-- 'user_mismatch'. Anything but 'applied' writes nothing. One call = one transaction.
-- p_snapshot also carries the read_seq returned by begin_subscription_read.
create function public.apply_subscription_snapshot(
  p_subscription_id   text,
  p_expected_revision integer,
  p_claim_token       uuid,
  p_event_id          text,
  p_snapshot          jsonb
)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_status   text := p_snapshot->>'status';
  v_user_id  text := p_snapshot->>'user_id';
  v_existing public.stripe_subscriptions%rowtype;
begin
  if not public.holds_event_claim(p_event_id, p_claim_token) then
    return 'claim_lost';
  end if;

  -- Rows are never deleted, so expected_revision > 0 always refers to an existing row and the
  -- insert branch only runs for a first write (revision 1). Concurrent first inserts collide on
  -- the primary key; the loser's WHERE fails against the winner's revision 1: 'conflict'.
  insert into public.stripe_subscriptions as s (
    subscription_id, user_id, customer_id, status, price_id, product_id, quantity,
    current_period_start, current_period_end, items, cancel_at_period_end,
    cancel_at, canceled_at, ended_at, trial_end, tombstoned_at, revision, read_seq, last_event_id
  ) values (
    p_subscription_id, v_user_id, p_snapshot->>'customer_id', v_status,
    p_snapshot->>'price_id', p_snapshot->>'product_id', (p_snapshot->>'quantity')::integer,
    to_timestamp((p_snapshot->>'current_period_start')::bigint),
    to_timestamp((p_snapshot->>'current_period_end')::bigint),
    p_snapshot->'items',
    (p_snapshot->>'cancel_at_period_end')::boolean,
    to_timestamp((p_snapshot->>'cancel_at')::bigint),
    to_timestamp((p_snapshot->>'canceled_at')::bigint),
    to_timestamp((p_snapshot->>'ended_at')::bigint),
    to_timestamp((p_snapshot->>'trial_end')::bigint),
    case when v_status in ('canceled', 'incomplete_expired') then now() end,
    p_expected_revision + 1,
    (p_snapshot->>'read_seq')::bigint,
    p_event_id
  )
  on conflict (subscription_id) do update
    set customer_id = excluded.customer_id, status = excluded.status,
        price_id = excluded.price_id, product_id = excluded.product_id,
        quantity = excluded.quantity,
        current_period_start = excluded.current_period_start,
        current_period_end = excluded.current_period_end,
        items = excluded.items,
        cancel_at_period_end = excluded.cancel_at_period_end,
        cancel_at = excluded.cancel_at, canceled_at = excluded.canceled_at,
        ended_at = excluded.ended_at, trial_end = excluded.trial_end,
        tombstoned_at = excluded.tombstoned_at,
        revision = s.revision + 1, read_seq = excluded.read_seq,
        last_event_id = excluded.last_event_id, updated_at = now()
    where s.revision = p_expected_revision
      and s.tombstoned_at is null
      and s.user_id = excluded.user_id;

  if found then
    return 'applied';
  end if;

  select * into v_existing from public.stripe_subscriptions where subscription_id = p_subscription_id;
  if v_existing.tombstoned_at is not null then
    return 'tombstoned';
  elsif v_existing.revision = p_expected_revision and v_existing.user_id <> v_user_id then
    return 'user_mismatch';
  end if;
  return 'conflict';
end;
$$;

create function public.list_user_subscriptions(p_user_id text)
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(s) order by s.subscription_id), '[]'::jsonb)
    from public.stripe_subscriptions s
   where s.user_id = p_user_id;
$$;

-- ---------------------------------------------------------------- customer links

-- Returns 'linked', 'already_linked', 'mismatch' (customer belongs to another user; nothing
-- changes) or 'claim_lost'.
create function public.link_customer(p_customer_id text, p_user_id text, p_event_id text, p_claim_token uuid)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_user_id text;
begin
  if not public.holds_event_claim(p_event_id, p_claim_token) then
    return 'claim_lost';
  end if;

  insert into public.stripe_customer_links (stripe_customer_id, user_id, linked_by_event)
  values (p_customer_id, p_user_id, p_event_id)
  on conflict (stripe_customer_id) do nothing;
  if found then
    return 'linked';
  end if;

  select user_id into v_user_id from public.stripe_customer_links where stripe_customer_id = p_customer_id;
  return case when v_user_id = p_user_id then 'already_linked' else 'mismatch' end;
end;
$$;

create function public.find_user_for_customer(p_customer_id text)
returns text
language sql
stable
set search_path = public
as $$
  select user_id from public.stripe_customer_links where stripe_customer_id = p_customer_id;
$$;
