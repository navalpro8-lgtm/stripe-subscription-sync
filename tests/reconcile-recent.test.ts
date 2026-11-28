// reconcileRecent: list the subscriptions Stripe has events for since a time, reconcile each.
import { describe, expect, test } from 'vitest';
import { reconcileRecent } from '../src/index.js';
import { event, subscription, USER_A } from './support/builders.js';
import { ADAPTERS, count, linkCustomer, setupSuite, subscriptionRow, syncDeps, worker, type WorkerOptions } from './support/harness.js';

describe.each(ADAPTERS)('reconcileRecent (%s adapter)', (adapter) => {
  const ctx = setupSuite();
  const opts = (o: Partial<WorkerOptions> = {}): WorkerOptions => ({ adapter, client: ctx.a, fake: ctx.fake, ...o });
  const now = Math.floor(Date.now() / 1000);
  const since = new Date((now - 3600) * 1000);

  test('reconcile_recent_fixes_subscription_whose_webhook_never_arrived', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription({ price: 'price_a' }));
    await worker(opts()).deliver(event('customer.subscription.created', { id: 'sub_1' }));

    // Stripe changes sub_1 and creates sub_2; neither webhook is delivered.
    ctx.fake.set(subscription({ price: 'price_b', quantity: 3 }));
    ctx.fake.set(subscription({ id: 'sub_2' }));
    ctx.fake.addEvent('sub_1', now - 60);
    ctx.fake.addEvent('sub_2', now - 30, 'customer.subscription.created');
    ctx.fake.pageEvents(100);

    const r = await reconcileRecent({ since }, syncDeps(opts()));
    expect(r).toMatchObject({ checked: 2, updated: 2, unchanged: 0, failed: 0, truncated: false });
    expect(await subscriptionRow(ctx.a, 'sub_1')).toMatchObject({ price_id: 'price_b', quantity: 3, revision: 2 });
    expect(await subscriptionRow(ctx.a, 'sub_2')).toMatchObject({ status: 'active', revision: 1 });
  });

  test('reconcile_recent_leaves_up_to_date_subscription_alone', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription({ price: 'price_a' }));
    await worker(opts()).deliver(event('customer.subscription.updated', { id: 'sub_1' }));
    const before = await subscriptionRow(ctx.a, 'sub_1');
    ctx.fake.addEvent('sub_1', now - 60); // the webhook for this event did arrive
    ctx.fake.pageEvents(100);

    const r = await reconcileRecent({ since }, syncDeps(opts()));
    expect(r).toMatchObject({ checked: 1, updated: 0, unchanged: 1, failed: 0 });
    expect(r.results).toEqual([expect.objectContaining({ subscriptionId: 'sub_1', outcome: 'unchanged' })]);
    // Same revision, same updated_at, same last_event_id: nothing was written.
    expect(await subscriptionRow(ctx.a, 'sub_1')).toEqual(before);
  });

  test('reconcile_recent_handles_more_than_one_page', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    const ids = ['sub_a', 'sub_b', 'sub_c', 'sub_d', 'sub_e'];
    ids.forEach((id, i) => {
      ctx.fake.set(subscription({ id }));
      ctx.fake.addEvent(id, now - 100 + i);
    });
    ctx.fake.addEvent('sub_a', now - 10); // a second event for sub_a: reconciled once, not twice
    ctx.fake.set(subscription({ id: 'sub_old' }));
    ctx.fake.addEvent('sub_old', now - 7200); // before `since`: not listed
    ctx.fake.pageEvents(2);

    const r = await reconcileRecent({ since }, syncDeps(opts()));
    expect(r).toMatchObject({ checked: 5, updated: 5, unchanged: 0, failed: 0, truncated: false });
    expect(r.results.map((x) => x.subscriptionId).sort()).toEqual(ids);
    // 6 events, 2 per page: 3 list calls, each after the last event id of the previous page.
    expect(ctx.fake.calls.filter((c) => c.startsWith('events:'))).toHaveLength(3);
    expect(ctx.fake.calls.filter((c) => c === 'sub_a')).toHaveLength(1);
    expect(await count(ctx.a, 'stripe_subscriptions')).toBe(5);
  });

  test('reconcile_recent_counts_a_failure_and_continues', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ['sub_a', 'sub_b', 'sub_c'].forEach((id, i) => {
      ctx.fake.set(subscription({ id }));
      ctx.fake.addEvent(id, now - 100 + i); // newest first: sub_c, sub_b, sub_a
    });
    ctx.fake.failRetrieve('sub_b', new Error('Stripe API connection error'));
    ctx.fake.pageEvents(100);

    const r = await reconcileRecent({ since }, syncDeps(opts()));
    expect(r).toMatchObject({ checked: 3, updated: 2, unchanged: 0, failed: 1 });
    expect(r.results.find((x) => x.subscriptionId === 'sub_b')).toMatchObject({ outcome: 'failed', reason: 'error', error: 'Stripe API connection error' });
    expect(await subscriptionRow(ctx.a, 'sub_a')).toBeDefined();
    expect(await subscriptionRow(ctx.a, 'sub_b')).toBeUndefined();
    expect(await subscriptionRow(ctx.a, 'sub_c')).toBeDefined();
  });
});
