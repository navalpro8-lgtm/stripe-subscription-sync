# Sync model

Stripe is the source of truth. An event only says *which* subscription to look at. Its payload is never written as state: every write comes from a fresh `subscriptions.retrieve`.

## Event lifecycle (`stripe_events`)

1. The adapter verifies the signature on the raw body (`await req.text()`). Bad or missing signature: 400, nothing written. An event whose `livemode` differs from `SyncDeps.livemode`: 400 `livemode_mismatch`, nothing written. A Connect event (`account` set) is claimed and recorded as `ignored` (`connect_event_unsupported`); nothing is fetched.
2. `claim_event(event_id, type, token, livemode)` inserts the event as `processing` with a random `claimed_by` token. It takes over an existing row atomically only if that row is `failed` or its claim is older than `claimTimeoutSeconds` (default 120 s). Otherwise it returns `done` (succeeded / skipped / ignored: 200, no effect) or `busy` (another worker holds a fresh claim: 409, so Stripe retries later).
3. The handler runs. `finish_event(event_id, token, status)` sets `succeeded`, `skipped`, `ignored` or `failed` only `WHERE claimed_by = token AND status = 'processing'`. If no row matches, the claim was lost and the response is 500.
4. `failed` returns 500; Stripe redelivers and step 2 reclaims it. A crash leaves a `processing` row whose claim goes stale, and the next delivery takes it over, so no event is stranded.

## Subscription write (compare-and-swap on `revision`)

1. `begin_subscription_read` returns the stored revision `r` (0 if no row) and takes a `read_seq` from a database sequence. Events take one from the same sequence when they first arrive (`received_seq`).
   - **Read-order shortcut (opt-in, `readOrderShortcut: true`; default off).** If the stored row's `read_seq` is greater than this event's `received_seq`, that row came from a Stripe read that began after this event arrived. The event then ends as `skipped`, with no fetch. Deleted events never take it.
   - **Assumption:** a Stripe read that starts after an event arrived reflects that event's change. Stripe does not document this. When a read is stale, the shortcut leaves the row stale until the next event for that subscription arrives (`shortcut_on_keeps_a_stale_read_documented_risk`). With the shortcut off, the event fetches for itself (`shortcut_off_converges_after_a_stale_read`).
2. Fetch the subscription from Stripe. No database transaction is open during the call.
3. `apply_subscription_snapshot(subscription_id, r, token, event_id, snapshot)` runs one short transaction:
   a. lock the event row; if `claimed_by <> token` or status is not `processing`, return `claim_lost`;
   b. `INSERT ... ON CONFLICT (subscription_id) DO UPDATE ... WHERE revision = r AND tombstoned_at IS NULL AND user_id = <snapshot user>`, writing revision `r + 1` and this read's `read_seq`;
   c. if no row was written, return `tombstoned`, `user_mismatch` or `conflict`. Nothing is written in any of these cases.
4. `conflict`: go back to step 1 and fetch again (with the shortcut on, step 1 usually ends it as `skipped` instead). At most 5 retries (6 attempts) with 10–50 ms jitter. Exhausted: event `failed`, 500, Stripe retries.
5. Rows are never physically deleted. A snapshot with a terminal status (`canceled`, `incomplete_expired`) sets `tombstoned_at` and keeps its revision. Later snapshots for that row are refused (`tombstoned`, event `skipped`), so a delayed worker or a stale read cannot bring it back.
6. For `customer.subscription.deleted`, a fetch that does not yet show a terminal status fails the event so Stripe retries, instead of writing a non-terminal state.

Compare-and-swap prevents concurrent local workers from overwriting a subscription snapshot without noticing an intervening database write; it does not guarantee that Stripe API reads are globally linearizable or always reflect the newest possible state.

## What each event does

| Event | Effect |
|---|---|
| `customer.subscription.created/updated/deleted` | write for `data.object.id` |
| `invoice.paid`, `invoice.payment_failed` | write for `invoice.subscription` or `invoice.parent.subscription_details.subscription`; neither present: `skipped` |
| `checkout.session.completed` | link `customer` to `client_reference_id` only; `mode` not `subscription`: `skipped` |
| anything else, or not enabled | `ignored`, 200 |

A required snapshot field missing from the fetched subscription, or a fetched subscription, stored row or customer link from the other Stripe mode: event `failed`, 500, nothing written.

## Ownership and entitlement

A subscription's user comes from `stripe_customer_links` (filled by `checkout.session.completed`). No link yet, e.g. `subscription.created` arriving before checkout completes: `failed`, retried, succeeds once the link exists. A link never moves to another user, and a row's `user_id` never changes. Entitlement is computed on read from the user's rows by a pure policy; no aggregate is stored.
