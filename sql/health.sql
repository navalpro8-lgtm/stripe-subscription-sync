-- stripe-subscription-sync: read-only health queries. Run them by hand or from your monitoring.
-- None of them changes anything. Thresholds are suggestions; see docs/RUNBOOK.md for what to do.

-- 1. Claims that look abandoned: still 'processing' long after the default 120 s takeover
--    threshold. Normally the next delivery takes them over; rows here mean nothing redelivered.
select event_id, event_type, attempts, claimed_at, now() - claimed_at as claim_age
  from public.stripe_events
 where status = 'processing' and claimed_at < now() - interval '10 minutes'
 order by claimed_at;

-- 2. Failed webhook events by type. Stripe redelivers these within its retry window.
select event_type, count(*) as failed, min(updated_at) as oldest, max(updated_at) as newest
  from public.stripe_events
 where status = 'failed' and event_type <> 'reconcile'
 group by event_type
 order by failed desc;

-- 3. Failed webhook events older than Stripe's live-mode retry window (up to three days):
--    Stripe has probably stopped retrying them. Recover per docs/RUNBOOK.md.
select event_id, event_type, attempts, created_at, updated_at, last_error
  from public.stripe_events
 where status = 'failed' and event_type <> 'reconcile' and created_at < now() - interval '3 days'
 order by created_at;

-- 4. The most common recent errors (last 24 hours). last_error is redacted by the module.
select left(last_error, 160) as error, count(*) as events
  from public.stripe_events
 where status = 'failed' and updated_at > now() - interval '24 hours'
 group by 1
 order by events desc
 limit 20;

-- 5. Failed reconcile runs. Nothing retries these; rerun reconcileSubscription after fixing the cause.
select event_id, created_at, last_error
  from public.stripe_events
 where event_type = 'reconcile' and status = 'failed'
 order by created_at desc
 limit 50;

-- 6. Event outcomes in the last 24 hours.
select status, count(*) as events
  from public.stripe_events
 where created_at > now() - interval '24 hours'
 group by status
 order by status;

-- 7. Stripe mode of the stored rows. One endpoint serves one mode; more than one value per table
--    means two modes share these tables.
select 'stripe_events' as table_name, livemode, count(*) as rows from public.stripe_events group by livemode
union all
select 'stripe_customer_links', livemode, count(*) from public.stripe_customer_links group by livemode
union all
select 'stripe_subscriptions', livemode, count(*) from public.stripe_subscriptions group by livemode
order by 1, 2;
