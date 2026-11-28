// Documents current behavior, not a goal: with the read-order shortcut off (the default), every
// subscription event makes its own Stripe fetch. A bulk change in Stripe (for example a price
// change on many subscriptions) therefore costs one Stripe read per event; see
// KNOWN_LIMITATIONS.md, "Stripe rate limits". If a later change merges or skips fetches, this
// test fails and the number below should be updated on purpose.
import { describe, expect, test } from 'vitest';
import { event, subscription, USER_A } from './support/builders.js';
import { count, linkCustomer, setupSuite, worker } from './support/harness.js';

describe('Stripe fetches per event (postgres adapter)', () => {
  const ctx = setupSuite();

  test('fifty_events_for_fifty_subscriptions_make_fifty_stripe_fetches', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    const ids = Array.from({ length: 50 }, (_, i) => `sub_${String(i + 1).padStart(2, '0')}`);
    for (const id of ids) ctx.fake.set(subscription({ id, price: 'price_new' }));

    // One customer.subscription.updated per subscription, all at once, over two connections.
    const a = worker({ adapter: 'postgres', client: ctx.a, fake: ctx.fake });
    const b = worker({ adapter: 'postgres', client: ctx.b, fake: ctx.fake });
    const responses = await Promise.all(ids.map((id, i) => (i % 2 ? a : b).deliver(event('customer.subscription.updated', { id }))));

    expect(responses.every((r) => r.status === 200 && r.body.outcome === 'succeeded')).toBe(true);
    expect(await count(ctx.a, 'stripe_subscriptions')).toBe(50);
    // calls records every retrieveSubscription (and any list call, none here).
    expect(ctx.fake.calls).toHaveLength(50);
    expect(new Set(ctx.fake.calls)).toEqual(new Set(ids));
  });
});
