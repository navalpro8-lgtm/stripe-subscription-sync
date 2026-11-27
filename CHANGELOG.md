# Changelog

All notable changes to this project are listed here. Versions follow [Semantic Versioning](https://semver.org/); before 1.0.0, a minor version may contain breaking changes.

## 0.2.0 (2026-11-27)

Prepared for independent evaluation. Upgrade steps: [docs/UPGRADING.md](docs/UPGRADING.md).

**Breaking**

- **Read-order shortcut is off by default.** It is now opt-in (`readOrderShortcut: true`), because it assumes a Stripe read that starts after an event arrived reflects that event. With it off, an event fetches for itself. Under contention, events that used to end as `skipped` now end as `succeeded`, or `failed` for Stripe to retry.
- **`livemode` columns and option.** A required `livemode boolean` column on `stripe_events`, `stripe_customer_links` and `stripe_subscriptions`, and a required `SyncDeps.livemode`. Upgrade in two steps, `sql/migrations/0002_v0.2.0_expand.sql` and then `0003_v0.2.0_contract.sql`, with no pause in webhook traffic. The SQL functions `claim_event` and `link_customer`, and the `SyncStore` methods `claimEvent` and `linkCustomer`, take the new arguments.

**Added**

- **Mode separation:** events, fetched subscriptions, rows and links from the other Stripe mode are refused without writing. Connect events are recorded as `ignored`.
- **Claim timeout:** `claimTimeoutSeconds`, default 120, validated.
- **Item paging:** subscription items are paged when `has_more` is set.
- **Stale-read guard:** a fresh `customer.subscription.updated` whose fetch still shows the event's own previous `status` or `cancel_at_period_end` is retried, not written.
- **Reconciliation:** `reconcileSubscription` and `reconcileCustomer`, on the same compare-and-swap path, with typed results.
- **Logging:** structured, redacted log lines, plus a correlation id on stored errors.
- **Operations:** `sql/health.sql`, and a `maxBodyBytes` limit (default 1 MiB) on the Next.js route.
- **Migrations and docs:** numbered migrations, `docs/RUNBOOK.md`, `docs/RETENTION.md`, `docs/UPGRADING.md` and `docs/OWNER_CHECKLIST.md`.
- **Tests and CI:** a packaging smoke test (`npm run smoke:pack`), a multi-process concurrency test, and a CI job for a clean clone without `DATABASE_URL`.

**Changed**

- **Conflict retries:** 8 retries (9 attempts) with exponential backoff and full jitter (25 ms doubling, capped at 1 s), instead of 5 retries with 10–50 ms jitter.
- **Upgrade:** two steps, `0002_v0.2.0_expand.sql` and then `0003_v0.2.0_contract.sql`. Neither needs a webhook pause.
- **Load test:** labelled synthetic. It reports both shortcut modes and waits for in-flight requests between scenarios.
- **Maintainer docs:** `PLAN.md` moved to `docs/maintainers/`.

## 0.1.0 (2026-11-23)

First public version.

- **Event handling:** webhook signature verification on the raw body, and event claims with stale-claim takeover. A duplicate is acknowledged only once its first delivery has finished.
- **Subscription writes:** every write comes from a fresh Stripe read, applied with compare-and-swap on a per-row `revision`. Cancellations become tombstones that later stale writes cannot undo.
- **Read-order rule:** an event whose change is already covered by a Stripe read that began after it arrived ends as `skipped`, with no extra fetch or retry.
- **Items:** every subscription item is stored in `items`.
- **Ownership:** the customer is linked to your user from `checkout.session.completed` (`client_reference_id`). A customer link or a subscription's owner never changes.
- **Entitlement:** computed on read by a replaceable example policy.
- **Database:** plain-Postgres schema and functions, plus Supabase RLS and grants.
- **Adapters:** a Next.js route handler, Postgres and Supabase stores, and a Stripe SDK adapter.
- **Example:** a Next.js + Supabase example, plus a sandbox test harness.
- **Tests:** the test suite on a real Postgres, synthetic fixtures, and a local load test.
