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
3. **Set the variables.** Copy `.env.example` to `.env.local` and fill it in.
4. **Start the app.** Run `npm ci && npm run dev`.
5. **Forward Stripe events.** Run `stripe listen --forward-to localhost:3000/api/stripe/webhook --events checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_failed`, and put the printed `whsec_...` in `STRIPE_WEBHOOK_SECRET`.
6. **Run a Checkout.** In your app, create a Checkout Session on the server with `client_reference_id` set to the signed-in user's id, and complete it.

## What was checked

- **Checked:** `npm run typecheck` and `npm run build` pass. Neither needs Stripe or Supabase credentials.
- **Not checked:** steps 2–6 have not been run against a real Supabase project or Stripe sandbox for this repository.
