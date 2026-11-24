// reconcileSubscription / reconcileCustomer: the same claim + compare-and-swap path as webhooks.
import { describe, expect, test } from 'vitest';
import { reconcileCustomer, reconcileSubscription } from '../src/index.js';
import { event, subscription, USER_A } from './support/builders.js';
import { ADAPTERS, count, linkCustomer, setupSuite, subscriptionRow, syncDeps, worker, type WorkerOptions } from './support/harness.js';

describe.each(ADAPTERS)('reconciliation (%s adapter)', (adapter) => {
  const ctx = setupSuite();
  const opts = (o: Partial<WorkerOptions> = {}): WorkerOptions => ({ adapter, client: ctx.a, fake: ctx.fake, ...o });
  const reconcileRows = async () =>
    (await ctx.a.query(`select event_id, status, last_error from public.stripe_events where event_type = 'reconcile' order by created_at`)).rows;

  test('reconcile_repairs_drift', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription({ price: 'price_a' }));
    await worker(opts()).deliver(event('customer.subscription.created', { id: 'sub_1' }));

    // Stripe moves on and the webhook for it is lost for good.
    ctx.fake.set(subscription({ price: 'price_b', quantity: 4 }));
    const r = await reconcileSubscription('sub_1', syncDeps(opts()));
    expect(r).toMatchObject({ subscriptionId: 'sub_1', outcome: 'applied' });
    expect(await subscriptionRow(ctx.a)).toMatchObject({ price_id: 'price_b', quantity: 4, revision: 2 });
    const rows = await reconcileRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'succeeded', last_error: null });
    expect(String(rows[0].event_id)).toMatch(/^reconcile:sub_1:[0-9a-f-]{36}$/);
  });

  test('reconcile_respects_tombstone', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription({ status: 'canceled' }));
    await worker(opts()).deliver(event('customer.subscription.deleted', { id: 'sub_1' }));
    const before = await subscriptionRow(ctx.a);

    ctx.fake.set(subscription({ status: 'active' })); // a stale or odd read
    expect(await reconcileSubscription('sub_1', syncDeps(opts()))).toMatchObject({ outcome: 'tombstoned' });
    expect(await subscriptionRow(ctx.a)).toEqual(before);
    expect((await reconcileRows())[0]).toMatchObject({ status: 'skipped' });
  });

  test('reconcile_first_reconcile_terminal_subscription_writes_tombstone', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription({ status: 'canceled' }));
    expect(await reconcileSubscription('sub_1', syncDeps(opts()))).toMatchObject({ outcome: 'applied' });
    const row = await subscriptionRow(ctx.a);
    expect(row).toMatchObject({ status: 'canceled', revision: 1 });
    expect(row?.tombstoned_at).not.toBeNull();
  });

  test('reconcile_concurrent_with_live_event_webhook_commits_first', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription({ price: 'price_a' }));
    await worker(opts()).deliver(event('customer.subscription.created', { id: 'sub_1' }));

    // Reconcile reads price_b and stalls; a webhook reads price_c and commits.
    ctx.fake.set(subscription({ price: 'price_b' }));
    const hold = ctx.fake.hold('sub_1');
    const pR = reconcileSubscription('sub_1', syncDeps(opts({ client: ctx.a })));
    await hold.reached;
    ctx.fake.set(subscription({ price: 'price_c' }));
    expect((await worker(opts({ client: ctx.b })).deliver(event('customer.subscription.updated', { id: 'sub_1' }))).status).toBe(200);

    hold.release();
    // Its stale price_b write conflicts; it re-reads (price_c) and writes that.
    expect(await pR).toMatchObject({ outcome: 'applied' });
    expect(await subscriptionRow(ctx.a)).toMatchObject({ price_id: 'price_c', revision: 3 });
  });

  test('reconcile_concurrent_with_live_event_reconcile_commits_first', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription({ price: 'price_a' }));
    await worker(opts()).deliver(event('customer.subscription.created', { id: 'sub_1' }));

    // The webhook reads price_b and stalls; reconcile reads price_c and commits.
    ctx.fake.set(subscription({ price: 'price_b' }));
    const hold = ctx.fake.hold('sub_1');
    const evt = event('customer.subscription.updated', { id: 'sub_1' });
    const pW = worker(opts({ client: ctx.b })).deliver(evt);
    await hold.reached;
    ctx.fake.set(subscription({ price: 'price_c' }));
    expect(await reconcileSubscription('sub_1', syncDeps(opts({ client: ctx.a })))).toMatchObject({ outcome: 'applied' });

    hold.release();
    expect(await pW).toMatchObject({ status: 200, body: { outcome: 'succeeded' } });
    expect(await subscriptionRow(ctx.a)).toMatchObject({ price_id: 'price_c', revision: 3, last_event_id: evt.id });
  });

  test('reconcile_returns_typed_failures_without_writing', async () => {
    // Stripe has no such subscription.
    const notFound = await reconcileSubscription('sub_missing', syncDeps(opts()));
    expect(notFound).toMatchObject({ outcome: 'failed', reason: 'not_found' });

    // No user linked to the customer.
    ctx.fake.set(subscription({ id: 'sub_unlinked', customer: 'cus_nobody' }));
    expect(await reconcileSubscription('sub_unlinked', syncDeps(opts()))).toMatchObject({ outcome: 'failed', reason: 'unlinked_customer' });

    // Stripe returns the other mode.
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription({ id: 'sub_live', livemode: true }));
    expect(await reconcileSubscription('sub_live', syncDeps(opts()))).toMatchObject({ outcome: 'failed', reason: 'mode_mismatch' });

    // Any other Stripe error.
    ctx.fake.set(subscription());
    ctx.fake.failNextRetrieve = new Error('Stripe API connection error');
    expect(await reconcileSubscription('sub_1', syncDeps(opts()))).toMatchObject({ outcome: 'failed', reason: 'error', error: 'Stripe API connection error' });

    expect(await count(ctx.a, 'stripe_subscriptions')).toBe(0);
    const rows = await reconcileRows();
    expect(rows.map((r) => r.status)).toEqual(['failed', 'failed', 'failed', 'failed']);
  });

  test('reconcile_customer_pages_through_subscriptions', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    for (const id of ['sub_a', 'sub_b', 'sub_c']) ctx.fake.set(subscription({ id }));
    ctx.fake.set(subscription({ id: 'sub_other', customer: 'cus_2' }));
    ctx.fake.pageCustomerSubscriptions(2);

    const all = await reconcileCustomer('cus_1', syncDeps(opts()));
    expect(all.truncated).toBe(false);
    expect(all.results.map((r) => [r.subscriptionId, r.outcome])).toEqual([['sub_a', 'applied'], ['sub_b', 'applied'], ['sub_c', 'applied']]);
    expect(ctx.fake.calls.filter((c) => c.startsWith('list:'))).toEqual(['list:cus_1:', 'list:cus_1:sub_b']);
    expect(await count(ctx.a, 'stripe_subscriptions')).toBe(3);

    const capped = await reconcileCustomer('cus_1', syncDeps(opts()), { maxSubscriptions: 2 });
    expect(capped.truncated).toBe(true);
    expect(capped.results).toHaveLength(2);

    await expect(reconcileCustomer('cus_1', syncDeps(opts()), { maxSubscriptions: 0 })).rejects.toThrow(/maxSubscriptions/);
  });

  test('reconcile_customer_needs_a_lister', async () => {
    await expect(reconcileCustomer('cus_1', syncDeps(opts()))).rejects.toThrow(/listCustomerSubscriptions/);
  });
});
