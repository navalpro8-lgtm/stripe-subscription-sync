// A database created from the v0.1.0 schema and upgraded with sql/migrations/0002 must end
// identical (as the catalog sees it) to a fresh install of sql/schema.sql + sql/supabase.sql.
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';

const FRESH = 'sss_migrate_fresh_test';
const UPGRADED = 'sss_migrate_upgraded_test';
const EMPTY = 'sss_migrate_empty_test';
const sql = (file: string) => readFile(file, 'utf8');

function urlFor(db: string): string {
  const url = new URL(inject('databaseUrl'));
  url.pathname = `/${db}`;
  return url.toString();
}

async function recreate(admin: pg.Client, db: string): Promise<pg.Client> {
  await admin.query(`drop database if exists ${db}`);
  await admin.query(`create database ${db}`);
  const client = new pg.Client({ connectionString: urlFor(db) });
  await client.connect();
  await client.query(await sql('tests/support/supabase-shim.sql'));
  return client;
}

/** Everything that defines the installed module, in a comparable form. */
async function catalog(client: pg.Client) {
  const q = async (text: string) => (await client.query(text)).rows;
  return {
    columns: await q(`select table_name, column_name, data_type, is_nullable, column_default
                        from information_schema.columns where table_schema = 'public' order by 1, 2`),
    constraints: await q(`select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def
                            from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2`),
    indexes: await q(`select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by 1, 2`),
    functions: await q(`select proname, pg_get_function_identity_arguments(oid) as args, pg_get_functiondef(oid) as def,
                               array(select unnest(coalesce(proacl, '{}')) ::text order by 1) as acl
                          from pg_proc where pronamespace = 'public'::regnamespace order by 1, 2`),
    relations: await q(`select relname, relkind, relrowsecurity, relforcerowsecurity,
                               array(select unnest(coalesce(relacl, '{}'))::text order by 1) as acl
                          from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'S') order by 1`),
    policies: await q(`select tablename, policyname, permissive, roles::text, cmd, qual, with_check
                         from pg_policies where schemaname = 'public' order by 1, 2`),
  };
}

describe('migrations', () => {
  let admin: pg.Client;
  let fresh: pg.Client;
  let upgraded: pg.Client;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: inject('databaseUrl') });
    await admin.connect();
    fresh = await recreate(admin, FRESH);
    upgraded = await recreate(admin, UPGRADED);
  });
  afterAll(async () => {
    await fresh?.end();
    await upgraded?.end();
    await admin?.query(`drop database if exists ${FRESH}`);
    await admin?.query(`drop database if exists ${UPGRADED}`);
    await admin?.end();
  });

  test('upgrade_from_v0_1_0_matches_a_fresh_install', async () => {
    await fresh.query(await sql('sql/schema.sql'));
    await fresh.query(await sql('sql/supabase.sql'));

    await upgraded.query(await sql('sql/migrations/0001_v0.1.0_schema.sql'));
    await upgraded.query(await sql('sql/migrations/0001_v0.1.0_supabase.sql'));
    // v0.1.0 data: an event, a link and a subscription row.
    await upgraded.query(`insert into public.stripe_events (event_id, event_type, status) values ('evt_old', 'invoice.paid', 'succeeded')`);
    await upgraded.query(`insert into public.stripe_customer_links (stripe_customer_id, user_id, linked_by_event) values ('cus_old', 'user_old', 'evt_old')`);
    await upgraded.query(
      `insert into public.stripe_subscriptions (subscription_id, user_id, customer_id, status, price_id, product_id,
         current_period_start, current_period_end, items, cancel_at_period_end, revision, read_seq, last_event_id)
       values ('sub_old', 'user_old', 'cus_old', 'active', 'price_1', 'prod_1', now(), now(), '[{"id":"si_1"}]', false, 1, 1, 'evt_old')`,
    );

    // Without the mode setting, the migration refuses and changes nothing.
    const before = await catalog(upgraded);
    await expect(upgraded.query(await sql('sql/migrations/0002_v0.2.0_expand.sql'))).rejects.toThrow(/stripe_sync\.livemode/);
    expect(await catalog(upgraded)).toEqual(before);

    // Step 1, expand.
    await upgraded.query(`set stripe_sync.livemode = 'false'`);
    await upgraded.query(await sql('sql/migrations/0002_v0.2.0_expand.sql'));
    await upgraded.query(await sql('sql/migrations/0002_v0.2.0_expand_supabase.sql'));

    // Rollout window: v0.1.0 code (old signatures, snapshot without livemode) still works ...
    const old = async (text: string) => (await upgraded.query(text)).rows[0].r;
    const tokenOld = '00000000-0000-4000-8000-0000000000aa';
    expect(await old(`select public.claim_event('evt_v1', 'customer.subscription.updated', '${tokenOld}') as r`)).toBe('claimed');
    const v1Snapshot = JSON.stringify({
      user_id: 'user_old', customer_id: 'cus_old', status: 'past_due', price_id: 'price_2', product_id: 'prod_1', quantity: 1,
      current_period_start: 1767225600, current_period_end: 1769817600, items: [{ id: 'si_1' }], cancel_at_period_end: false,
      cancel_at: null, canceled_at: null, ended_at: null, trial_end: null, read_seq: '999',
    });
    expect(await old(`select public.apply_subscription_snapshot('sub_old', 1, '${tokenOld}', 'evt_v1', '${v1Snapshot}'::jsonb) as r`)).toBe('applied');
    expect(await old(`select public.link_customer('cus_v1', 'user_v1', 'evt_v1', '${tokenOld}') as r`)).toBe('linked');
    // ... and so does v0.2.0 code.
    const tokenNew = '00000000-0000-4000-8000-0000000000bb';
    expect(await old(`select public.claim_event('evt_v2', 'invoice.paid', '${tokenNew}', false, 120) as r`)).toBe('claimed');
    expect(await old(`select public.link_customer('cus_v2', 'user_v2', 'evt_v2', '${tokenNew}', false) as r`)).toBe('linked');

    // Step 2, contract (after v0.2.0 is deployed everywhere).
    await upgraded.query(await sql('sql/migrations/0003_v0.2.0_contract.sql'));

    const a = await catalog(fresh);
    const b = await catalog(upgraded);
    expect(b.columns).toEqual(a.columns);
    expect(b.constraints).toEqual(a.constraints);
    expect(b.indexes).toEqual(a.indexes);
    expect(b.functions).toEqual(a.functions);
    expect(b.relations).toEqual(a.relations);
    expect(b.policies).toEqual(a.policies);

    // Every row, old or written during the rollout, has the mode.
    for (const table of ['stripe_events', 'stripe_customer_links', 'stripe_subscriptions']) {
      expect((await upgraded.query(`select distinct livemode from public.${table}`)).rows).toEqual([{ livemode: false }]);
    }
    expect((await upgraded.query(`select status, revision from public.stripe_subscriptions`)).rows).toEqual([{ status: 'past_due', revision: 2 }]);
    // After the contract step, a snapshot without livemode is refused.
    await expect(upgraded.query(`select public.apply_subscription_snapshot('sub_old', 2, '${tokenNew}', 'evt_v2', '${v1Snapshot}'::jsonb)`)).rejects.toThrow(/livemode is required/);
  });

  test('expand_step_changes_no_table_files', async () => {
    // ADD COLUMN ... NOT NULL DEFAULT <constant> must not rewrite the tables (catalog-only).
    const db = await recreate(admin, EMPTY);
    try {
      await db.query(await sql('sql/migrations/0001_v0.1.0_schema.sql'));
      await db.query(`insert into public.stripe_events (event_id, event_type, status) select 'evt_' || g, 'x', 'succeeded' from generate_series(1, 1000) g`);
      const files = async () => (await db.query(`select relname, relfilenode from pg_class where relname in ('stripe_events', 'stripe_customer_links', 'stripe_subscriptions') order by 1`)).rows;
      const beforeFiles = await files();
      await db.query(`set stripe_sync.livemode = 'true'`);
      await db.query(await sql('sql/migrations/0002_v0.2.0_expand.sql'));
      expect(await files()).toEqual(beforeFiles);
      await db.query(await sql('sql/migrations/0003_v0.2.0_contract.sql'));
      expect(await files()).toEqual(beforeFiles);
      expect((await db.query(`select count(*)::int n from public.stripe_events where livemode`)).rows[0].n).toBe(1000);
    } finally {
      await db.end();
      await admin.query(`drop database if exists ${EMPTY}`);
    }
  });
});
