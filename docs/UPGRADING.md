# Upgrading

Fresh installs run [sql/schema.sql](../sql/schema.sql), then [sql/supabase.sql](../sql/supabase.sql) on Supabase. Existing databases run the numbered files in [sql/migrations/](../sql/migrations) in order, once each.

| File | From → to |
|---|---|
| `0001_v0.1.0_schema.sql`, `0001_v0.1.0_supabase.sql` | nothing → v0.1.0. These are the v0.1.0 files unchanged. Don't run them on a database that already has v0.1.0. |
| `0002_v0.2.0.sql`, then `0002_v0.2.0_supabase.sql` (Supabase only) | v0.1.0 → v0.2.0 |

`tests/migrations.test.ts` builds a v0.1.0 database with rows in every table and runs 0002 on it. It then checks that the columns, constraints, indexes, function definitions and grants, table and sequence grants, RLS flags and policies equal a fresh install. That check runs on plain Postgres 17 with a stand-in for Supabase's roles, not on a Supabase project.

## v0.1.0 → v0.2.0

**Breaking changes:**

- **`livemode` is required:** `SyncDeps.livemode` must be set.
- **New columns:** `livemode` on all three tables.
- **Function signatures:** `claim_event` and `link_customer` take new arguments. The `SyncStore` methods `claimEvent` and `linkCustomer` gain the matching parameters, which matters only if you wrote your own store.
- **Read-order shortcut is off by default:** set `readOrderShortcut: true` to keep v0.1.0 behaviour; read its risk first.

**Steps:**

1. **Pause webhook processing.** v0.1.0 code calls the old function signatures, which 0002 drops. For example, deploy a route that answers 503. Stripe retries within its window: up to three days in live mode, three times over a few hours in a sandbox. Keep the pause short in a sandbox.
2. **Back up the database.**
3. **Run 0002 in one transaction,** telling it the Stripe mode of the existing rows:

   ```sh
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
     -c "set stripe_sync.livemode = 'false'" \
     -f sql/migrations/0002_v0.2.0.sql
   ```

   - Use `'true'` for a live-mode database.
   - If the tables hold rows and the setting is missing or invalid, it raises an error and nothing changes.
   - If one database holds both modes, which v0.1.0 advised against, split it first. The migration gives every existing row the same mode.
   - In the Supabase SQL editor, put `set stripe_sync.livemode = 'false';` on the first line, then the file's contents.
4. **On Supabase,** run `0002_v0.2.0_supabase.sql`. It grants the recreated functions to `service_role` only.
5. **Deploy v0.2.0** with `livemode` set (the example reads `STRIPE_LIVEMODE`). Resume traffic.
6. **Check:** run [sql/health.sql](../sql/health.sql). Query 7 should show one `livemode` value per table.

**Not tested:** the lock time of the `alter table … set not null` and the backfill on large tables. Each one rewrites or scans the table while holding a lock. Try it on a copy of your data first.
