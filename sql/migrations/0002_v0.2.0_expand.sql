-- Migration 0002 (expand): v0.1.0 -> v0.2.0, step 1 of 2. Plain Postgres part; on Supabase run
-- 0002_v0.2.0_expand_supabase.sql after it. Then deploy v0.2.0, then run 0003 (contract).
--
-- No pause is needed: v0.1.0 code keeps working against the database after this step.
--   - livemode is added to the three tables as NOT NULL with a constant DEFAULT (the Stripe mode
--     of this database). On Postgres 11+ that is a catalog-only change: no table rewrite or scan,
--     only a brief lock per table. v0.1.0 code inserts without livemode and gets the default.
--   - The new claim_event and link_customer signatures are added NEXT TO the old ones.
--   - apply_subscription_snapshot gets the v0.2.0 body, except that a snapshot without livemode
--     (sent by v0.1.0 code) uses the default mode. 0003 removes that fallback.
--
-- Set the mode first; without it the migration raises an error and changes nothing:
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -c "set stripe_sync.livemode = 'false'" -f sql/migrations/0002_v0.2.0_expand.sql
--
-- 'false' for a sandbox / test-mode database, 'true' for live mode.

-- Fail fast instead of queueing behind long transactions (and blocking others behind us).
set local lock_timeout = '5s';

do $mig$
declare
  m text := current_setting('stripe_sync.livemode', true);
begin
  if m is null or m not in ('true', 'false') then
    raise exception 'set stripe_sync.livemode to ''true'' or ''false'' (the Stripe mode of this database) before running this migration';
  end if;

  execute format('alter table public.stripe_events add column livemode boolean not null default %s', m);
  execute format('alter table public.stripe_customer_links add column livemode boolean not null default %s', m);
  execute format('alter table public.stripe_subscriptions add column livemode boolean not null default %s', m);

  execute replace($fn$
create or replace function public.apply_subscription_snapshot(
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
  v_livemode boolean := coalesce((p_snapshot->>'livemode')::boolean, __MODE__); -- transitional: v0.1.0 code omits it
  v_existing public.stripe_subscriptions%rowtype;
begin
  if not public.holds_event_claim(p_event_id, p_claim_token) then
    return 'claim_lost';
  end if;
  if v_livemode is null then
    raise exception 'apply_subscription_snapshot: snapshot.livemode is required';
  end if;

  -- Rows are never deleted, so expected_revision > 0 always refers to an existing row and the
  -- insert branch only runs for a first write (revision 1). Concurrent first inserts collide on
  -- the primary key; the loser's WHERE fails against the winner's revision 1: 'conflict'.
  insert into public.stripe_subscriptions as s (
    subscription_id, user_id, customer_id, livemode, status, price_id, product_id, quantity,
    current_period_start, current_period_end, items, cancel_at_period_end,
    cancel_at, canceled_at, ended_at, trial_end, tombstoned_at, revision, read_seq, last_event_id
  ) values (
    p_subscription_id, v_user_id, p_snapshot->>'customer_id', v_livemode, v_status,
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
      and s.user_id = excluded.user_id
      and s.livemode = excluded.livemode;

  if found then
    return 'applied';
  end if;

  select * into v_existing from public.stripe_subscriptions where subscription_id = p_subscription_id;
  if v_existing.livemode <> v_livemode then
    return 'mode_mismatch';
  elsif v_existing.tombstoned_at is not null then
    return 'tombstoned';
  elsif v_existing.revision = p_expected_revision and v_existing.user_id <> v_user_id then
    return 'user_mismatch';
  end if;
  return 'conflict';
end;
$$;
$fn$, '__MODE__', m);
end
$mig$;

-- New signatures, as in sql/schema.sql. The v0.1.0 versions stay until 0003.
create function public.claim_event(
  p_event_id text, p_event_type text, p_token uuid, p_livemode boolean, p_claim_timeout_seconds integer
)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_status text;
begin
  if p_claim_timeout_seconds is null or p_claim_timeout_seconds < 1 then
    raise exception 'claim_event: invalid claim timeout %', p_claim_timeout_seconds;
  end if;

  insert into public.stripe_events as e (event_id, event_type, livemode, status, claimed_by, claimed_at, attempts)
  values (p_event_id, p_event_type, p_livemode, 'processing', p_token, now(), 1)
  on conflict (event_id) do update
    set status = 'processing', claimed_by = excluded.claimed_by, claimed_at = now(),
        attempts = e.attempts + 1, last_error = null, updated_at = now()
    where e.status = 'failed'
       or (e.status = 'processing' and e.claimed_at < now() - make_interval(secs => p_claim_timeout_seconds))
  returning e.status into v_status;

  if found then
    return 'claimed';
  end if;

  select e.status into v_status from public.stripe_events e where e.event_id = p_event_id;
  return case when v_status = 'processing' then 'busy' else 'done' end;
end;
$$;

create function public.link_customer(p_customer_id text, p_user_id text, p_event_id text, p_claim_token uuid, p_livemode boolean)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_user_id  text;
  v_livemode boolean;
begin
  if not public.holds_event_claim(p_event_id, p_claim_token) then
    return 'claim_lost';
  end if;

  insert into public.stripe_customer_links (stripe_customer_id, user_id, livemode, linked_by_event)
  values (p_customer_id, p_user_id, p_livemode, p_event_id)
  on conflict (stripe_customer_id) do nothing;
  if found then
    return 'linked';
  end if;

  select user_id, livemode into v_user_id, v_livemode
    from public.stripe_customer_links where stripe_customer_id = p_customer_id;
  if v_livemode <> p_livemode then
    return 'mode_mismatch';
  end if;
  return case when v_user_id = p_user_id then 'already_linked' else 'mismatch' end;
end;
$$;
