# Known limitations (v1)

## No reconciliation endpoint

The module only reacts to webhooks. If events are lost for good, the table can drift from Stripe and nothing in v1 will notice. Stripe retries a failed delivery for up to three days in live mode, and only three times over a few hours in a sandbox ([Stripe webhooks docs](https://docs.stripe.com/webhooks)). An event that keeps failing (for example a subscription whose customer is never linked) will eventually stop being retried.

Recovery in v1 is manual:

1. Find events stuck as `failed` or `processing`: `select * from stripe_events where status in ('failed', 'processing') order by updated_at;`. `last_error` says why.
2. Fix the cause (link the customer, fix a schema mismatch, ...).
3. Resend the event from the Stripe Dashboard (up to 15 days after it was created) or with `stripe events resend <id>` (up to 30 days), per the same Stripe page. The normal path then re-fetches the subscription and writes it.

Anything older than that needs a script you write: list subscriptions from Stripe and run each through the same compare-and-swap path. That script is not part of v1.

## The entitlement policy is an example

`exampleEntitlementPolicy` treats `active` and `trialing` as access and everything else as no access: no grace period for `past_due`, no per-product rules, no seats. Replace it ([src/policy/entitlements.ts](src/policy/entitlements.ts)).

## Checkout is out of scope

Creating Checkout Sessions, setting `client_reference_id`, customer portals and plan pages are yours. The default user mapping depends on your server setting `client_reference_id` correctly; see [SECURITY.md](SECURITY.md).

## Other limits

- **Items:** every item is stored in `items`. The top-level `price_id`, `product_id`, `quantity` and period columns repeat the *first* item only, for simple queries; write per-product rules against `items`. If Stripe marks the embedded item list incomplete (`has_more`), the event fails rather than storing part of it, and v1 does not page through the list.
- **Stripe reads can be stale.** Compare-and-swap protects against concurrent local writers. It does not make Stripe's API reads linearizable: a fetch can return a state older than one already seen. Tombstones stop a stale read from undoing a cancellation, and a `customer.subscription.deleted` event whose fetch is not yet terminal is retried. A stale read of a live state can still briefly overwrite a newer live state until the next event. The opt-in read-order shortcut adds a stronger assumption: a Stripe read that begins after an event arrived reflects that event's change. When that read is stale, the shortcut skips the event and the row stays stale until the next event for the subscription. That is why it is off by default.
- **Many events for one subscription at once:** with the shortcut off (default), each event fetches from Stripe and conflicting writers retry, so under heavy contention some events exhaust their 5 retries and are left `failed` for Stripe to redeliver. The local load test reports how many, in both modes. With the shortcut on, most of them end as `skipped` without a fetch, at the risk above.
- **A subscription Stripe cannot find (404) fails the event** and is retried until Stripe gives up. There is no special handling.
- **The claim takeover threshold is a fixed 120 seconds** (in `claim_event`). A worker that runs longer can lose its claim; it then cannot write or mark anything (tested), and the next delivery completes the work.
- **Once tombstoned, a row never changes again**, including later field corrections Stripe might make to a canceled subscription.
- **Live and test mode share the tables.** Use separate databases (or schemas) per Stripe mode.
- **One Stripe account.** Stripe Connect and multiple accounts are not handled.
- **Stripe API versions:** the automated tests use synthetic 2025-03-31.basil and 2025-02-24.acacia shapes (see [fixtures/README.md](fixtures/README.md)). The manual sandbox runs also passed with 2026-09-30.endive events and 2026-10-28.endive subscriptions. Other versions were not checked.
- **Supabase** has been checked on one real project, manually, including Checkout-driven linking. Data API access with a real user JWT was not exercised; see the README's compatibility table.
