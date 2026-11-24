# stripe-subscription-sync

A small module that keeps a database copy of Stripe subscription state correct when webhooks arrive duplicated, out of order, concurrently, or while a worker crashes. It comes with plain-Postgres SQL, Supabase RLS/grants, thin adapters (Next.js route, Supabase RPC, Postgres query), and a minimal [Next.js + Supabase example](examples/nextjs-supabase).

It is meant to be read, copied into your project, and adapted. It is a reference implementation, not an audited library ([SECURITY.md](SECURITY.md)). MIT licensed ([LICENSE](LICENSE)); changes are listed in [CHANGELOG.md](CHANGELOG.md), and [CONTRIBUTING.md](CONTRIBUTING.md) says how to propose one.

## What it does

- **Verify and record:** verifies the webhook signature on the raw body, then records each event once in `stripe_events` with a claim, so duplicates and concurrent deliveries apply once and a crashed worker's event is picked up again.
- **Write from Stripe, not the payload:** for subscription and invoice events, re-fetches the subscription from Stripe and writes it with compare-and-swap on a per-row `revision`. Every subscription item (base plan, add-ons, seats) is stored in the row's `items`.
- **Tombstone cancellations:** cancelled subscriptions become tombstones that later, stale writes cannot undo.
- **Link customers to users:** links a Stripe customer to your user id from `checkout.session.completed` (`client_reference_id`).
- **Entitlement on read:** computes a user's entitlement when it is read, from their rows, with a policy you own.
- **One Stripe mode per endpoint:** `livemode` is required; anything from the other mode is refused without writing.
- **Reconcile on demand:** `reconcileSubscription` / `reconcileCustomer` repair drift through the same write path. You call them; see [docs/RUNBOOK.md](docs/RUNBOOK.md).
- **Operable:** one structured, redacted log line per delivery, read-only health queries in [sql/health.sql](sql/health.sql), and a request body limit.

## What it does not do

Checkout creation, authentication, UI, email, customer management, admin or reconciliation endpoints, scheduled jobs, row deletion, Stripe Connect, plugins or hooks. See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) for what is left to you.

## 15-minute reading map

You will not absorb every SQL edge case in 15 minutes. You will know which files matter and which parts are yours to change.

| # | Read | Purpose |
|---|---|---|
| 1 | This README, then [docs/SYNC_MODEL.md](docs/SYNC_MODEL.md) | The algorithm in under 50 lines |
| 2 | [src/core/process-event.ts](src/core/process-event.ts) | `processEvent()`, the three handlers, the retry loop, payload mapping, logging |
| 2b | [src/core/reconcile.ts](src/core/reconcile.ts) | `reconcileSubscription()` / `reconcileCustomer()` on the same write path |
| 3 | [src/core/types.ts](src/core/types.ts) | Every interface the core depends on (all injected) |
| 4 | [src/policy/entitlements.ts](src/policy/entitlements.ts) | The EXAMPLE entitlement policy and `getEntitlement()` |
| 5 | [src/adapters/sql-functions.ts](src/adapters/sql-functions.ts) + [sql/schema.sql](sql/schema.sql) | The store, and the SQL functions where the atomicity lives |
| 6 | [sql/supabase.sql](sql/supabase.sql) | RLS and grants |
| 7 | [tests/concurrency.test.ts](tests/concurrency.test.ts), [tests/lifecycle.test.ts](tests/lifecycle.test.ts) | The behaviour, as forced interleavings with database assertions |
| 8 | [Extension points](#the-five-extension-points) and [What to change / What NOT to touch](#what-to-change--what-not-to-touch) below | Where your code goes |

## Setup

1. **Get the code.** Copy `src/` and `sql/` into your project, which is best if you want to own and edit it. Or install it as a package: it is not on npm yet, so point a git or `file:` dependency at this repository and run `npm run build` there. There are no runtime dependencies: you pass in your own `stripe`, `pg` or supabase-js client.
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
     // livemode is required: false for a sandbox or test mode, true for live mode.
     sync: { livemode: false, store, stripe: fromStripeSdk(stripe) },
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
| Claim ownership and takeover (`claimTimeoutSeconds`, default 120 s) | `claim_event`, `finish_event`, `holds_event_claim` in [schema.sql](sql/schema.sql) | `duplicate_while_processing_is_not_acknowledged_then_succeeds_after_first_finishes`, `stale_worker_cannot_apply_after_claim_takeover`, `old_worker_finishing_last_cannot_overwrite_the_new_outcome`, `expired_worker_cannot_mark_another_workers_attempt`, `claim_timeout_is_configurable` ([concurrency](tests/concurrency.test.ts), [delivery](tests/webhook-delivery.test.ts)) |
| Atomic revision compare-and-update | `apply_subscription_snapshot` in [schema.sql](sql/schema.sql); `syncSubscription()` in [process-event.ts](src/core/process-event.ts) | `overlapping_fetches_never_overwrite_a_newer_committed_write`, `conflict_retries_exhausted_leaves_event_failed_and_retryable` |
| First-insert handling | `INSERT ... ON CONFLICT` in `apply_subscription_snapshot` | `concurrent_first_insert_creates_one_subscription` |
| Read-order shortcut, opt-in (`readOrderShortcut`, default off) | `stripe_sync_seq`, `begin_subscription_read` in [schema.sql](sql/schema.sql); the `superseded` check in `syncSubscription()` | `event_already_covered_by_a_later_read_is_not_refetched`, `conflict_with_a_later_read_counts_as_done_without_retrying`, `shortcut_never_skips_a_deleted_event`; its risk: `shortcut_on_keeps_a_stale_read_documented_risk` |
| Tombstones | `tombstoned_at` in `apply_subscription_snapshot`; terminal check in `syncSubscription()` | `deleted_subscription_is_not_resurrected`, `deleted_event_with_non_terminal_fetch_is_retried` |
| Retry and crash recovery | `processEvent()` status handling; `claim_event` takeover | `crash_after_insert_is_recovered_on_retry`, `missing_required_field_fails_without_state_change_then_retry_succeeds`, `subscription_before_checkout_link_fails_then_succeeds_after_link` |

### Choosing `claimTimeoutSeconds`

A delivery holds its event's claim from `claim_event` until `finish_event`. After `claimTimeoutSeconds` (default 120, allowed 10 to 3600), the next delivery of the same event may take the claim over. Then the old worker can no longer write or mark anything; that is tested.

- **Too short:** a slow but healthy worker loses its claim. Its work is then wasted, and the event is fetched again by the next delivery. That is safe, but it costs extra Stripe calls, and the slow worker answers 500.
- **Too long:** after a crash, the event waits that long before a redelivery can take it over. Until then, redeliveries get 409.
- **How to pick:** set it above the longest time one delivery can take. That is up to 6 attempts, each a Stripe read plus item pages, plus your Stripe client's own timeout and retries, plus database time. On a serverless host, the platform's maximum function duration is a natural choice, because a worker cannot outlive it.

### Rotating the webhook secret

Checked against [Stripe's docs](https://docs.stripe.com/webhooks) on 2026-11-24.

- **Rolling:** in Workbench, an endpoint's signing secret can be rolled. The old secret either expires immediately or stays valid for up to 7 days.
- **During the overlap:** multiple secrets are active, and Stripe generates one signature per secret. The `Stripe-Signature` header then carries several `v1` entries, and `constructEvent` accepts the event if any one matches.

So `webhookSecret` stays a single string. To rotate:

1. Roll the secret with a delay, for example 24 hours.
2. Deploy the new secret before the old one expires.

Events keep verifying throughout, because each one is signed with both secrets. If you expire the old secret immediately, requests fail with 400 `bad_signature` until the new secret is deployed. Stripe retries them, so nothing is lost inside its retry window.

### Logs, health checks and limits

- **Logs:** every delivery ends with one `stripe_sync.event` line, at `info`, or `error` for 400 and 5xx. Its fields are `eventId`, `eventType`, `outcome`, `httpStatus`, `attempts` (Stripe reads in this delivery), `durationMs` and a fresh `correlationId`. Reconcile runs log `stripe_sync.reconcile`.
- **What is never logged:** payloads. Every string field, and every stored `last_error`, goes through `redact()`, which removes Stripe keys, `whsec_` secrets, JWTs and email addresses, and caps the length. A failed event's `last_error` ends with `[correlation <id>]`, so you can find its log line.
- **Health:** [sql/health.sql](sql/health.sql) has read-only queries for abandoned claims, failures, events past Stripe's retry window, failed reconcile runs and the stored modes.
- **Body limit:** the route rejects bodies over `maxBodyBytes` (default 1 MiB) with 413, before signature verification, and stops reading at the limit. Stripe does not document a maximum event size. Your host may have its own limit.
- **Retention:** see [docs/RETENTION.md](docs/RETENTION.md) before deleting any rows.

## Guarantees, and the test for each

Every test except the policy unit tests asserts database state, against a real Postgres.

| Guarantee | Test |
|---|---|
| Bad or missing signature: 400, nothing written | `bad_signature_writes_nothing` |
| A duplicate of a finished event: 200, no effect | `duplicate_event_does_not_apply_twice` |
| Concurrent deliveries of one event (two connections) apply once | `concurrent_duplicate_deliveries_apply_once` |
| A duplicate while another worker holds a fresh claim is not acknowledged (409), and no transaction is open during the Stripe call | `duplicate_while_processing_is_not_acknowledged_then_succeeds_after_first_finishes` |
| An event from the other Stripe mode (`livemode`) is refused with 400 and writes nothing; a fetched subscription, stored row or customer link from the other mode fails the event without changing state | `live_event_is_refused_by_a_test_mode_endpoint`, `test_event_is_refused_by_a_live_mode_endpoint`, `fetched_subscription_from_the_other_mode_fails_without_writing`, `stored_subscription_from_the_other_mode_is_not_overwritten`, `customer_link_from_the_other_mode_is_not_relinked` |
| A Connect event (`account` set) is recorded as `ignored` and nothing is fetched | `connect_event_is_recorded_as_ignored` |
| Concurrent first writes create one row | `concurrent_first_insert_creates_one_subscription` |
| A stale fetch never overwrites a newer committed write | `overlapping_fetches_never_overwrite_a_newer_committed_write` |
| Default (shortcut off): every subscription event fetches for itself, so a stale read by another event does not stop it converging | `shortcut_off_converges_after_a_stale_read`, `overlapping_fetches_never_overwrite_a_newer_committed_write` |
| With `readOrderShortcut: true`: an event whose subscription row came from a Stripe read that began after the event arrived is `skipped` without a fetch (assumes that read was not stale) | `event_already_covered_by_a_later_read_is_not_refetched`, `conflict_with_a_later_read_counts_as_done_without_retrying` |
| Conflicts are retried 5 times; then the event is `failed` and retryable | `conflict_retries_exhausted_leaves_event_failed_and_retryable` |
| A worker whose claim was taken over cannot write, or mark the event, including when it finishes after the new worker | `stale_worker_cannot_apply_after_claim_takeover`, `old_worker_finishing_last_cannot_overwrite_the_new_outcome`, `expired_worker_cannot_mark_another_workers_attempt` |
| The takeover threshold is configurable, and invalid values fail at startup | `claim_timeout_is_configurable`, `invalid_claim_timeout_fails_at_startup` |
| A crash after the claim does not strand the event | `crash_after_insert_is_recovered_on_retry` |
| Missing required fields: 500, nothing written, retry succeeds | `missing_required_field_fails_without_state_change_then_retry_succeeds` |
| A cancelled subscription is never brought back, and a deletion is never treated as done until a terminal status is read | `deleted_subscription_is_not_resurrected`, `deleted_event_with_non_terminal_fetch_is_retried`, `deleted_event_is_not_satisfied_by_a_newer_non_terminal_snapshot` |
| One subscription's cancellation does not revoke another | `cancellation_does_not_revoke_another_active_subscription` |
| Invoice subscription id read from both shapes; period fields from both locations; product as id or object | `invoice_new_and_old_shape`, `period_fields_new_and_legacy_location`, `product_as_id_string` |
| Every subscription item is stored; an item without a product fails without writing | `multi_item_subscription_stores_every_item`, `incomplete_item_list_fails_without_state_change` |
| An embedded item list with `has_more` is paged through (`subscriptionItems.list` in `fromStripeSdk`); a failure on any page fails the event and writes nothing; without a pager, `has_more` fails the event | `item_list_is_paged_when_has_more`, `failure_on_a_later_item_page_fails_without_writing`, `incomplete_item_list_fails_without_state_change`, `stripe_adapter_pages_items_with_subscription_items_list` |
| Plan changes and cancel-at-period-end are reflected | `downgrade_and_cancellation` |
| A v0.1.0 database upgraded with `sql/migrations/0002` ends identical to a fresh install (plain Postgres) | `upgrade_from_v0_1_0_matches_a_fresh_install` |
| Reconcile repairs drift, respects tombstones, and is safe alongside a live event in either commit order | `reconcile_repairs_drift`, `reconcile_respects_tombstone`, `reconcile_concurrent_with_live_event_webhook_commits_first`, `reconcile_concurrent_with_live_event_reconcile_commits_first` |
| Reconcile failures are typed results and write nothing; `reconcileCustomer` pages and reports truncation | `reconcile_returns_typed_failures_without_writing`, `reconcile_customer_pages_through_subscriptions` |
| Secrets, keys, JWTs and emails in payloads or error messages never reach logs or `last_error` | `canaries_never_reach_logs_or_last_error` |
| One structured log line per delivery, with a correlation id stored on failures | `every_delivery_logs_one_structured_line`, `failed_event_stores_its_correlation_id` |
| Oversized bodies get 413 and write nothing, with or without `Content-Length` | `oversized_body_gets_413_and_writes_nothing` |
| The health queries run | `health_queries_run` |
| Four processes against one Postgres, every event delivered by each: one row and one success per event, one link, each row at Stripe's state with one write per event | `several_processes_one_database_apply_each_event_once` |
| Entitlement comes from committed rows only | `entitlement_reflects_latest_committed_rows` |
| Missing or invalid user mapping fails and retries; links and owners never move | `subscription_before_checkout_link_fails_then_succeeds_after_link`, `checkout_without_client_reference_id_fails_and_writes_nothing`, `customer_link_is_never_reassigned`, `subscription_owner_never_changes` |
| Unknown or disabled events: 200, recorded `ignored` | `unknown_and_disabled_events_are_acknowledged_as_ignored` |
| Supabase roles: own rows only, `anon` reads nothing, `authenticated` writes nothing and cannot execute the functions | `other_users_subscription_not_readable`, `anon_cannot_read`, `authenticated_cannot_write`, `function_not_executable_by_authenticated` (on a role stand-in, see below) |

Compare-and-swap prevents concurrent local workers from overwriting a subscription snapshot without noticing an intervening database write; it does not guarantee that Stripe API reads are globally linearizable or always reflect the newest possible state.

## Running the tests

```sh
npm ci
npm run check        # lint, typecheck, tests, build
npm run smoke:pack   # pack, install the tarball in a temp project, import and typecheck it
```

By default the tests download nothing extra at run time. They start a throwaway Postgres from the `embedded-postgres` dev dependency, so Docker is not needed.

To use your own server instead, set `DATABASE_URL`, for example with `docker compose up -d` and `DATABASE_URL=postgres://postgres:postgres@localhost:54329/sss_test`. The tests drop and recreate the `public` schema, so they refuse any database whose name does not contain `test`. No Stripe account is needed: signatures use the real Stripe SDK with a fake secret, and retrieval uses an in-memory [FakeStripe](tests/support/fake-stripe.ts) whose delays the tests control.

The migration test creates and drops three extra databases next to the test database (names ending in `_test`), so the `DATABASE_URL` role needs `CREATEDB`. The multi-process test builds `dist/` and starts four Node processes.

**`npm audit`** (2026-11-24): 7 moderate advisories, all in dev dependencies. typescript-eslint 8.x pulls in `minimatch` with a denial-of-service advisory, [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249). `npm audit --omit=dev` and the example app's `npm audit` report 0. The package itself has no runtime dependencies. The dev dependencies were deliberately not upgraded for this report.

### Load test (optional, local only, synthetic)

[bench/load-test.mjs](bench/load-test.mjs) is **synthetic**. It sends 100 concurrent connections for 10 s at the webhook handler, using a throwaway embedded Postgres, a fake Stripe that takes 20–80 ms per read and is never stale, and events signed with a local secret. It runs every scenario twice: with the read-order shortcut off (the default) and on.

After each scenario it waits for the server to finish in-flight requests, sends one more event per subscription, and checks the database:

- every event that wrote did so exactly once;
- each row ends at Stripe's state;
- nothing is left `processing`.

```sh
npm run build && npm i --no-save autocannon@8.0.0 && node bench/load-test.mjs
```

Results on this Windows laptop, 2026-11-24, from the first of two runs; the second run was within about 10%. In both runs every database check held in every scenario and mode, and no event was left `processing`.

| Scenario | Shortcut | Requests in 10 s | Throughput | Latency p50 / p99 | Event outcomes |
|---|---|---|---|---|---|
| Same event from 100 connections | off | 20,786 | 1,890/s | 49 / 131 ms | applied once; the rest 200 (duplicate) or 409 (busy) |
| | on | 18,964 | 1,897/s | 49 / 148 ms | same |
| Distinct events, one subscription | off | 2,033 | 203/s | 505 / 674 ms | 299 succeeded, 1,835 `failed` after 5 retries (500, Stripe would redeliver) |
| | on | 7,860 | 786/s | 124 / 235 ms | 225 succeeded, 7,736 `skipped`, 0 failed |
| Distinct events over 50 subscriptions | off | 5,955 | 596/s | 91 / 652 ms | 5,833 succeeded, 272 `failed` |
| | on | 7,992 | 799/s | 103 / 286 ms | 5,432 succeeded, 2,710 `skipped`, 0 failed |

How to read this:

- **The shortcut is faster under contention** because it trusts that a later read was fresh. This fake Stripe never returns a stale read, so the risk the shortcut takes (`shortcut_on_keeps_a_stale_read_documented_risk`) cannot show up here.
- **With the shortcut off,** a subscription hammered by many events at once leaves many events `failed`. Stripe redelivers them later. Each row still ended at Stripe's state.
- **Real-world relevance:** these numbers say nothing about real Stripe latency or read freshness, Supabase, or a deployed server.

## Supabase notes

- [sql/supabase.sql](sql/supabase.sql) enables RLS on all three tables, revokes everything, then grants explicitly. `authenticated` gets `SELECT` on its own `stripe_subscriptions` rows. Only `service_role` gets writes, function `EXECUTE` and use of the `stripe_sync_seq` sequence. No function is `SECURITY DEFINER`, and every function has a fixed `search_path`.
- Supabase stopped auto-granting `anon`/`authenticated`/`service_role` on new tables in `public`. The change applied to new projects from 30 May 2026 and to all existing projects from **30 October 2026** ([Supabase changelog](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically); [hardening guide](https://supabase.com/docs/guides/api/hardening-data-api)). Because the grants here are explicit, this module should not depend on that default either way. On a real project the grants were checked only with that default off (see the manual run below).
- The permission tests run on plain Postgres with a stand-in for Supabase's roles and `auth.uid()` ([tests/support/supabase-shim.sql](tests/support/supabase-shim.sql)). They test the SQL, not Supabase itself.

## Compatibility

| Status | What |
|---|---|
| **Tested in CI** (GitHub Actions, ubuntu-latest, from 2026-11-23) | Lint, typecheck, the automated suite, build, and the example app's typecheck and `next build`, on **Node 22 and Node 24**, against a **Postgres 17** service container |
| **Tested locally** (Windows 11, 2026-11-23) | **Automated suite:** Node 26.13.1; Postgres 17 (embedded-postgres 17.11.0-beta.19); `pg` 8.23.1; `stripe` 23.1.0 for signature verification; TypeScript 6.0.3. **Example app:** typecheck and `next build` with Next 16.4.5, React 19.2.9, supabase-js 2.119.0. **Manual end-to-end runs** (see [below](#manual-end-to-end-run)). **The local load test** above |
| **Expected to work** (configured, not yet run) | `docker-compose.yml` |
| **Unverified** | **Checkout in a browser:** a person paying on Stripe's hosted page. The third manual run completed Checkout through Stripe's test-mode API with the test card token instead. **Data API:** reading rows through Supabase's Data API with a real user JWT; RLS was checked in SQL with Supabase's real roles. **Concurrency:** heavy concurrent or racing deliveries on real infrastructure; the automated suite forces them locally, the load test runs them locally, and the real run saw only pairs of simultaneous events. **Stripe API versions:** any other than those named here. **Platforms:** Postgres versions other than 17; edge runtimes; the embedded-postgres test setup on macOS or Linux (only run on Windows; npm 11 may skip its install script there, so use `DATABASE_URL` if it fails) |

### Manual end-to-end run

On 2026-11-23 the example app ran against a Stripe sandbox and a new Supabase project (Postgres 17.12, `sql/schema.sql` and `sql/supabase.sql` applied). Stripe CLI 1.55.14 forwarded the events, and the harness was [examples/nextjs-supabase/scripts/e2e-sandbox.mjs](examples/nextjs-supabase/scripts/e2e-sandbox.mjs).

**API versions:** events arrived at Stripe API 2026-09-30.endive, and subscriptions were retrieved at 2026-10-28.endive, the version stripe-node 23.1.0 pins.

The run went through these steps:

1. **Created before linking:** a 7-day trial subscription was created before its customer was linked. `customer.subscription.created` and `invoice.paid` failed (500, "No user linked to customer…") and no row was written.
2. **Linked and retried:** the customer was linked to a test user, and both events were re-delivered. Both succeeded, and the row matched Stripe: `trialing`, Pro price, 7-day period. Entitlement was `active`; an unrelated user's was `none`.
3. **Duplicate:** re-delivering the same event returned 200 `duplicate`, and the revision was unchanged.
4. **Plan changes:** a downgrade to the Basic price, then `cancel_at_period_end`, were both reflected. Entitlement stayed `active`.
5. **Cancellation:** cancelling the subscription gave `status = canceled` and set `tombstoned_at`. Entitlement became `none`.
6. **Permissions:** checked in SQL with Supabase's real roles.
   - authenticated, as the owner: sees 1 row.
   - authenticated, as another user: sees 0 rows.
   - anon reading the table: permission denied.
   - authenticated updating its own row: permission denied.
   - authenticated executing `claim_event`: permission denied.
   - The grants were as written in `supabase.sql`.

**Second run, final schema:** this run used the schema with the read-order shortcut (`read_seq`), applied fresh to the same project. The customer was linked first, the normal order.

1. **Created:** a trial subscription was created, and `customer.subscription.created` and `invoice.paid` arrived together. One wrote the row (revision 1). The other was `skipped`, because the row's Stripe read had begun after it arrived.
2. **Downgrade:** the plan change also arrived as a pair (`invoice.paid` and `customer.subscription.updated`), with the same result: one wrote and one was skipped.
3. **Cancel-at-period-end, duplicate and cancellation:** behaved as in the first run.
4. **Final state:** `canceled`, tombstoned, Basic price, revision 4. Exactly 4 events wrote, and none was left `processing`.
5. **Permissions:** `authenticated` and `anon` can neither use `stripe_sync_seq` nor execute `begin_subscription_read`; `service_role` can.

**Third run, Checkout and multi-item:** this run used the schema with every item stored (`items`), applied fresh. A subscription-mode Checkout Session was created server-side with `client_reference_id` set to a test user and two line items (Pro ×1, Basic ×2). It was completed through Stripe's test-mode payment-page API with the published test token `tok_visa`, the same way `stripe trigger checkout.session.completed` does it.

1. **Link:** `checkout.session.completed` linked the new customer to that user. The link row records that event's id.
2. **Subscription row:** written for that user, `active`, with both items and their quantities in `items`.
3. **Simultaneous events:** `customer.subscription.created` arrived together with `invoice.paid` and was `skipped` by the read-order rule.
4. **Entitlement:** `active`.

**Advisor findings:** Supabase's security advisor flagged two things. One is an informational note that `stripe_events` and `stripe_customer_links` have RLS but no policies, which is intended. The other is a warning about a `public.rls_auto_enable()` function that came with the new project, not from this repo.

## Size

`src/` is 706 lines: `process-event.ts` 252, `types.ts` 149, `errors.ts` 26, the rest under 80 each. `sql/schema.sql` is 267 lines.

## Docs

[docs/SYNC_MODEL.md](docs/SYNC_MODEL.md) · [docs/RUNBOOK.md](docs/RUNBOOK.md) · [docs/RETENTION.md](docs/RETENTION.md) · [docs/UPGRADING.md](docs/UPGRADING.md) · [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) · [SECURITY.md](SECURITY.md) · [CONTRIBUTING.md](CONTRIBUTING.md) · [CHANGELOG.md](CHANGELOG.md) · [fixtures/README.md](fixtures/README.md) · [PLAN.md](PLAN.md) · [LICENSE](LICENSE) (MIT)
