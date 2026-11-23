# stripe-subscription-sync

A small module that keeps a database copy of Stripe subscription state correct when webhooks arrive duplicated, out of order, concurrently, or while a worker crashes. It comes with plain-Postgres SQL, Supabase RLS/grants, thin adapters (Next.js route, Supabase RPC, Postgres query), and a minimal [Next.js + Supabase example](examples/nextjs-supabase).

It is meant to be read, copied into your project, and adapted. It is a reference implementation, not an audited library ([SECURITY.md](SECURITY.md)).

## What it does

- **Verify and record:** verifies the webhook signature on the raw body, then records each event once in `stripe_events` with a claim, so duplicates and concurrent deliveries apply once and a crashed worker's event is picked up again.
- **Write from Stripe, not the payload:** for subscription and invoice events, re-fetches the subscription from Stripe and writes it with compare-and-swap on a per-row `revision`.
- **Tombstone cancellations:** cancelled subscriptions become tombstones that later, stale writes cannot undo.
- **Link customers to users:** links a Stripe customer to your user id from `checkout.session.completed` (`client_reference_id`).
- **Entitlement on read:** computes a user's entitlement when it is read, from their rows, with a policy you own.

## What it does not do

Checkout creation, authentication, UI, email, customer management, admin or reconciliation endpoints, plugins or hooks. See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) for what v1 leaves to you. That includes recovering from events Stripe has stopped retrying.

## 15-minute reading map

You will not absorb every SQL edge case in 15 minutes. You will know which files matter and which parts are yours to change.

| # | Read | Purpose |
|---|---|---|
| 1 | This README, then [docs/SYNC_MODEL.md](docs/SYNC_MODEL.md) | The algorithm in under 50 lines |
| 2 | [src/core/process-event.ts](src/core/process-event.ts) | `processEvent()`, the three handlers, the retry loop, payload mapping |
| 3 | [src/core/types.ts](src/core/types.ts) | Every interface the core depends on (all injected) |
| 4 | [src/policy/entitlements.ts](src/policy/entitlements.ts) | The EXAMPLE entitlement policy and `getEntitlement()` |
| 5 | [src/adapters/sql-functions.ts](src/adapters/sql-functions.ts) + [sql/schema.sql](sql/schema.sql) | The store, and the SQL functions where the atomicity lives |
| 6 | [sql/supabase.sql](sql/supabase.sql) | RLS and grants |
| 7 | [tests/concurrency.test.ts](tests/concurrency.test.ts), [tests/lifecycle.test.ts](tests/lifecycle.test.ts) | The behaviour, as forced interleavings with database assertions |
| 8 | [Extension points](#the-five-extension-points) and [What to change / What NOT to touch](#what-to-change--what-not-to-touch) below | Where your code goes |

## Setup

1. **Get the code.** Copy `src/` and `sql/` into your project. Or depend on this repository and import from `stripe-subscription-sync` after `npm run build`. There are no runtime dependencies: you pass in your own `stripe`, `pg` or supabase-js client.
2. **Create the tables.** Run [sql/schema.sql](sql/schema.sql). On Supabase, also run [sql/supabase.sql](sql/supabase.sql), for example as migrations or in the SQL editor.
3. **Wire a route.** This is the Next.js App Router version; [examples/nextjs-supabase](examples/nextjs-supabase) has the full file:

   ```ts
   import Stripe from 'stripe';
   import { createNextWebhookHandler, fromStripeSdk, supabaseStore } from 'stripe-subscription-sync';

   export const runtime = 'nodejs';
   const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
   const store = supabaseStore(serviceRoleSupabaseClient); // or postgresStore(pgPool)
   export const POST = createNextWebhookHandler({
     stripe, webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
     sync: { store, stripe: fromStripeSdk(stripe) },
   });
   ```

4. **Subscribe to events.** In Stripe, send the endpoint `checkout.session.completed`, `customer.subscription.created/updated/deleted`, `invoice.paid` and `invoice.payment_failed`.
5. **Set `client_reference_id` on the server.** Your server must set it to the authenticated user's id when it creates the Checkout Session. That code is not in this repo; see [SECURITY.md](SECURITY.md).
6. **Read entitlement** with `await getEntitlement(store, userId)`, passing the user id from your own auth.

Other frameworks: call [`processEvent(event, deps)`](src/core/process-event.ts) after verifying the signature yourself. It returns the HTTP status to answer with. [src/adapters/nextjs.ts](src/adapters/nextjs.ts) is a 50-line example of doing that.

## The five extension points

| # | Extension point | Where | Default | Tests |
|---|---|---|---|---|
| 1 | Entitlement policy | [src/policy/entitlements.ts](src/policy/entitlements.ts): pass your own `(rows) => E` to `getEntitlement` | EXAMPLE: `'active'` if ANY subscription is `active` or `trialing`, else `'none'` | [entitlements.test.ts](tests/entitlements.test.ts), [lifecycle.test.ts](tests/lifecycle.test.ts) |
| 2 | User mapping | [src/config/user-mapping.ts](src/config/user-mapping.ts) (`UserResolver`, or `deps.users`) | `client_reference_id` → `stripe_customer_links` → user id. Missing or invalid: fail and retry | [user-mapping.test.ts](tests/user-mapping.test.ts) |
| 3 | Persistence adapter and schema mapping | `SyncStore` in [types.ts](src/core/types.ts); [postgres.ts](src/adapters/postgres.ts), [supabase.ts](src/adapters/supabase.ts); columns in `toSnapshot()` ([process-event.ts](src/core/process-event.ts)) + `Snapshot` + [schema.sql](sql/schema.sql) | Postgres via `query()`, Supabase via `rpc()`, both calling the same SQL functions | every behaviour test runs on both adapters; [payload-shapes.test.ts](tests/payload-shapes.test.ts) |
| 4 | Enabled event handlers | [src/config/events.ts](src/config/events.ts) (`deps.enabledEvents`) | All six implemented handlers. Unknown names throw at startup | [webhook-delivery.test.ts](tests/webhook-delivery.test.ts) (`unknown_and_disabled_events_are_acknowledged_as_ignored`) |
| 5 | Logger | `Logger` in [types.ts](src/core/types.ts) (`deps.logger`), any subset of `info/warn/error` | none | n/a |

**Adding a stored column** (extension point 3) takes three edits:

1. return the field from `toSnapshot()`;
2. add it to `Snapshot`;
3. add the column, and its line in `apply_subscription_snapshot`, in `schema.sql`.

## What to change / What NOT to touch

**Change freely:** the five extension points above.

**Do not casually change** the parts below. They are deliberately not configurable, and each has tests that fail if it is weakened. Each mechanism was checked by breaking it on purpose and confirming that a test fails.

| Mechanism | Implementation | Tests |
|---|---|---|
| Claim ownership and takeover (120 s) | `claim_event`, `finish_event`, `holds_event_claim` in [schema.sql](sql/schema.sql) | `duplicate_while_processing_is_not_acknowledged_then_succeeds_after_first_finishes`, `stale_worker_cannot_apply_after_claim_takeover`, `expired_worker_cannot_mark_another_workers_attempt` ([concurrency](tests/concurrency.test.ts), [delivery](tests/webhook-delivery.test.ts)) |
| Atomic revision compare-and-update | `apply_subscription_snapshot` in [schema.sql](sql/schema.sql); `syncSubscription()` in [process-event.ts](src/core/process-event.ts) | `overlapping_fetches_never_overwrite_a_newer_committed_write`, `conflict_retries_exhausted_leaves_event_failed_and_retryable` |
| First-insert handling | `INSERT ... ON CONFLICT` in `apply_subscription_snapshot` | `concurrent_first_insert_creates_one_subscription` |
| Tombstones | `tombstoned_at` in `apply_subscription_snapshot`; terminal check in `syncSubscription()` | `deleted_subscription_is_not_resurrected`, `deleted_event_with_non_terminal_fetch_is_retried` |
| Retry and crash recovery | `processEvent()` status handling; `claim_event` takeover | `crash_after_insert_is_recovered_on_retry`, `missing_required_field_fails_without_state_change_then_retry_succeeds`, `subscription_before_checkout_link_fails_then_succeeds_after_link` |

## Guarantees, and the test for each

Every test except the policy unit tests asserts database state, against a real Postgres.

| Guarantee | Test |
|---|---|
| Bad or missing signature: 400, nothing written | `bad_signature_writes_nothing` |
| A duplicate of a finished event: 200, no effect | `duplicate_event_does_not_apply_twice` |
| Concurrent deliveries of one event (two connections) apply once | `concurrent_duplicate_deliveries_apply_once` |
| A duplicate while another worker holds a fresh claim is not acknowledged (409), and no transaction is open during the Stripe call | `duplicate_while_processing_is_not_acknowledged_then_succeeds_after_first_finishes` |
| Concurrent first writes create one row | `concurrent_first_insert_creates_one_subscription` |
| A stale fetch never overwrites a newer committed write | `overlapping_fetches_never_overwrite_a_newer_committed_write` |
| Conflicts are retried 5 times; then the event is `failed` and retryable | `conflict_retries_exhausted_leaves_event_failed_and_retryable` |
| A worker whose claim was taken over cannot write, or mark the event | `stale_worker_cannot_apply_after_claim_takeover`, `expired_worker_cannot_mark_another_workers_attempt` |
| A crash after the claim does not strand the event | `crash_after_insert_is_recovered_on_retry` |
| Missing required fields: 500, nothing written, retry succeeds | `missing_required_field_fails_without_state_change_then_retry_succeeds` |
| A cancelled subscription is never brought back | `deleted_subscription_is_not_resurrected`, `deleted_event_with_non_terminal_fetch_is_retried` |
| One subscription's cancellation does not revoke another | `cancellation_does_not_revoke_another_active_subscription` |
| Invoice subscription id read from both shapes; period fields from both locations; product as id or object | `invoice_new_and_old_shape`, `period_fields_new_and_legacy_location`, `product_as_id_string` |
| Plan changes and cancel-at-period-end are reflected | `downgrade_and_cancellation` |
| Entitlement comes from committed rows only | `entitlement_reflects_latest_committed_rows` |
| Missing or invalid user mapping fails and retries; links and owners never move | `subscription_before_checkout_link_fails_then_succeeds_after_link`, `checkout_without_client_reference_id_fails_and_writes_nothing`, `customer_link_is_never_reassigned`, `subscription_owner_never_changes` |
| Unknown or disabled events: 200, recorded `ignored` | `unknown_and_disabled_events_are_acknowledged_as_ignored` |
| Supabase roles: own rows only, `anon` reads nothing, `authenticated` writes nothing and cannot execute the functions | `other_users_subscription_not_readable`, `anon_cannot_read`, `authenticated_cannot_write`, `function_not_executable_by_authenticated` (on a role stand-in, see below) |

Compare-and-swap prevents concurrent local workers from overwriting a subscription snapshot without noticing an intervening database write; it does not guarantee that Stripe API reads are globally linearizable or always reflect the newest possible state.

## Running the tests

```sh
npm ci
npm run check        # lint, typecheck, tests, build
```

By default the tests download nothing extra at run time. They start a throwaway Postgres from the `embedded-postgres` dev dependency, so Docker is not needed.

To use your own server instead, set `DATABASE_URL`, for example with `docker compose up -d` and `DATABASE_URL=postgres://postgres:postgres@localhost:54329/sss_test`. The tests drop and recreate the `public` schema, so they refuse any database whose name does not contain `test`. No Stripe account is needed: signatures use the real Stripe SDK with a fake secret, and retrieval uses an in-memory [FakeStripe](tests/support/fake-stripe.ts) whose delays the tests control.

## Supabase notes

- [sql/supabase.sql](sql/supabase.sql) enables RLS on all three tables, revokes everything, then grants explicitly. `authenticated` gets `SELECT` on its own `stripe_subscriptions` rows. Only `service_role` gets writes and function `EXECUTE`. No function is `SECURITY DEFINER`, and every function has a fixed `search_path`.
- Supabase stopped auto-granting `anon`/`authenticated`/`service_role` on new tables in `public`. The change applied to new projects from 30 May 2026 and to all existing projects from **30 October 2026** ([Supabase changelog](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically); [hardening guide](https://supabase.com/docs/guides/api/hardening-data-api)). Because the grants here are explicit, this module should not depend on that default either way. That has not been tested on a real Supabase project.
- The permission tests run on plain Postgres with a stand-in for Supabase's roles and `auth.uid()` ([tests/support/supabase-shim.sql](tests/support/supabase-shim.sql)). They test the SQL, not Supabase itself.

## Compatibility

| Status | What |
|---|---|
| **Tested** (all checks run locally on Windows 11 on 2026-11-23; CI has not run yet) | Node 26.13.1; Postgres 17 (embedded-postgres 17.11.0-beta.19); `pg` 8.23.1; `stripe` 23.1.0 for signature verification; TypeScript 6.0.3; example app typecheck and `next build` with Next 16.4.5, React 19.2.9, supabase-js 2.119.0 |
| **Expected to work** (configured, not yet run) | Node 22.12+ and 24 (the CI matrix); Postgres 17 as a service container in GitHub Actions; `docker-compose.yml` |
| **Unverified** | A real Supabase project (RLS tested only on the role stand-in; supabase-js `rpc` only through a stub with the same contract); a live Stripe sandbox; real Stripe payloads (all fixtures are synthetic); Stripe API versions other than the 2025-03-31.basil and 2025-02-24.acacia shapes; Postgres versions other than 17; edge runtimes; the embedded-postgres test setup on macOS or Linux (only run on Windows; npm 11 may skip its install script there, so use `DATABASE_URL` if it fails) |

## Size

`src/` is 650 lines: `process-event.ts` 226, `types.ts` 123, `errors.ts` 26, the rest under 75 each. `sql/schema.sql` is 246 lines.

## Docs

[docs/SYNC_MODEL.md](docs/SYNC_MODEL.md) · [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) · [SECURITY.md](SECURITY.md) · [fixtures/README.md](fixtures/README.md) · [PLAN.md](PLAN.md)
