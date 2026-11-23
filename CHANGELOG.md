# Changelog

All notable changes to this project are listed here. Versions follow [Semantic Versioning](https://semver.org/); before 1.0.0, a minor version may contain breaking changes.

## 0.1.0 (unreleased)

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
