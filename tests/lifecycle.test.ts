// Subscription lifecycle: plan changes, cancellation, tombstones, entitlement on read.
import { describe, expect, test } from 'vitest';
import { getEntitlement } from '../src/index.js';
import { event, subscription, USER_A, USER_B } from './support/builders.js';
import {
  ADAPTERS, eventRow, linkCustomer, setupSuite, subscriptionRow, worker, type WorkerOptions,
} from './support/harness.js';

describe.each(ADAPTERS)('lifecycle (%s adapter)', (adapter) => {
  const ctx = setupSuite();
  const w = (o: Partial<WorkerOptions> = {}) => worker({ adapter, client: ctx.a, fake: ctx.fake, ...o });
  const entitlement = (userId: string) => getEntitlement(w().store, userId);
  const send = (type: string, id = 'sub_1') => w().deliver(event(type, { id }));

  test('deleted_subscription_is_not_resurrected', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription({ status: 'active' }));
    await send('customer.subscription.created');

    // A delayed worker read "active" before the cancellation...
    const holdA = ctx.fake.hold('sub_1');
    const lateCreated = event('customer.subscription.created', { id: 'sub_1' }, 'evt_late_created');
    const pA = w({ client: ctx.a }).deliver(lateCreated);
    await holdA.reached;

    // ...the cancellation is committed by another worker...
    ctx.fake.set(subscription({ status: 'canceled' }));
    expect((await w({ client: ctx.b }).deliver(event('customer.subscription.deleted', { id: 'sub_1' }))).status).toBe(200);
    const tombstone = await subscriptionRow(ctx.b);
    expect(tombstone).toMatchObject({ status: 'canceled', revision: 2 });
    expect(tombstone?.tombstoned_at).toBeInstanceOf(Date);

    // ...so the delayed worker's "active" snapshot is refused by the tombstone.
    holdA.release();
    expect(await pA).toMatchObject({ status: 200, body: { outcome: 'skipped' } });

    // A brand-new late event whose Stripe read is stale ("active") is refused the same way.
    ctx.fake.set(subscription({ status: 'active' }));
    const lateUpdated = event('customer.subscription.updated', { id: 'sub_1' });
    expect(await w().deliver(lateUpdated)).toMatchObject({ status: 200, body: { outcome: 'skipped' } });

    expect(await subscriptionRow(ctx.a)).toEqual(tombstone);
    expect(await eventRow(ctx.a, lateCreated.id)).toMatchObject({ status: 'skipped' });
    expect(await eventRow(ctx.a, lateUpdated.id)).toMatchObject({ status: 'skipped' });
    expect(await entitlement(USER_A)).toBe('none');
  });

  test('deleted_event_with_non_terminal_fetch_is_retried', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription({ status: 'active' }));
    await send('customer.subscription.created');

    const deleted = event('customer.subscription.deleted', { id: 'sub_1' });
    const early = await w().deliver(deleted); // Stripe read not yet showing the cancellation
    expect(early.status).toBe(500);
    expect(await eventRow(ctx.a, deleted.id)).toMatchObject({ status: 'failed' });
    expect(await subscriptionRow(ctx.a)).toMatchObject({ status: 'active', revision: 1 });

    ctx.fake.set(subscription({ status: 'canceled' }));
    expect((await w().deliver(deleted)).status).toBe(200);
    expect(await subscriptionRow(ctx.a)).toMatchObject({ status: 'canceled', revision: 2 });
  });

  test('deleted_event_is_not_satisfied_by_a_newer_non_terminal_snapshot', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription({ status: 'active' }));
    await send('customer.subscription.created');

    // The deleted event reads "canceled" and is delayed...
    ctx.fake.set(subscription({ status: 'canceled' }));
    const hold = ctx.fake.hold('sub_1');
    const deleted = event('customer.subscription.deleted', { id: 'sub_1' });
    const pDeleted = w({ client: ctx.a }).deliver(deleted);
    await hold.reached;

    // ...while a later event gets a stale "active" read from Stripe and commits it.
    ctx.fake.set(subscription({ status: 'active' }));
    expect((await w({ client: ctx.b }).deliver(event('customer.subscription.updated', { id: 'sub_1' }))).status).toBe(200);

    // That later read must not count as covering the deletion: the deleted event retries.
    ctx.fake.set(subscription({ status: 'canceled' }));
    hold.release();
    expect(await pDeleted).toMatchObject({ status: 200, body: { outcome: 'succeeded' } });
    const row = await subscriptionRow(ctx.a);
    expect(row).toMatchObject({ status: 'canceled', revision: 3 });
    expect(row?.tombstoned_at).toBeInstanceOf(Date);
  });

  test('cancellation_does_not_revoke_another_active_subscription', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription({ id: 'sub_1', status: 'active' }));
    ctx.fake.set(subscription({ id: 'sub_2', status: 'active', price: 'price_addon' }));
    await send('customer.subscription.created', 'sub_1');
    await send('customer.subscription.created', 'sub_2');

    ctx.fake.set(subscription({ id: 'sub_2', status: 'canceled', price: 'price_addon' }));
    expect((await send('customer.subscription.deleted', 'sub_2')).status).toBe(200);

    expect(await subscriptionRow(ctx.a, 'sub_1')).toMatchObject({ status: 'active' });
    expect(await subscriptionRow(ctx.a, 'sub_2')).toMatchObject({ status: 'canceled' });
    expect(await entitlement(USER_A)).toBe('active');

    ctx.fake.set(subscription({ id: 'sub_1', status: 'canceled' }));
    await send('customer.subscription.deleted', 'sub_1');
    expect(await entitlement(USER_A)).toBe('none');
  });

  test('downgrade_and_cancellation', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription({ price: 'price_pro', product: 'prod_pro' }));
    await send('customer.subscription.created');

    ctx.fake.set(subscription({ price: 'price_basic', product: 'prod_basic' }));
    await send('customer.subscription.updated');
    expect(await subscriptionRow(ctx.a)).toMatchObject({ price_id: 'price_basic', product_id: 'prod_basic', status: 'active', revision: 2 });
    expect(await entitlement(USER_A)).toBe('active');

    ctx.fake.set(subscription({ price: 'price_basic', product: 'prod_basic', cancelAtPeriodEnd: true }));
    await send('customer.subscription.updated');
    expect(await subscriptionRow(ctx.a)).toMatchObject({ cancel_at_period_end: true, status: 'active', tombstoned_at: null });
    expect(await entitlement(USER_A)).toBe('active');

    ctx.fake.set(subscription({ price: 'price_basic', product: 'prod_basic', cancelAtPeriodEnd: true, status: 'canceled' }));
    await send('customer.subscription.deleted');
    const row = await subscriptionRow(ctx.a);
    expect(row).toMatchObject({ status: 'canceled', revision: 4 });
    expect(row?.tombstoned_at).toBeInstanceOf(Date);
    expect(row?.ended_at).toBeInstanceOf(Date);
    expect(await entitlement(USER_A)).toBe('none');
  });

  test('entitlement_reflects_latest_committed_rows', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription({ status: 'trialing' }));
    expect(await entitlement(USER_A)).toBe('none');
    await send('customer.subscription.created');
    expect(await entitlement(USER_A)).toBe('active');

    // A cancellation is fetched but not yet written: entitlement still comes from committed rows.
    ctx.fake.set(subscription({ status: 'canceled' }));
    const hold = ctx.fake.hold('sub_1');
    const pending = w({ client: ctx.b }).deliver(event('customer.subscription.deleted', { id: 'sub_1' }));
    await hold.reached;
    expect(await entitlement(USER_A)).toBe('active');

    hold.release();
    expect((await pending).status).toBe(200);
    expect(await entitlement(USER_A)).toBe('none');
    expect(await entitlement(USER_B)).toBe('none');
  });
});
