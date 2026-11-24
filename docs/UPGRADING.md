# Upgrading

Fresh installs run [sql/schema.sql](../sql/schema.sql), then [sql/supabase.sql](../sql/supabase.sql) on Supabase. Existing databases run the numbered files in [sql/migrations/](../sql/migrations) in order, once each.

| File | From → to |
|---|---|
| `0001_v0.1.0_schema.sql`, `0001_v0.1.0_supabase.sql` | nothing → v0.1.0. These are the v0.1.0 files unchanged. Don't run them on a database that already has v0.1.0. |
| `0002_v0.2.0_expand.sql`, then `0002_v0.2.0_expand_supabase.sql` (Supabase only) | v0.1.0 → transition: both v0.1.0 and v0.2.0 code work |
| `0003_v0.2.0_contract.sql` | transition → v0.2.0. Run it only after every route and job runs v0.2.0. |

`tests/migrations.test.ts` checks the upgrade on plain Postgres 17, with a stand-in for Supabase's roles rather than a Supabase project:

- It builds a v0.1.0 database with rows in it and runs 0002.
- During the transition it makes v0.1.0-style and v0.2.0-style calls, and checks that both work.
- It runs 0003 and checks that the columns, constraints, indexes, function definitions and grants, table and sequence grants, RLS flags and policies equal a fresh install.
- A second test checks that neither step rewrites the tables: their storage files (`relfilenode`) don't change.

## v0.1.0 → v0.2.0

**Breaking changes:**

- **`livemode` is required:** `SyncDeps.livemode` must be set.
- **New columns:** `livemode` on all three tables.
- **Function signatures:** `claim_event` and `link_customer` take new arguments. The `SyncStore` methods `claimEvent` and `linkCustomer` gain the matching parameters, which matters only if you wrote your own store.
- **Read-order shortcut is off by default:** set `readOrderShortcut: true` to keep v0.1.0 behaviour; read its risk first.

**Steps.** No pause in webhook processing is needed.

1. **Back up the database.**
2. **Expand.** Tell it the Stripe mode of this database: `'false'` for a sandbox or test mode, `'true'` for live mode.

   ```sh
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
     -c "set stripe_sync.livemode = 'false'" \
     -f sql/migrations/0002_v0.2.0_expand.sql
   ```

   - **What it changes:** it adds `livemode` as `NOT NULL DEFAULT <mode>`, which on Postgres 11 and later updates only the catalog, with no table rewrite or scan. It adds the new function signatures next to the old ones, and lets `apply_subscription_snapshot` accept v0.1.0 snapshots.
   - **Locks:** each table is locked only briefly. `lock_timeout` is 5 s, so the step fails instead of queueing behind a long transaction. If that happens, just run it again.
   - **If the setting is missing or invalid,** it raises an error and changes nothing.
   - **If one database holds both modes,** which v0.1.0 advised against, split it first. Every existing row gets the same mode.
   - **In the Supabase SQL editor,** put `set stripe_sync.livemode = 'false';` on the first line, then the file's contents.
3. **On Supabase,** run `0002_v0.2.0_expand_supabase.sql`. It grants the new signatures to `service_role` only.
4. **Deploy v0.2.0** everywhere, with `livemode` set (the example reads `STRIPE_LIVEMODE`). v0.1.0 instances keep working until they are replaced.
5. **Contract** once no v0.1.0 code is left running:

   ```sh
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f sql/migrations/0003_v0.2.0_contract.sql
   ```

   It drops the defaults and the old signatures, again touching only the catalog. Any v0.1.0 instance still running now fails, and Stripe retries its events.
6. **Check:** run [sql/health.sql](../sql/health.sql). Query 7 should show one `livemode` value per table.

**Not tested:** these steps on a real Supabase project, and how long the brief locks take under real load.
