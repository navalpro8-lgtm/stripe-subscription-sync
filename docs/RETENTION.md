# Retention

The module never deletes rows, and it ships no deletion code. This page covers what you need to know before you add your own.

## What each table is for

| Table | Grows with | Why rows are kept |
|---|---|---|
| `stripe_events` | every delivered event, plus one row per reconcile run | **Deduplication.** The row for an event id is what makes a redelivery a no-op (`duplicate`) or lets it take over a failed or stale attempt. |
| `stripe_subscriptions` | subscriptions | The synced state. Tombstoned rows stop a delayed or stale write from resurrecting a cancelled subscription. |
| `stripe_customer_links` | customers | Ownership. Removing a link makes later events for that customer fail with `unlinked_customer`. |

## Dedupe scope

Duplicates are detected by **event id only**, and only while the event's row exists.

Stripe says an endpoint "might occasionally receive the same event more than once" ([docs](https://docs.stripe.com/webhooks#handle-duplicate-events)). It also notes that in some cases two different Event objects are sent for one change. Different event ids are not deduplicated. They are harmless here, because each one re-reads Stripe and writes through compare-and-swap. Both end at the same state, and the row's `revision` simply advances twice.

## Stripe's redelivery horizon

Checked against Stripe's docs on 2026-11-24:

| What | Window | Source |
|---|---|---|
| Automatic retries, live mode | up to three days, exponential backoff | [webhooks#automatic-retries](https://docs.stripe.com/webhooks#automatic-retries) |
| Automatic retries, sandbox | three times over a few hours | same |
| Manual resend, Dashboard | up to 15 days after the event was created | [webhooks#manual-retries](https://docs.stripe.com/webhooks#manual-retries) |
| Manual resend, `stripe events resend` | up to 30 days after creation | same; [CLI reference](https://docs.stripe.com/cli/events/resend) |
| Retrieve via the Events API | 30 days | [api/events](https://docs.stripe.com/api/events) |

So an event id can reach your endpoint again for **up to 30 days after it was created**, the longest of these windows. That holds as long as someone, or a script, can still resend it.

## The risk of purging `stripe_events`

If you delete an event's row and that event is delivered again, it is processed again as new.

- **Subscription events:** low risk. The handler re-reads Stripe and writes the current state, so a replay converges. It does not apply an old payload.
- **`checkout.session.completed`:** a replayed link is `already_linked`. If the customer has since been linked to someone else, it fails with `mismatch`. Nothing is overwritten.
- **Your own side effects:** if you add handlers that do things once (emails, credits, provisioning), purging re-enables doing them twice. That is the real risk, and it is outside this module.
- **Unfinished work:** deleting a `processing` or `failed` row loses the record that the event still needs work.

## If you purge anyway

- Delete only `succeeded`, `skipped` and `ignored` rows **older than 30 days**. Keep a margin; 90 days costs little.
- Never delete `failed` or `processing` rows. Resolve them first (see [RUNBOOK.md](RUNBOOK.md)).
- `reconcile` rows are records of manual runs. Deleting them changes nothing about deduplication.
- Never delete tombstoned `stripe_subscriptions` rows, or customer links you still need. Deleting a tombstone lets a delayed stale write recreate the subscription as live.
- The Supabase grants in `sql/supabase.sql` give nobody `DELETE`. Run a purge as the table owner.

An example you would adapt and schedule yourself; it is not shipped as code:

```sql
delete from public.stripe_events
 where status in ('succeeded', 'skipped', 'ignored')
   and created_at < now() - interval '90 days';
```
