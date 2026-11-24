# Owner checklist: what needs real accounts

Nothing here was run for v0.2.0. Each step needs credentials or an account, so it is left to the repository owner. Record each result, with the date and versions, in the README's compatibility table.

Use a **Stripe sandbox** and a **throwaway Supabase project**. Never use live keys.

## 1. Capture real Stripe fixtures

1. **Install and sign in.** Install the [Stripe CLI](https://docs.stripe.com/stripe-cli), then run `stripe login`, choosing the sandbox.
2. **Start capturing.** In one terminal:

   ```sh
   stripe listen --print-json > captured.jsonl
   ```

3. **Trigger events.** In another terminal:

   ```sh
   stripe trigger customer.subscription.created
   stripe trigger invoice.paid
   stripe trigger customer.subscription.deleted
   stripe trigger checkout.session.completed
   ```

4. **Fetch each subscription.** For each subscription event, run `stripe subscriptions retrieve <sub_id>`.
5. **Write the fixture files.** Save each event and retrieve pair as `fixtures/<api-version>/<type>.json`, using the shape described in [fixtures/README.md](../fixtures/README.md), with `"_provenance": "stripe-generated"`.
   - Use the `api_version` printed on the event.
   - Replace emails and names first.
6. **Check them.** Run `npm test`. `tests/fixtures.test.ts` replays every fixture.

## 2. Deployed route against real Stripe and Supabase (v0.2.0)

1. **Create the tables.** Create a Supabase project. In its SQL editor, run `sql/schema.sql`, then `sql/supabase.sql`.
2. **Deploy the example.** Deploy `examples/nextjs-supabase` to your host, with these variables from `.env.example`:
   - `STRIPE_SECRET_KEY=sk_test_…`
   - `STRIPE_LIVEMODE=false`
   - `STRIPE_WEBHOOK_SECRET`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
3. **Add the endpoint.** In Stripe Workbench → Webhooks, add `https://<your-host>/api/stripe/webhook` with the six events listed in the README. Put the endpoint's `whsec_…` in `STRIPE_WEBHOOK_SECRET`.
4. **Browser Checkout.** From your app's server, create a Checkout Session with `client_reference_id` set to a real Supabase user id. Pay in the browser with test card `4242 4242 4242 4242`.
5. **Check the database.**
   - `stripe_customer_links` has one row with `livemode = false`.
   - `stripe_subscriptions` has the row, with `items`.
   - [sql/health.sql](../sql/health.sql) shows no failures.
6. **Check the lifecycle.** Change the plan, cancel at period end, then cancel now. Each step should update the row, and the cancellation should set `tombstoned_at`.
7. **Check mode refusal.** Point a live-mode endpoint at the same deployment, or send a live event with `stripe events resend` to a test-mode deployment. Expect 400 `livemode_mismatch` and no new rows.
8. **Check reconciliation.** Change a subscription in the Dashboard while the endpoint is disabled. Then run `reconcileSubscription('<sub_id>', deps)` from a script that uses the same env. Expect `outcome: 'applied'` and the row updated.
9. **Check the body limit.** Send a request over 1 MiB to the route. Expect 413, unless your host rejects it first; record which happened.
10. **Check the upgrade.** On a second project created with `sql/migrations/0001_*`, run the 0002 files as described in [UPGRADING.md](UPGRADING.md), then repeat steps 4 and 5.

## 3. Supabase Data API with a user JWT

1. **Sign in as user A** with supabase-js and the **anon** key, not the service role key.
2. **Read your own rows.** `supabase.from('stripe_subscriptions').select('*')` should return only user A's rows.
3. **Read nothing else.** As user A, read `stripe_events` and `stripe_customer_links`, and call `supabase.rpc('claim_event', …)`. All three should return no rows or a permission error.
4. **Try anonymous.** Signed out, every read should return nothing.

Record the supabase-js version and the date.

## 4. Enable private vulnerability reporting

GitHub offers this only on public repositories.

1. Open the repository → **Settings** → **Code security** → **Private vulnerability reporting** → **Enable**.
2. Check that **Security** → **Report a vulnerability** appears for a signed-in non-owner.

## 5. After each run

Update the README's compatibility table with exactly what ran. Leave everything else as Unverified.
