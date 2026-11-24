# Runbook: events lost for good

Use this when a subscription row may no longer match Stripe because Stripe has stopped redelivering an event. That happens:

- after its retry window: up to three days in live mode, or three attempts over a few hours in a sandbox ([Stripe docs](https://docs.stripe.com/webhooks#automatic-retries));
- when the endpoint was down or misconfigured for longer than that;
- when the endpoint was disabled.

Nothing here runs automatically.

## 1. Find what is affected

Run [sql/health.sql](../sql/health.sql). The queries that matter here are:

- **Query 3:** failed webhook events older than three days. Stripe has probably stopped retrying them.
- **Query 1:** claims abandoned in `processing`. Nothing redelivered them.
- **Query 4:** the most common errors. Fix the cause before you repair anything.

`last_error` is redacted and ends with `[correlation <uuid>]`. Search your logs for that id to find the `stripe_sync.event` line for the attempt.

If your endpoint was down, check Stripe's Dashboard (Workbench → Webhooks → your endpoint) for failed deliveries in that period. Events that never reached your database leave no row.

## 2. Fix the cause

| `last_error` says | Fix |
|---|---|
| `No user linked to customer cus_…` | The `checkout.session.completed` that links it failed or was never sent. Fix that event first (step 3). Or, if you know the user, insert the link yourself, with the right `livemode`. |
| `livemode=…, endpoint expects …` / `other Stripe mode` | The endpoint is configured for the wrong mode, or Stripe sends this endpoint events from the other mode. Fix `livemode` or the Stripe endpoint. |
| `Missing required field …` | Your Stripe API version returns a shape `toSnapshot()` does not read. Update the mapping. |
| `Revision conflict … gave up` | Heavy contention on one subscription. It usually clears on redelivery or reconcile. |
| Stripe API errors | Check the key and Stripe's status page. |

## 3. Repair

Prefer the first option that applies.

1. **Resend the event.** In the Dashboard this works up to 15 days after the event was created; `stripe events resend <evt_id>` works up to 30 days ([Stripe docs](https://docs.stripe.com/webhooks#manual-retries)). The normal path then re-fetches and writes. A `failed` row is taken over by the redelivery.
2. **Reconcile the subscription** when the event is too old to resend, or you don't know which events were lost. This needs `listCustomerSubscriptions` on the retriever only for `reconcileCustomer`; `fromStripeSdk` provides both.

   ```ts
   import Stripe from 'stripe';
   import { fromStripeSdk, postgresStore, reconcileSubscription, reconcileCustomer } from 'stripe-subscription-sync';

   const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
   const deps = { livemode: false, store: postgresStore(pool), stripe: fromStripeSdk(stripe) };

   const one = await reconcileSubscription('sub_…', deps);          // { outcome: 'applied' | 'tombstoned' | 'failed', reason? }
   const all = await reconcileCustomer('cus_…', deps);              // { results, truncated }
   ```

   Run it with the same `livemode`, store and user mapping as the webhook route. It is safe while webhooks keep arriving: both use compare-and-swap. Each run adds one `stripe_events` row with type `reconcile`.

3. **Many customers:** loop over the customer ids you need, from your own data or from query 3, and call `reconcileCustomer` for each. Keep an eye on Stripe's rate limits. The module has no "reconcile everything" function.

## 4. Check

- Rerun health query 3. The repaired events stay `failed`, because a reconcile writes its own row and does not touch old events. Judge the repair by each result's `outcome`, not by query 3.
- Every `failed` result has a `reason`. `unlinked_customer` and `mode_mismatch` need step 2 first. `retries_exhausted` and `error` can be rerun.
- Query 5 lists reconcile runs that failed.
