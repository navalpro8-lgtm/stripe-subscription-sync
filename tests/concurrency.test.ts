// Interleavings forced with FakeStripe holds and store gates, on two real DB connections.
import { describe, expect, test } from 'vitest';
import { event, invoice, subscription, USER_A } from './support/builders.js';
import {
  ADAPTERS, ageClaim, eventRow, gate, linkCustomer, setupSuite, subscriptionRow, worker,
  type WorkerOptions,
} from './support/harness.js';

describe.each(ADAPTERS)('concurrency (%s adapter)', (adapter) => {
  const ctx = setupSuite();
  const w = (o: Partial<WorkerOptions> = {}) => worker({ adapter, client: ctx.a, fake: ctx.fake, ...o });

  test('concurrent_first_insert_creates_one_subscription', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription());
    const h1 = ctx.fake.hold('sub_1');
    const h2 = ctx.fake.hold('sub_1');

    const created = event('customer.subscription.created', subscription());
    const paid = event('invoice.paid', invoice('sub_1'));
    const p1 = w({ client: ctx.a }).deliver(created);
    await h1.reached;
    const p2 = w({ client: ctx.b }).deliver(paid);
    await h2.reached;
    // Both workers have read revision 0 and are about to insert.
    h1.release();
    h2.release();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    const rows = await ctx.a.query('select revision from public.stripe_subscriptions');
    expect(rows.rows).toEqual([{ revision: 2 }]); // one row; the loser retried on top of it
    expect(await eventRow(ctx.a, created.id)).toMatchObject({ status: 'succeeded' });
    expect(await eventRow(ctx.a, paid.id)).toMatchObject({ status: 'succeeded' });
    expect(ctx.fake.calls).toHaveLength(3);
  });

  test('overlapping_fetches_never_overwrite_a_newer_committed_write', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription({ price: 'price_a' }));
    await w().deliver(event('customer.subscription.created', subscription()));

    // Worker A reads Stripe while the price is price_b, and is delayed.
    ctx.fake.set(subscription({ price: 'price_b' }));
    const holdA = ctx.fake.hold('sub_1');
    const eventA = event('customer.subscription.updated', { id: 'sub_1' });
    const pA = w({ client: ctx.a }).deliver(eventA);
    await holdA.reached;

    // Stripe moves on to price_c; worker B reads and commits it.
    ctx.fake.set(subscription({ price: 'price_c' }));
    const rB = await w({ client: ctx.b }).deliver(event('customer.subscription.updated', { id: 'sub_1' }));
    expect(rB.status).toBe(200);
    expect(await subscriptionRow(ctx.b)).toMatchObject({ price_id: 'price_c', revision: 2 });

    holdA.release();
    expect((await pA).status).toBe(200);

    // A's stale price_b snapshot hit a conflict; A re-read Stripe and wrote price_c again.
    expect(await subscriptionRow(ctx.a)).toMatchObject({ price_id: 'price_c', revision: 3, last_event_id: eventA.id });
    expect(ctx.fake.calls).toHaveLength(4);
  });

  test('conflict_retries_exhausted_leaves_event_failed_and_retryable', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription({ price: 'price_a' }));
    const created = event('customer.subscription.created', subscription());
    await w().deliver(created);

    // Every Stripe read is followed by another writer bumping the revision.
    ctx.fake.set(subscription({ price: 'price_b' }));
    ctx.fake.afterRead = async () => {
      await ctx.b.query(`update public.stripe_subscriptions set revision = revision + 1 where subscription_id = 'sub_1'`);
    };
    const updated = event('customer.subscription.updated', { id: 'sub_1' });
    const r1 = await w().deliver(updated);

    expect(r1.status).toBe(500);
    expect(await eventRow(ctx.a, updated.id)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(String((await eventRow(ctx.a, updated.id))?.last_error)).toMatch(/conflict/i);
    // 1 initial attempt + 5 retries, each lost to the other writer; this event wrote nothing.
    expect(await subscriptionRow(ctx.a)).toMatchObject({ price_id: 'price_a', revision: 7, last_event_id: created.id });

    ctx.fake.afterRead = undefined;
    const r2 = await w().deliver(updated);
    expect(r2.status).toBe(200);
    expect(await eventRow(ctx.a, updated.id)).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(await subscriptionRow(ctx.a)).toMatchObject({ price_id: 'price_b', revision: 8, last_event_id: updated.id });
  });

  test('stale_worker_cannot_apply_after_claim_takeover', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription({ price: 'price_old' }));
    const evt = event('customer.subscription.created', { id: 'sub_1' });

    const holdA = ctx.fake.hold('sub_1');
    const pA = w({ client: ctx.a }).deliver(evt);
    await holdA.reached;

    // A's claim goes stale; Stripe redelivers and worker B takes over and finishes.
    ctx.fake.set(subscription({ price: 'price_new' }));
    await ageClaim(ctx.b, evt.id);
    const rB = await w({ client: ctx.b }).deliver(evt);
    expect(rB.status).toBe(200);
    const afterB = await eventRow(ctx.b, evt.id);
    expect(afterB).toMatchObject({ status: 'succeeded', attempts: 2 });

    holdA.release();
    const rA = await pA;
    expect(rA).toMatchObject({ status: 500, body: { outcome: 'claim_lost' } });

    expect(await subscriptionRow(ctx.a)).toMatchObject({ price_id: 'price_new', revision: 1 });
    expect(await eventRow(ctx.a, evt.id)).toMatchObject({ status: 'succeeded', claimed_by: afterB?.claimed_by });
  });

  test('expired_worker_cannot_mark_another_workers_attempt', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription());
    const evt = event('customer.subscription.created', { id: 'sub_1' });

    // Worker A applies its write, then stalls just before marking the event.
    const beforeFinish = gate();
    const wA = w({
      client: ctx.a,
      wrapStore: (s) => ({ ...s, finishEvent: async (...args) => { await beforeFinish.pass(); return s.finishEvent(...args); } }),
    });
    const pA = wA.deliver(evt);
    await beforeFinish.reached;

    // A's claim expires; worker B takes over and is mid-fetch.
    await ageClaim(ctx.b, evt.id);
    const holdB = ctx.fake.hold('sub_1');
    const pB = w({ client: ctx.b }).deliver(evt);
    await holdB.reached;
    const tokenB = (await eventRow(ctx.b, evt.id))?.claimed_by;

    beforeFinish.release();
    expect(await pA).toMatchObject({ status: 500, body: { outcome: 'claim_lost' } });
    // A could not mark B's attempt.
    expect(await eventRow(ctx.b, evt.id)).toMatchObject({ status: 'processing', claimed_by: tokenB, attempts: 2 });

    holdB.release();
    expect((await pB).status).toBe(200);
    expect(await eventRow(ctx.a, evt.id)).toMatchObject({ status: 'succeeded', claimed_by: tokenB });
    expect(await subscriptionRow(ctx.a)).toMatchObject({ revision: 2 });
  });
});
