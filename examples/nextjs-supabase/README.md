# Example: Next.js + Supabase

The smallest wiring of stripe-subscription-sync into a Next.js App Router app backed by Supabase. It has one webhook route and one helper to read a user's entitlement. There are no pages, no auth and no checkout: those are your app's.

The module never imports this folder, and you do not need it to use the module.

| File | Purpose |
|---|---|
| [app/api/stripe/webhook/route.ts](app/api/stripe/webhook/route.ts) | `POST` handler on the Node.js runtime |
| [lib/billing.ts](lib/billing.ts) | Creates the Stripe client, the service-role Supabase client and the handler; `entitlementFor(userId)` |
| [next.config.ts](next.config.ts) | Lets Turbopack follow the `file:../..` link to the module |
| [.env.example](.env.example) | The four variables it needs |

## Run it

1. **Build the module.** In the repository root, run `npm ci && npm run build`. This example depends on it via `file:../..`.
2. **Create the tables.** In your Supabase project, run [../../sql/schema.sql](../../sql/schema.sql), then [../../sql/supabase.sql](../../sql/supabase.sql).
3. **Set the variables.** Copy `.env.example` to `.env.local` and fill it in. `STRIPE_LIVEMODE` must be `false` for a sandbox or test key and `true` for a live key; the app refuses to start the handler if it does not match the key.
4. **Start the app.** Run `npm ci && npm run dev`.
5. **Forward Stripe events.** Run `stripe listen --forward-to localhost:3000/api/stripe/webhook --events checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_failed`, and put the printed `whsec_...` in `STRIPE_WEBHOOK_SECRET`.
6. **Run a Checkout.** In your app, create a Checkout Session on the server with `client_reference_id` set to the signed-in user's id, and complete it.

## What was checked

- **Build:** `npm run typecheck` and `npm run build` pass. Neither needs Stripe or Supabase credentials.
- **Sandbox run:** on 2026-11-23 this app ran against a Stripe sandbox and a new Supabase project, using [scripts/e2e-sandbox.mjs](scripts/e2e-sandbox.mjs). The root README's "Manual end-to-end run" lists exactly what was done and what it showed.
- **Checkout:** a later run completed a subscription-mode Checkout through Stripe's test-mode API, and the customer was linked from `client_reference_id`.
- **Not checked:** a person paying on Stripe's hosted Checkout page in a browser.

## Sandbox test harness

[scripts/e2e-sandbox.mjs](scripts/e2e-sandbox.mjs) starts `next start` and `stripe listen`, and keeps your keys inside its own process. It refuses any Stripe key that is not `sk_test_`. It also serves a control API on 127.0.0.1:3999 for:

- making Stripe API calls;
- re-delivering an event, signed;
- reading a user's entitlement.

Logs go to `scripts/.e2e/` (gitignored); the Stripe CLI's log there includes its webhook signing secret. Run `npm run build` first, then `node scripts/e2e-sandbox.mjs`.
