# Contributing

Thanks for helping. This project stays small on purpose: a developer should be able to read it in about 15 minutes and replace only the parts that are theirs. Before adding anything, check it is not on the "does not do" list in the [README](README.md).

## Setup

```sh
npm ci
npm run check   # lint, typecheck, tests, build
```

The tests start a throwaway embedded Postgres, so you need neither Docker nor a Stripe account. To use your own Postgres instead, set `DATABASE_URL`; the database name must contain `test`, because the tests drop its `public` schema.

## Changes

- **Behaviour changes start with a test.** Name the test after the observable behaviour (`deleted_subscription_is_not_resurrected`, not `test_apply_3`). Assert the resulting database state, not just the HTTP status.
- **Correctness mechanisms** (claims, the revision check, first insert, tombstones, the read-order rule, retries) need a test that fails when the mechanism is weakened. If you change one, say in the pull request which test would catch a regression.
- **Every guarantee the README states needs a test.** If you add a guarantee, add the test and list both in the README tables.
- **Stripe payloads:** fixtures go in `fixtures/<api-version>/` with `"_provenance": "synthetic"` or `"stripe-generated"`. Never label a hand-written payload as generated.
- **Keep `src/` free of runtime dependencies,** and keep the core free of framework, database driver and Stripe SDK imports.
- **Update [CHANGELOG.md](CHANGELOG.md)** under the unreleased version.

## Security issues

Do not open a public issue; see [SECURITY.md](SECURITY.md).
