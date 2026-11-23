# Fixtures

Every file here is labelled with `_provenance`:

- `"synthetic"`: hand-written. It follows the field layout in Stripe's API reference and changelog for
  the API version named by its directory, trimmed to the fields this module reads plus a few
  neighbours. It was **not** produced by Stripe. Ids, amounts and timestamps are made up.
- `"stripe-generated"`: captured from a real Stripe sandbox (for example with `stripe trigger` and
  `stripe listen --print-json`). **There are none yet**: no Stripe account was used to build this repo.

Each file is one case: an `event` as delivered to the webhook, and `retrieve`, the subscription that
`subscriptions.retrieve` returns for it (absent when the handler should not fetch).
`tests/fixtures.test.ts` replays every case through the webhook handler and checks the database.

Shape sources:

- 2025-03-31.basil: periods on subscription items, invoice subscription at
  `parent.subscription_details.subscription`.
  https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end
  https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects
- 2025-02-24.acacia (the last version before basil): top-level `current_period_*`, top-level
  `invoice.subscription`.

Later API versions were not checked against these shapes.
