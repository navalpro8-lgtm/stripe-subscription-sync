// The read-order shortcut (SyncDeps.readOrderShortcut, opt-in) and the assumption it rests on: a
// Stripe read that starts after an event arrived reflects that event's change. FakeStripe's
// serveStale() breaks that assumption on purpose, to show what each setting does when it fails.
import { describe, expect, test } from 'vitest';
import { event, subscription, USER_A } from './support/builders.js';
import { ADAPTERS, eventRow, gate, linkCustomer, setupSuite, subscriptionRow, worker } from './support/harness.js';

describe.each(ADAPTERS)('read-order shortcut (%s adapter)', (adapter) => {
  const ctx = setupSuite();

  /**
   * Event A (the change to price_b) arrives and stalls before its read. Event B arrives later;
   * its Stripe read starts after A arrived but returns the OLD state (price_a), and commits.
   * Then A continues.
   */
  async function staleReadAfterEvent(readOrderShortcut: boolean) {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription({ price: 'price_a' }));
    await worker({ adapter, client: ctx.a, fake: ctx.fake }).deliver(event('customer.subscription.created', { id: 'sub_1' }));

    ctx.fake.set(subscription({ price: 'price_b' })); // Stripe now has price_b
    const beforeRead = gate();
    const eventA = event('customer.subscription.updated', { id: 'sub_1' });
    const pA = worker({
      adapter, client: ctx.a, fake: ctx.fake, readOrderShortcut,
      wrapStore: (s) => ({ ...s, beginRead: async (...args) => { await beforeRead.pass(); return s.beginRead(...args); } }),
    }).deliver(eventA);
    await beforeRead.reached;

    ctx.fake.serveStale(subscription({ price: 'price_a' }));
    const eventB = event('invoice.paid', { id: 'in_1', object: 'invoice', parent: { subscription_details: { subscription: 'sub_1' } } });
    expect((await worker({ adapter, client: ctx.b, fake: ctx.fake, readOrderShortcut }).deliver(eventB)).status).toBe(200);
    expect(await subscriptionRow(ctx.a)).toMatchObject({ price_id: 'price_a', revision: 2 }); // the stale read landed

    beforeRead.release();
    return { result: await pA, eventA };
  }

  test('shortcut_off_converges_after_a_stale_read', async () => {
    const { result, eventA } = await staleReadAfterEvent(false);
    expect(result).toMatchObject({ status: 200, body: { outcome: 'succeeded' } });
    // A fetched for itself and wrote the fresh state.
    expect(await subscriptionRow(ctx.a)).toMatchObject({ price_id: 'price_b', revision: 3, last_event_id: eventA.id });
    expect(ctx.fake.calls).toHaveLength(3);
  });

  test('shortcut_on_keeps_a_stale_read_documented_risk', async () => {
    // Documented failure mode, asserted so a change in behaviour is noticed: with the shortcut on,
    // A trusts B's later (but stale) read, skips without fetching, and the row stays stale until
    // another event for this subscription arrives.
    const { result, eventA } = await staleReadAfterEvent(true);
    expect(result).toMatchObject({ status: 200, body: { outcome: 'skipped' } });
    expect(await subscriptionRow(ctx.a)).toMatchObject({ price_id: 'price_a', revision: 2 });
    expect(await eventRow(ctx.a, eventA.id)).toMatchObject({ status: 'skipped' });
    expect(ctx.fake.calls).toHaveLength(2);

    // The next event fetches again and repairs it.
    await worker({ adapter, client: ctx.a, fake: ctx.fake, readOrderShortcut: true }).deliver(event('customer.subscription.updated', { id: 'sub_1' }));
    expect(await subscriptionRow(ctx.a)).toMatchObject({ price_id: 'price_b', revision: 3 });
  });

  test('shortcut_never_skips_a_deleted_event', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription());
    const beforeRead = gate();
    const deleted = event('customer.subscription.deleted', { id: 'sub_1' });
    const pA = worker({
      adapter, client: ctx.a, fake: ctx.fake, readOrderShortcut: true,
      wrapStore: (s) => ({ ...s, beginRead: async (...args) => { await beforeRead.pass(); return s.beginRead(...args); } }),
    }).deliver(deleted);
    await beforeRead.reached;
    // A later read (stale: still active) commits after the deleted event arrived.
    await worker({ adapter, client: ctx.b, fake: ctx.fake, readOrderShortcut: true }).deliver(event('customer.subscription.updated', { id: 'sub_1' }));
    ctx.fake.set(subscription({ status: 'canceled' }));
    beforeRead.release();
    expect(await pA).toMatchObject({ status: 200, body: { outcome: 'succeeded' } });
    expect(await subscriptionRow(ctx.a)).toMatchObject({ status: 'canceled' });
  });
});

describe.each(ADAPTERS)('stale-read guard (%s adapter)', (adapter) => {
  const ctx = setupSuite();
  const now = () => Math.floor(Date.now() / 1000);
  /** A fresh customer.subscription.updated event saying status went past_due -> active. */
  const updated = (created = now()) => ({
    ...event('customer.subscription.updated', { id: 'sub_1', status: 'active', cancel_at_period_end: false }),
    created,
    data: { object: { id: 'sub_1', status: 'active', cancel_at_period_end: false }, previous_attributes: { status: 'past_due' } },
  });

  test('stale_read_contradicting_the_event_is_retried_not_written', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription({ status: 'active' }));
    // The first two reads still show the pre-event status.
    ctx.fake.serveStale(subscription({ status: 'past_due' }));
    ctx.fake.serveStale(subscription({ status: 'past_due' }));
    const r = await worker({ adapter, client: ctx.a, fake: ctx.fake }).deliver(updated());
    expect(r).toMatchObject({ status: 200, body: { outcome: 'succeeded' } });
    expect(await subscriptionRow(ctx.a)).toMatchObject({ status: 'active', revision: 1 });
    expect(ctx.fake.calls).toHaveLength(3);
  });

  test('stale_reads_that_persist_fail_the_event_without_writing', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription({ status: 'past_due' })); // Stripe keeps returning the old state
    const e = updated();
    expect(await worker({ adapter, client: ctx.a, fake: ctx.fake }).deliver(e)).toMatchObject({ status: 500, body: { outcome: 'failed' } });
    expect(String((await eventRow(ctx.a, e.id))?.last_error)).toMatch(/from before this event/);
    expect(await subscriptionRow(ctx.a)).toBeUndefined();
  });

  test('old_events_are_not_checked_for_staleness', async () => {
    // Older than the guard window: the field may have legitimately changed back since.
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription({ status: 'past_due' }));
    expect((await worker({ adapter, client: ctx.a, fake: ctx.fake }).deliver(updated(now() - 3600))).status).toBe(200);
    expect(await subscriptionRow(ctx.a)).toMatchObject({ status: 'past_due' });
  });
});
