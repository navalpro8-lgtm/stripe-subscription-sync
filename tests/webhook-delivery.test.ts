// Signature verification, event claims, duplicates and crash recovery.
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { checkoutSession, event, invoice, subscription, USER_A } from './support/builders.js';
import {
  ADAPTERS, ageClaim, count, eventRow, linkCustomer, setupSuite, storeFor, subscriptionRow, worker,
  type WorkerOptions,
} from './support/harness.js';

describe.each(ADAPTERS)('webhook delivery (%s adapter)', (adapter) => {
  const ctx = setupSuite();
  const w = (o: Partial<WorkerOptions> = {}) => worker({ adapter, client: ctx.a, fake: ctx.fake, ...o });

  test('bad_signature_writes_nothing', async () => {
    ctx.fake.set(subscription());
    const subEvent = event('customer.subscription.created', subscription());
    const checkout = event('checkout.session.completed', checkoutSession());

    const results = [
      await w().deliver(subEvent, { secret: 'whsec_wrong_secret' }),
      await w().deliver(subEvent, { tamper: true }),
      await w().deliver(subEvent, { omitHeader: true }),
      await w().deliver(checkout, { secret: 'whsec_wrong_secret' }),
    ];

    expect(results.map((r) => r.status)).toEqual([400, 400, 400, 400]);
    expect(await count(ctx.a, 'stripe_events')).toBe(0);
    expect(await count(ctx.a, 'stripe_subscriptions')).toBe(0);
    expect(await count(ctx.a, 'stripe_customer_links')).toBe(0);
    expect(ctx.fake.calls).toEqual([]);
  });

  test('duplicate_event_does_not_apply_twice', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription());
    const evt = event('customer.subscription.created', subscription());

    const first = await w().deliver(evt);
    const second = await w().deliver(evt);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await subscriptionRow(ctx.a)).toMatchObject({ revision: 1, last_event_id: evt.id });
    expect(await eventRow(ctx.a, evt.id)).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(ctx.fake.calls).toHaveLength(1);
  });

  test('concurrent_duplicate_deliveries_apply_once', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription());
    const evt = event('customer.subscription.created', subscription());

    const results = await Promise.all([
      w({ client: ctx.a }).deliver(evt),
      w({ client: ctx.b }).deliver(evt),
    ]);

    // One delivery processes; the other is either told "busy" (non-2xx) or sees it done.
    expect(results.map((r) => r.status)).toContain(200);
    for (const r of results) expect([200, 409]).toContain(r.status);
    expect(await subscriptionRow(ctx.a)).toMatchObject({ revision: 1 });
    expect(await eventRow(ctx.a, evt.id)).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(ctx.fake.calls).toHaveLength(1);
  });

  test('duplicate_while_processing_is_not_acknowledged_then_succeeds_after_first_finishes', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription());
    const evt = event('customer.subscription.created', subscription());
    const pidA = (await ctx.a.query('select pg_backend_pid() as pid')).rows[0].pid;

    const hold = ctx.fake.hold('sub_1');
    const first = w({ client: ctx.a }).deliver(evt);
    await hold.reached;

    // While worker A waits on Stripe, it holds no open database transaction.
    const activity = await ctx.b.query('select state from pg_stat_activity where pid = $1', [pidA]);
    expect(activity.rows[0].state).toBe('idle');

    const duplicate = await w({ client: ctx.b }).deliver(evt);
    expect(duplicate.status).toBe(409);
    expect(await eventRow(ctx.b, evt.id)).toMatchObject({ status: 'processing', attempts: 1 });
    expect(await subscriptionRow(ctx.b)).toBeUndefined();

    hold.release();
    expect((await first).status).toBe(200);

    const later = await w({ client: ctx.b }).deliver(evt);
    expect(later.status).toBe(200);
    expect(await subscriptionRow(ctx.a)).toMatchObject({ revision: 1 });
    expect(await eventRow(ctx.a, evt.id)).toMatchObject({ status: 'succeeded', attempts: 1 });
  });

  test('crash_after_insert_is_recovered_on_retry', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription());
    const evt = event('customer.subscription.created', subscription());

    // A worker claimed the event and then died: no apply, no finish.
    expect(await storeFor(adapter, ctx.b).claimEvent(evt.id, evt.type, randomUUID(), false)).toBe('claimed');

    const whileFresh = await w().deliver(evt);
    expect(whileFresh.status).toBe(409);
    expect(await subscriptionRow(ctx.a)).toBeUndefined();

    await ageClaim(ctx.a, evt.id);
    const afterStale = await w().deliver(evt);

    expect(afterStale.status).toBe(200);
    expect(await subscriptionRow(ctx.a)).toMatchObject({ revision: 1, status: 'active' });
    expect(await eventRow(ctx.a, evt.id)).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  test('unknown_and_disabled_events_are_acknowledged_as_ignored', async () => {
    const unknown = event('customer.created', { id: 'cus_1', object: 'customer' });
    const r1 = await w().deliver(unknown);
    expect(r1).toMatchObject({ status: 200, body: { outcome: 'ignored' } });
    expect(await eventRow(ctx.a, unknown.id)).toMatchObject({ status: 'ignored' });

    ctx.fake.set(subscription());
    const disabled = event('invoice.paid', invoice('sub_1'));
    const r2 = await w({ enabledEvents: ['customer.subscription.updated'] }).deliver(disabled);
    expect(r2).toMatchObject({ status: 200, body: { outcome: 'ignored' } });
    expect(await eventRow(ctx.a, disabled.id)).toMatchObject({ status: 'ignored' });

    const r3 = await w().deliver(unknown);
    expect(r3.status).toBe(200);
    expect(await eventRow(ctx.a, unknown.id)).toMatchObject({ status: 'ignored', attempts: 1 });
    expect(await count(ctx.a, 'stripe_subscriptions')).toBe(0);
    expect(ctx.fake.calls).toEqual([]);
  });
});
