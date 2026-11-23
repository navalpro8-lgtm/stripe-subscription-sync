// sql/supabase.sql applied to plain Postgres with real roles from tests/support/supabase-shim.sql.
// This tests the RLS policies and grants as SQL. It is not a test against a Supabase project.
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { USER_A, USER_B } from './support/builders.js';
import { connect, count, subscriptionRow, truncateAll } from './support/harness.js';

let db: pg.Client;

/** Runs `fn` inside a transaction as `role`, optionally with a JWT subject; always rolls back. */
async function as<T>(role: 'anon' | 'authenticated' | 'service_role', userId: string | null, fn: () => Promise<T>): Promise<T> {
  await db.query('begin');
  try {
    await db.query(`set local role ${role}`);
    if (userId) await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role })]);
    return await fn();
  } finally {
    await db.query('rollback');
  }
}

const insertSub = (id: string, userId: string) =>
  db.query(
    `insert into public.stripe_subscriptions (subscription_id, user_id, customer_id, status, price_id, product_id,
       current_period_start, current_period_end, cancel_at_period_end, revision, last_event_id)
     values ($1, $2, 'cus_' || $1, 'active', 'price_1', 'prod_1', now(), now() + interval '30 days', false, 1, 'evt_setup')`,
    [id, userId],
  );

const FUNCTIONS = [
  `public.claim_event('evt_x', 'customer.subscription.created', gen_random_uuid())`,
  `public.finish_event('evt_x', gen_random_uuid(), 'succeeded', null)`,
  `public.holds_event_claim('evt_x', gen_random_uuid())`,
  `public.get_subscription_revision('sub_a')`,
  `public.apply_subscription_snapshot('sub_a', 1, gen_random_uuid(), 'evt_x', '{}'::jsonb)`,
  `public.list_user_subscriptions('${USER_A}')`,
  `public.link_customer('cus_x', '${USER_B}', 'evt_x', gen_random_uuid())`,
  `public.find_user_for_customer('cus_sub_a')`,
];

beforeAll(async () => {
  db = await connect();
});
beforeEach(async () => {
  await truncateAll(db);
  await insertSub('sub_a', USER_A);
  await insertSub('sub_b', USER_B);
  await db.query(`insert into public.stripe_customer_links values ('cus_sub_a', '${USER_A}', 'evt_setup', now())`);
  await db.query(`insert into public.stripe_events (event_id, event_type, status) values ('evt_setup', 'x', 'succeeded')`);
});
afterAll(async () => {
  await db?.end();
});

describe('permissions (Supabase roles, shim on plain Postgres)', () => {
  test('other_users_subscription_not_readable', async () => {
    const rows = await as('authenticated', USER_A, async () =>
      (await db.query('select subscription_id from public.stripe_subscriptions order by 1')).rows);
    expect(rows).toEqual([{ subscription_id: 'sub_a' }]);

    const targeted = await as('authenticated', USER_A, async () =>
      (await db.query(`select * from public.stripe_subscriptions where user_id = $1`, [USER_B])).rows);
    expect(targeted).toEqual([]);

    const noClaims = await as('authenticated', null, async () =>
      (await db.query('select * from public.stripe_subscriptions')).rows);
    expect(noClaims).toEqual([]);

    for (const table of ['stripe_customer_links', 'stripe_events']) {
      await expect(as('authenticated', USER_A, () => db.query(`select * from public.${table}`))).rejects.toThrow(/permission denied/);
    }
  });

  test('anon_cannot_read', async () => {
    for (const table of ['stripe_subscriptions', 'stripe_customer_links', 'stripe_events']) {
      await expect(as('anon', null, () => db.query(`select * from public.${table}`))).rejects.toThrow(/permission denied/);
    }
  });

  test('authenticated_cannot_write', async () => {
    const before = await subscriptionRow(db, 'sub_a');
    const writes = [
      `update public.stripe_subscriptions set status = 'active', revision = 99 where subscription_id = 'sub_a'`,
      `delete from public.stripe_subscriptions where subscription_id = 'sub_a'`,
      `insert into public.stripe_customer_links values ('cus_new', '${USER_A}', 'evt_forged', now())`,
      `insert into public.stripe_events (event_id, event_type, status) values ('evt_forged', 'x', 'succeeded')`,
    ];
    for (const sql of writes) {
      await expect(as('authenticated', USER_A, () => db.query(sql))).rejects.toThrow(/permission denied/);
    }
    await expect(as('authenticated', USER_A, () => insertSub('sub_forged', USER_A))).rejects.toThrow(/permission denied/);

    expect(await subscriptionRow(db, 'sub_a')).toEqual(before);
    expect(await count(db, 'stripe_subscriptions')).toBe(2);
    expect(await count(db, 'stripe_customer_links')).toBe(1);
    expect(await count(db, 'stripe_events')).toBe(1);
  });

  test('function_not_executable_by_authenticated', async () => {
    for (const role of ['authenticated', 'anon'] as const) {
      for (const call of FUNCTIONS) {
        await expect(as(role, USER_A, () => db.query(`select ${call}`)), `${role}: ${call}`).rejects.toThrow(/permission denied for function/);
      }
    }
    expect(await count(db, 'stripe_events')).toBe(1);
    expect(await count(db, 'stripe_customer_links')).toBe(1);

    // Positive control: service_role can execute the functions and sees every row.
    const claimed = await as('service_role', null, async () => {
      const r = await db.query(`select public.claim_event('evt_svc', 'customer.subscription.created', gen_random_uuid()) as r`);
      const all = await db.query('select count(*)::int as n from public.stripe_subscriptions');
      return { result: r.rows[0].r, rows: all.rows[0].n };
    });
    expect(claimed).toEqual({ result: 'claimed', rows: 2 });
  });
});
