// Several OS processes (each its own webhook server and connection pool) against ONE Postgres,
// delivering overlapping events: every event is sent by every process, in a different order.
// Asserts the final database state, not just HTTP statuses.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, expect, inject, test } from 'vitest';
import { checkoutSession, event, subscription, USER_A } from './support/builders.js';
import { connect, truncateAll } from './support/harness.js';

const run = promisify(execFile);
const PROCESSES = 4;
const SUBSCRIPTIONS = 5;
const EVENTS_PER_SUBSCRIPTION = 8;

beforeAll(async () => {
  // The worker processes import the built module.
  await run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json']);
}, 120_000);

function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

test('several_processes_one_database_apply_each_event_once', async () => {
  const db = await connect();
  const work = await mkdtemp(join(tmpdir(), 'sss-mp-'));
  try {
    await truncateAll(db);
    const subIds = Array.from({ length: SUBSCRIPTIONS }, (_, i) => `sub_mp_${i}`);
    const stripeState = Object.fromEntries(subIds.map((id, i) => [id, subscription({ id, customer: 'cus_mp', price: `price_final_${i}` })]));
    const events = [
      // The link arrives in the mix, so early subscription events fail until it is written.
      event('checkout.session.completed', checkoutSession({ customer: 'cus_mp', clientReferenceId: USER_A }), 'evt_mp_link'),
      ...subIds.flatMap((id) =>
        Array.from({ length: EVENTS_PER_SUBSCRIPTION }, (_, n) =>
          event(n % 2 ? 'invoice.paid' : 'customer.subscription.updated',
            n % 2 ? { id: `in_${id}_${n}`, object: 'invoice', parent: { subscription_details: { subscription: id } } } : { id },
            `evt_mp_${id}_${n}`))),
    ];

    const outputs = await Promise.all(
      Array.from({ length: PROCESSES }, async (_, p) => {
        const file = join(work, `input-${p}.json`);
        await writeFile(file, JSON.stringify({ databaseUrl: inject('databaseUrl'), secret: 'whsec_multi_process_test', stripeState, events: shuffled(events, p + 1) }));
        const { stdout } = await run(process.execPath, ['tests/support/multi-process-worker.mjs', file], { maxBuffer: 16 * 1024 * 1024 });
        return JSON.parse(stdout) as { outcomes: Record<string, string[]> };
      }),
    );

    // Every process got every event to a final 200.
    for (const { outcomes } of outputs) {
      expect(Object.keys(outcomes).sort()).toEqual(events.map((e) => e.id).sort());
      for (const list of Object.values(outcomes)) expect(['succeeded', 'skipped', 'duplicate', 'ignored']).toContain(list.at(-1));
    }

    // One row per event, all finished; each succeeded exactly once across all processes.
    const rows = (await db.query(`select event_id, status from public.stripe_events order by 1`)).rows;
    expect(rows.map((r) => r.event_id)).toEqual(events.map((e) => e.id).sort());
    expect(rows.every((r) => r.status === 'succeeded')).toBe(true);
    for (const e of events) {
      const firstTimeSuccesses = outputs.filter((o) => o.outcomes[e.id]!.includes('succeeded')).length;
      expect(firstTimeSuccesses).toBe(1);
    }

    // State: one link, every subscription at Stripe's state, one write per succeeded event.
    expect((await db.query(`select stripe_customer_id, user_id from public.stripe_customer_links`)).rows).toEqual([
      { stripe_customer_id: 'cus_mp', user_id: USER_A },
    ]);
    const subs = (await db.query(`select subscription_id, price_id, user_id, revision from public.stripe_subscriptions order by 1`)).rows;
    expect(subs).toEqual(subIds.map((id, i) => ({ subscription_id: id, price_id: `price_final_${i}`, user_id: USER_A, revision: EVENTS_PER_SUBSCRIPTION })));
  } finally {
    await db.end();
    await rm(work, { recursive: true, force: true });
  }
}, 180_000);
