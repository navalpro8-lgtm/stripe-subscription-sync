# Hardening plan for v0.2.0 (gate: review before any code)

Branch: `hardening/0.2.0`. One logical change per commit. Focused tests while developing, and the full `npm run check` at the end of each phase.

This work improves correctness, recovery, install and evidence. It does not show the module suits any particular app. Each "verified by" entry below names what will be run. The final report quotes the command and a summary of its output.

## Contract questions: proposed answers

These need a yes or no before Phase 1 starts.

1. **Read-order shortcut option.**
   - Proposal: `SyncDeps.readOrderShortcut?: boolean`, default `false`.
   - When it is off, `beginRead` still records `read_seq`, but `superseded` is ignored. Every event fetches and goes through compare-and-swap.
   - Breaking change: under contention, events now end as `succeeded` or `failed` where they used to end as `skipped`.
2. **Expected mode.**
   - Proposal: `SyncDeps.livemode: boolean` becomes required. Breaking change: there is no default, so test and live cannot be mixed up silently.
   - An event whose `livemode` differs returns **400 `livemode_mismatch`** and writes no row at all. This is a misconfigured endpoint, so Stripe's retries make it visible in the Dashboard.
   - A fetched subscription whose `livemode` differs **fails** the event. `last_error` says so, and no subscription or link is written.
3. **Connect events.**
   - An event with a non-empty `account` is recorded as `ignored`, with `last_error = 'connect_event_unsupported'`, and returns 200. Nothing is fetched.
4. **Where `livemode` is stored.**
   - Proposal: a `livemode boolean not null` column on `stripe_events`, `stripe_customer_links` and `stripe_subscriptions`.
   - `apply_subscription_snapshot` and `link_customer` refuse a row whose stored mode differs, returning a new `mode_mismatch` result. This covers a database that already holds the other mode.
5. **Claim takeover timeout.**
   - Proposal: `SyncDeps.claimTimeoutSeconds?: number`, default 120, passed to `claim_event` as a parameter.
   - Validated at startup: an integer from 10 to 3600, otherwise the constructor throws.
6. **Item paging.**
   - Proposal: a new optional `SubscriptionRetriever.listSubscriptionItems(subscriptionId, startingAfter)`, implemented in `fromStripeSdk` with `subscriptionItems.list({ subscription, limit: 100, starting_after })`.
   - When `has_more` is set and the method is absent, the event fails, as it does today.
   - Known gap, to be documented: pages are separate reads, so a change between them can produce a mixed item list. The next event repairs it.
7. **Reconciliation identity.**
   - Proposal: `reconcileSubscription(id, deps)` claims a synthetic `stripe_events` row with id `reconcile:<sub>:<uuid>` and type `reconcile`. It then runs the same `syncSubscription` loop, with its claim, compare-and-swap and tombstone rules.
   - Typed result: `{ outcome: 'applied' | 'unchanged' | 'tombstoned' | 'failed', reason?: 'not_found' | 'unlinked_customer' | 'mode_mismatch' | 'retries_exhausted' | 'error', revision? }`.
   - It never throws for expected failures.
8. **`reconcileCustomer`.**
   - Proposal: implement it. Stripe's `subscriptions.list({ customer, status: 'all', limit: 100 })` is cursor-paged and bounded by one customer's subscriptions.
   - It pages explicitly with `starting_after`, takes a `maxSubscriptions` guard (default 1000), and returns `truncated: true` when it stops early. Each subscription goes through `reconcileSubscription`.
   - No "reconcile everything" function and no scheduled job.
9. **Correlation id.**
   - Proposal: one random UUID per `processEvent` or reconcile call, included in every log line and in the stored error.
   - The claim token is never logged.
10. **Body limit.**
    - Proposal: `maxBodyBytes`, default 1 MiB. Stripe documents no fixed event size, which I will check and cite. The limit is checked on `Content-Length` and again while reading the stream.
    - Over the limit returns 413 `body_too_large` before signature verification.
11. **Secret rotation.**
    - `webhookSecret: string | string[]`, accepted only if Stripe's docs confirm that rolling a secret keeps the old one valid for a window. Otherwise the docs describe rotation as a redeploy.
    - Verification tries each secret in turn, and the first match wins.
12. **Migration backfill of `livemode`.**
    - `0002` reads `current_setting('stripe_sync.livemode')`, which the owner sets in the same session, to backfill existing rows. Unset or invalid raises an error and changes nothing.

## Items

| # | Item | Verified by | Cannot verify here |
|---|---|---|---|
| 1 | Shortcut opt-in, default off; assumption documented beside the option and in SYNC_MODEL.md | New tests use a fake Stripe that returns a stale snapshot for a read begun after the event. **Off:** a later fresh read converges the row. **On:** the test asserts the documented wrong outcome, the event `skipped` with the row stale, and is named as a risk. Existing shortcut tests run with it on. Load test (`bench/load-test.mjs`) labelled synthetic and run in both modes. | How often real Stripe reads are stale |
| 2 | Test/live separation | Tests: live event against a test config, test event against a live config, mismatched fetched subscription, stored row of the other mode, Connect event recorded as `ignored`. Each asserts that no subscription or link row changed. | Real Connect payloads |
| 3 | Claim fencing and configurable timeout | Keep `stale_worker_cannot_apply_after_claim_takeover`. Add a test where the old worker finishes last, held with the fake's gates: its `apply` and `finish` are refused and the new worker's result stands. Validation tests for the timeout, and a takeover test at a non-default value. | Real worker pauses (GC, cold starts) |
| 4 | Item paging | Tests: 3 pages stored in order; a failure on page 2 means the event fails and nothing is written; `has_more` without a pager fails as today. | Stripe's real paging under concurrent edits |
| 5 | Reconciliation | Contract written in SYNC_MODEL.md first. Tests: drift repaired; tombstone respected; reconcile run concurrently with a live event (both orders, held with gates) ends with one consistent row; typed failure for a 404 and for an unlinked customer; `reconcileCustomer` across 2+ pages and the `truncated` result. New docs/RUNBOOK.md. | Running it against real Stripe data |
| 6 | Retention | docs/RETENTION.md only, citing Stripe's current webhook and events docs on retry and resend windows, fetched and dated. | That Stripe's documented windows hold in practice |
| 7 | Structured, redacted logs; `sql/health.sql` | Canary test: payloads and errors carry a fake `sk_test_…`, `whsec_…`, a JWT-shaped key and an email. Every log line and every `last_error` is checked, and none contains a canary. `health.sql` queries run in a test against the test database. | Your log pipeline |
| 8 | Body-size limit | Tests at the route handler: oversize `Content-Length` returns 413; a streamed body over the limit without a length header returns 413; nothing is written in either case. | Your host's own limits (for example Vercel's) |
| 9 | Secret rotation | Docs read and cited. If supported: tests for old secret, new secret, neither (400), and an empty array rejected at startup. | Stripe's real roll behaviour |
| 10 | Migrations | `sql/migrations/0001_initial.sql` (v0.1.0, byte-for-byte from the tag commit) and `0002_….sql`. Test: v0.1.0 then 0002 against a fresh install, comparing columns, constraints, indexes, function definitions, policies and grants from `pg_catalog`. Upgrade note in the README. | Your existing data volume and lock times |
| 11 | Clean clone on Linux without `DATABASE_URL` | New ubuntu CI job without the postgres service: `npm ci && npm run check` on embedded-postgres. If embedded-postgres fails there, external Postgres becomes the documented default and the job shows the failure mode. **Needs a branch push to GitHub to run (asks first).** | Other distros, and running as root |
| 12 | Packaging smoke test and audit | Script: `npm pack`, install the tarball in a temp project, import every public export, `tsc --noEmit` on a consumer file. `npm audit` output reported as-is. | Consumers' bundlers |
| 13 | Multi-process concurrency | Test that spawns 4 Node processes against one Postgres, each delivering an overlapping set of events. It asserts the final rows, one terminal state per event, and no duplicate side effects. | Many machines, network partitions |
| 14 | Doc fixes | fixtures/README.md (fixtures are synthetic; manual runs are in the README); the SECURITY.md maintainer note on private reporting; `git mv PLAN.md docs/maintainers/` and fix links | — |
| 15 | docs/OWNER_CHECKLIST.md | Exact steps for: capturing Stripe CLI fixtures, a deployed route, Supabase Data API with a user JWT, browser Checkout, and enabling private vulnerability reporting | Everything in it: it is for the owner |
| 16 | Compatibility table and CHANGELOG 0.2.0 | Table rows only for what was run; the rest stays "Unverified". The CHANGELOG marks only the breaking changes: the shortcut default, required `livemode`, and the new columns | — |

## Not done (per the brief)

Connect support, multiple endpoints, partitioning, a metrics framework, an SBOM, publishing, tagging, merging, scheduled jobs and deletion code.

## Order

Gate, then the four phases in order, with `npm run check` after each:

- **Phase 1:** items 1–4
- **Phase 2:** items 5–9
- **Phase 3:** items 10–13
- **Phase 4:** items 14–16

Finally, the final report.
