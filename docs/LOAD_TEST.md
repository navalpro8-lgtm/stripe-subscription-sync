# Load test notes: compare-and-swap vs an advisory lock

Synthetic, local, one machine. These numbers say nothing about real Stripe latency, Supabase, or a deployed server. The setup for scenarios A–C is in the README, "Load test".

The idea for this comparison came from Sunnatulla, dev.to. He measured a lock variant on his own setup. The numbers below are from my runs of [bench/load-test.mjs](../bench/load-test.mjs), not his.

## Scenario D: one hot subscription and 50 others at the same time

Same setup for both variants:

- 100 connections send distinct `customer.subscription.updated` events for one subscription (`sub_hot`). Its Stripe price changes every 200 of those requests.
- At the same time, 50 connections send distinct events spread over 50 other subscriptions.
- 10 s of load, a `pg` pool of 20 connections, fake Stripe at 20–80 ms per read, read-order shortcut off.

The two variants:

- **cas:** the library as shipped. A write succeeds only if the row's `revision` is unchanged since it was read; a conflict re-reads Stripe and retries, up to 8 times, then the event fails with a 500 for Stripe to redeliver.
- **advisory_lock:** in the bench script only, not in the library. Each request takes a pool connection, waits for `pg_advisory_lock` on its subscription id, and runs the whole event on that connection, holding the lock across the Stripe fetch.

```sh
npm run build && npm i --no-save autocannon@8.0.0 && node bench/load-test.mjs --lock-comparison-only
```

## Results

Windows 11 laptop, Node 26.13.1, embedded Postgres 17, 2026-11-28. Two runs; the second was part of a full run (A–D).

| Variant | Run | Hot subscription: failed events | Other 50 subscriptions: writes completed | Total time |
|---|---|---|---|---|
| cas | 1 | 346 of 608 (57%) | 5,090 (2 failed) | 12.8 s |
| cas | 2 | 360 of 630 (57%) | 5,192 (4 failed) | 12.8 s |
| advisory_lock | 1 | 0 of 244 | 100 | 16.8 s |
| advisory_lock | 2 | 0 of 245 | 100 | 16.8 s |

- "Total time" is from the start of the load until the server finished every request, including the ones still in flight when the 10 s ended. In run 1 that drain took 2.7 s for cas and 6.6 s for the lock.
- Event counts include those in-flight requests, so they are higher than autocannon's request counts by the number of connections.
- In both variants and both runs every database check held: one write per succeeded event, every row ended at Stripe's state after the settle step, and nothing was left `processing`.

## What this shows

- **The lock removes the hot-subscription failures.** Events for `sub_hot` ran one at a time, so none lost a revision check.
- **The lock starved everything else.** Each waiter held a pool connection while it waited, so the 20 connections were taken by `sub_hot` waiters. The other 50 subscriptions got 100 writes instead of about 5,100. That is one finished request per connection, plus the one still waiting when the load stopped, which finished during the drain. In run 1 their median latency went from 72 ms (cas) to 6.4 s (lock).
- **With cas, the cost stays on the hot subscription.** About 57% of its events failed and rely on Stripe's redelivery. The other subscriptions were barely affected.
- 100 events at once for one subscription is far more than real subscriptions usually see (bursts of 2 to 5).

The design choice and its tradeoffs: [WHY_NOT_A_LOCK.md](WHY_NOT_A_LOCK.md).
