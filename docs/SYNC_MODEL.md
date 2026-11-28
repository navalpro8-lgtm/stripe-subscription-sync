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
2. Fetch the subscription from Stripe. If its embedded item list has `has_more`, page through the rest; a failed page fails the event. No database transaction is open during these calls.
3. `apply_subscription_snapshot(subscription_id, r, token, event_id, snapshot)` runs one short transaction:
   a. lock the event row; if `claimed_by <> token` or status is not `processing`, return `claim_lost`;
   b. `INSERT ... ON CONFLICT (subscription_id) DO UPDATE ... WHERE revision = r AND tombstoned_at IS NULL AND user_id = <snapshot user>`, writing revision `r + 1` and this read's `read_seq`;
   c. if no row was written, return `tombstoned`, `user_mismatch` or `conflict`. Nothing is written in any of these cases.
4. `conflict`: go back to step 1 and fetch again (with the shortcut on, step 1 usually ends it as `skipped` instead). At most 8 retries (9 attempts), with exponential backoff and full jitter (up to 25, 50, 100 … ms, capped at 1 s). Exhausted: event `failed`, 500, Stripe retries.
5a. **Stale-read guard:** for a `customer.subscription.updated` event less than 60 s old, a fetch whose `status` or `cancel_at_period_end` still equals the event's `previous_attributes` value, while the event shows a different value, is a stale read. It is not written: back to step 1, after backoff. If every attempt is stale, the event is `failed` and Stripe retries it.
5. Rows are never physically deleted. A snapshot with a terminal status (`canceled`, `incomplete_expired`) sets `tombstoned_at` and keeps its revision. Later snapshots for that row are refused (`tombstoned`, event `skipped`), so a delayed worker or a stale read cannot bring it back.
6. For `customer.subscription.deleted`, a fetch that does not yet show a terminal status fails the event so Stripe retries, instead of writing a non-terminal state.

Compare-and-swap prevents concurrent local workers from overwriting a subscription snapshot without noticing an intervening database write; it does not guarantee that Stripe API reads are globally linearizable or always reflect the newest possible state.

Why this and not a per-subscription lock, with measured numbers: [WHY_NOT_A_LOCK.md](WHY_NOT_A_LOCK.md).

## Reconciliation

`reconcileSubscription(id, deps)` and `reconcileCustomer(customerId, deps)` are library functions. Nothing schedules them.

- **Same path:** a run claims a synthetic `stripe_events` row (`reconcile:<sub>:<uuid>`, type `reconcile`) and then runs the subscription write above. That covers the claim, `begin_subscription_read`, a fresh Stripe read and `apply_subscription_snapshot`. It never takes the read-order shortcut.
- **Terminal subscriptions:** a tombstoned row is never changed (`tombstoned`). A first read that is already terminal writes the tombstone (`applied`).
- **A webhook arriving mid-reconcile:** both writers use compare-and-swap. Whichever commits second gets `conflict`, re-reads Stripe and writes that read. Neither overwrites the other without a fresh read. This is tested in both orders.
- **Stale reads:** a reconcile read is as fresh as Stripe makes it, and no fresher. A stale reconcile read can overwrite a newer live state until the next event or run, exactly like a stale webhook read.
- **Typed results:** `applied | tombstoned | failed`. A failure carries a reason: `not_found`, `unlinked_customer`, `owner_mismatch`, `mapping`, `mode_mismatch`, `retries_exhausted`, `claim_lost` or `error`. Expected failures are returned, not thrown. Database errors are thrown. A failed run records `failed` on its own row, and nothing retries it.
- **`reconcileCustomer`:** lists one customer's subscriptions with `status: 'all'`, 100 per page, following `starting_after`. It stops at `maxSubscriptions` (default 1000) with `truncated: true`. There is no "reconcile everything" function, because enumerating a whole account is unbounded.
- **`reconcileRecent`:** lists `customer.subscription.*` events created since `since` (100 per page, following `starting_after`), takes each subscription id once, and reconciles each on the same path, with one difference: after the Stripe read, if the stored row still has the revision read by `begin_subscription_read` and holds the same data, nothing is written (`unchanged`). Otherwise it calls `apply_subscription_snapshot` as usual. `reconcileSubscription` and webhooks always write. Stripe keeps events for about 30 days.

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
