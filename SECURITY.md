# Security notes

This is a **reference implementation**. It has not been audited, and it is **not meant to be deployed unchanged**. Read it, adapt it, and review it as part of your own application.

## What the module does

- **Signature check:** it verifies the Stripe signature on the raw request body with `stripe.webhooks.constructEvent`. A bad or missing signature returns 400 and writes nothing (`bad_signature_writes_nothing`).
- **No state from payloads:** it never writes event payload contents as subscription state. Every write comes from a fresh `subscriptions.retrieve`.
- **Ownership is fixed:** it never moves a Stripe customer, or a subscription row, to a different user (`customer_link_is_never_reassigned`, `subscription_owner_never_changes`).
- **Supabase grants and RLS:** with `sql/supabase.sql` applied, `authenticated` can `SELECT` only rows whose `user_id` matches `auth.uid()`. `anon` can read nothing. Only `service_role` can write or execute the functions. See `tests/permissions.test.ts`. Those tests run against a stand-in for Supabase's roles on plain Postgres, not against a Supabase project.

## What you must do

- **Set `client_reference_id` on your server.** Do it from the authenticated user when you create the Checkout Session. The default user mapping trusts `client_reference_id` on `checkout.session.completed`. That is only safe if your server set it.
  - **Payment Links:** they accept `client_reference_id` as a URL query parameter ([Stripe docs](https://docs.stripe.com/payment-links/url-parameters)), which any visitor can edit.
  - **Other client-side setups:** a pricing table, or any flow where the browser supplies the value, is equally untrusted.
  - **If you use those:** replace [src/config/user-mapping.ts](src/config/user-mapping.ts). Never map users from metadata or values a client can set.
- **Keep keys on the server.** The Stripe secret key, the webhook signing secret and the Supabase service-role key are server-only. Commit only `.env.example`.
- **Run the route on the Node.js runtime.** The example route sets `runtime = 'nodejs'`.
- **Review the grants against your project.** Supabase changed its default grants for new tables in `public`: new projects from 30 May 2026, existing projects from 30 October 2026 ([changelog](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)). `sql/supabase.sql` revokes and grants explicitly, so it should not depend on either default. That was checked on plain Postgres only.
- **Errors are stored in the database.** `stripe_events.last_error` holds error messages, which contain Stripe and user ids but not payloads. Decide who can read that table. With `sql/supabase.sql`, only `service_role` can.
- **Add your own limits.** The module has no rate limiting, alerting or monitoring.

## Reporting

This repository has no security contact. If you find a flaw in the design, open an issue describing it without exploit details.
