-- Migration 0003 (contract): v0.1.0 -> v0.2.0, step 2 of 2. Run only after every webhook route
-- and job runs v0.2.0 (v0.1.0 code stops working after this). Same file on Supabase.
--
--   - drops the livemode defaults (catalog-only: no rewrite or scan);
--   - drops the v0.1.0 claim_event and link_customer signatures;
--   - gives apply_subscription_snapshot its final body (livemode required in the snapshot).
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f sql/migrations/0003_v0.2.0_contract.sql

set local lock_timeout = '5s';

alter table public.stripe_events alter column livemode drop default;
alter table public.stripe_customer_links alter column livemode drop default;
alter table public.stripe_subscriptions alter column livemode drop default;

drop function public.claim_event(text, text, uuid);
drop function public.link_customer(text, text, text, uuid);

-- As in sql/schema.sql.
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
  v_livemode boolean := (p_snapshot->>'livemode')::boolean;
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
