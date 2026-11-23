// Customer → user mapping: linking from checkout, missing/invalid mapping, ownership never moves.
import { describe, expect, test } from 'vitest';
import { defaultUserResolver } from '../src/index.js';
import { checkoutSession, event, subscription, USER_A, USER_B } from './support/builders.js';
import {
  ADAPTERS, count, eventRow, linkCustomer, setupSuite, subscriptionRow, worker, type WorkerOptions,
} from './support/harness.js';

describe.each(ADAPTERS)('user mapping (%s adapter)', (adapter) => {
  const ctx = setupSuite();
  const w = (o: Partial<WorkerOptions> = {}) => worker({ adapter, client: ctx.a, fake: ctx.fake, ...o });
  const links = async () =>
    (await ctx.a.query('select stripe_customer_id, user_id from public.stripe_customer_links order by 1')).rows;

  test('subscription_before_checkout_link_fails_then_succeeds_after_link', async () => {
    ctx.fake.set(subscription());
    const created = event('customer.subscription.created', { id: 'sub_1' });

    const early = await w().deliver(created);
    expect(early.status).toBe(500);
    expect(await eventRow(ctx.a, created.id)).toMatchObject({ status: 'failed' });
    expect(String((await eventRow(ctx.a, created.id))?.last_error)).toMatch(/cus_1/);
    expect(await count(ctx.a, 'stripe_subscriptions')).toBe(0);

    const checkout = event('checkout.session.completed', checkoutSession({ customer: 'cus_1', clientReferenceId: USER_A }));
    expect((await w().deliver(checkout)).status).toBe(200);
    expect(await eventRow(ctx.a, checkout.id)).toMatchObject({ status: 'succeeded' });
    expect(await links()).toEqual([{ stripe_customer_id: 'cus_1', user_id: USER_A }]);
    expect(await count(ctx.a, 'stripe_subscriptions')).toBe(0); // checkout only links

    expect((await w().deliver(created)).status).toBe(200);
    expect(await subscriptionRow(ctx.a)).toMatchObject({ user_id: USER_A, customer_id: 'cus_1', revision: 1 });
  });

  test('checkout_without_client_reference_id_fails_and_writes_nothing', async () => {
    const cases = [
      { clientReferenceId: null },
      { clientReferenceId: '' },
      { clientReferenceId: '   ' },
      { clientReferenceId: 'x'.repeat(256) },
      { customer: null },
    ];
    for (const c of cases) {
      const evt = event('checkout.session.completed', checkoutSession(c));
      expect((await w().deliver(evt)).status, JSON.stringify(c)).toBe(500);
      expect(await eventRow(ctx.a, evt.id)).toMatchObject({ status: 'failed' });
    }

    const payment = event('checkout.session.completed', checkoutSession({ mode: 'payment', clientReferenceId: null }));
    expect(await w().deliver(payment)).toMatchObject({ status: 200, body: { outcome: 'skipped' } });
    expect(await eventRow(ctx.a, payment.id)).toMatchObject({ status: 'skipped' });

    expect(await count(ctx.a, 'stripe_customer_links')).toBe(0);
  });

  test('customer_link_is_never_reassigned', async () => {
    const first = event('checkout.session.completed', checkoutSession({ clientReferenceId: USER_A }));
    expect((await w().deliver(first)).status).toBe(200);

    const hijack = event('checkout.session.completed', checkoutSession({ clientReferenceId: USER_B }));
    expect((await w().deliver(hijack)).status).toBe(500);
    expect(String((await eventRow(ctx.a, hijack.id))?.last_error)).toMatch(/another user/i);

    const same = event('checkout.session.completed', checkoutSession({ clientReferenceId: USER_A }));
    expect((await w().deliver(same)).status).toBe(200);

    expect(await links()).toEqual([{ stripe_customer_id: 'cus_1', user_id: USER_A }]);
  });

  test('subscription_owner_never_changes', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription());
    await w().deliver(event('customer.subscription.created', { id: 'sub_1' }));

    // A custom resolver that maps the same subscription to someone else is refused.
    const wrongUsers = { ...defaultUserResolver, userForSubscription: async () => USER_B };
    const updated = event('customer.subscription.updated', { id: 'sub_1' });
    expect((await w({ users: wrongUsers }).deliver(updated)).status).toBe(500);

    expect(await eventRow(ctx.a, updated.id)).toMatchObject({ status: 'failed' });
    expect(String((await eventRow(ctx.a, updated.id))?.last_error)).toMatch(/another user/i);
    expect(await subscriptionRow(ctx.a)).toMatchObject({ user_id: USER_A, revision: 1 });
  });
});
