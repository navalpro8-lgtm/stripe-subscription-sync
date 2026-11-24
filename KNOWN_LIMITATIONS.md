# Known limitations

## Reconciliation is manual

The module reacts to webhooks. If events are lost for good, a row can drift from Stripe, and nothing notices automatically. Stripe retries a failed delivery for up to three days in live mode, and three times over a few hours in a sandbox ([Stripe webhooks docs](https://docs.stripe.com/webhooks#automatic-retries)).

`reconcileSubscription` and `reconcileCustomer` repair drift through the same compare-and-swap path, but only when you call them. There is no scheduled job, and no function that walks a whole Stripe account. [docs/RUNBOOK.md](docs/RUNBOOK.md) says when and how to run them, and [sql/health.sql](sql/health.sql) finds the events that need it.

## The entitlement policy is an example

`exampleEntitlementPolicy` treats `active` and `trialing` as access and everything else as no access: no grace period for `past_due`, no per-product rules, no seats. Replace it ([src/policy/entitlements.ts](src/policy/entitlements.ts)).

## Checkout is out of scope

Creating Checkout Sessions, setting `client_reference_id`, customer portals and plan pages are yours. The default user mapping depends on your server setting `client_reference_id` correctly; see [SECURITY.md](SECURITY.md).

## Other limits

- **Items:** every item is stored in `items`. The top-level `price_id`, `product_id`, `quantity` and period columns repeat the *first* item only, for simple queries; write per-product rules against `items`. If Stripe marks the embedded item list incomplete (`has_more`), the rest is paged with `subscriptionItems.list` (100 per page, at most 100 pages). Any failed page fails the event, and nothing is written. The pages are separate Stripe reads, so an item change between them can produce a mixed list. The next event for the subscription repairs it. A custom `SubscriptionRetriever` without `listSubscriptionItems` fails such events instead.
- **Stripe reads can be stale.** Compare-and-swap protects against concurrent local writers. It does not make Stripe's API reads linearizable: a fetch can return a state older than one already seen. Tombstones stop a stale read from undoing a cancellation, and a `customer.subscription.deleted` event whose fetch is not yet terminal is retried. A stale read of a live state can still briefly overwrite a newer live state until the next event. The stale-read guard catches one common case: a fresh `customer.subscription.updated` event whose fetch still shows the event's own `previous_attributes` for `status` or `cancel_at_period_end`. That fetch is retried, not written (tested). It cannot catch staleness in other fields, in other event types, or in events older than 60 s. The opt-in read-order shortcut adds a stronger assumption: a Stripe read that begins after an event arrived reflects that event's change. When that read is stale, the shortcut skips the event and the row stays stale until the next event for the subscription. That is why it is off by default.
- **Many events for one subscription at once:** with the shortcut off (default), every write to one row needs its own Stripe read, so one row takes only a few writes per second. Conflicting writers back off exponentially, for up to 8 retries. Under heavy contention some events still exhaust them, and are left `failed` for Stripe to redeliver. In the synthetic load test, 100 connections hammering one subscription left 56% of events failed; spread over 50 subscriptions, 0.5% were. Real subscriptions usually see bursts of 2 to 5 events, not 100. With the shortcut on, most of these end as `skipped` without a fetch, at the risk above.
- **A subscription Stripe cannot find (404) fails the event** and is retried until Stripe gives up. There is no special handling.
- **The claim takeover threshold** (`claimTimeoutSeconds`, default 120 s) is a timeout, not a lease the worker renews. A worker that runs longer loses its claim; it then cannot write or mark anything (tested, including when it finishes last), and the next delivery completes the work. See the README, "Choosing `claimTimeoutSeconds`".
- **Once tombstoned, a row never changes again**, including later field corrections Stripe might make to a canceled subscription.
- **One Stripe mode per endpoint.** `SyncDeps.livemode` is required. Events, fetched subscriptions, stored rows and customer links from the other mode are refused without writing (tested). Every row stores its `livemode`. Still, use separate databases (or schemas) per mode: `find_user_for_customer` does not filter by mode, and the refusals are a safety net, not a way to share tables.
- **One Stripe account; Connect is unsupported.** Events with an `account` field (from connected accounts) are recorded as `ignored` with `last_error = 'connect_event_unsupported'`, and nothing is fetched. Multiple Stripe accounts writing to the same tables are not supported: subscription and customer ids are not namespaced by account.
- **Stripe API versions:** the automated tests use synthetic 2025-03-31.basil and 2025-02-24.acacia shapes (see [fixtures/README.md](fixtures/README.md)). The manual sandbox runs also passed with 2026-09-30.endive events and 2026-10-28.endive subscriptions. Other versions were not checked.
- **Supabase** has been checked on one real project, manually, including Checkout-driven linking. Data API access with a real user JWT was not exercised; see the README's compatibility table.
