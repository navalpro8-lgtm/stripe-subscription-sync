# Why compare-and-swap and not a lock

The other common design is a per-subscription lock (for example a Postgres advisory lock) held across the Stripe fetch, so handlers for one subscription run one at a time. Scenario D of the synthetic load test measured both: one subscription hit by 100 connections while 50 others also get events, a pool of 20 connections, fake Stripe at 20–80 ms. Two local runs, details in [LOAD_TEST.md](LOAD_TEST.md):

| | Hot subscription: failed events | Other 50 subscriptions: writes | Total time |
|---|---|---|---|
| Compare-and-swap (shipped) | 57% (346 of 608; 360 of 630) | 5,090; 5,192 | 12.8 s |
| Advisory lock (bench only) | 0 | 100; 100 | 16.8 s |

What the lock does better:

- No failed events on a hot subscription, so nothing waits for Stripe's redelivery.
- One Stripe fetch per event. Compare-and-swap fetches again after every conflict, which adds to the rate-limit cost in [KNOWN_LIMITATIONS.md](../KNOWN_LIMITATIONS.md) ("Stripe rate limits").

What compare-and-swap does better:

- Nothing is held during the Stripe call. In the test, the lock's waiters held every pool connection, and the other 50 subscriptions dropped from about 5,100 writes to 100. With compare-and-swap the cost stayed on the hot subscription.
- It works through the Supabase RPC adapter. Each RPC call is a separate request, so a session lock cannot be held from before the fetch to after the write.
- A worker that hangs in the Stripe call blocks nobody. With the lock, every other event for that subscription waits for it.

What compare-and-swap costs: under heavy contention on one subscription, many events fail with a 500 and are applied only when Stripe redelivers them. The row still ends at Stripe's state, but it can lag until then.

Not tried: lock variants that might starve less, such as a separate pool for lock waiters or a try-lock with a timeout. The choice is compare-and-swap because one busy subscription should not slow down every other customer, and real subscriptions usually see bursts of 2 to 5 events, not 100 (an estimate from KNOWN_LIMITATIONS.md, not measured here). That would change if real traffic showed hot subscriptions failing often.
