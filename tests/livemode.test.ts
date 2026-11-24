// Test/live separation and Connect events. The endpoint's mode is SyncDeps.livemode; anything
// from the other mode is refused without writing subscription or link state.
import { describe, expect, test } from 'vitest';
import { checkoutSession, event, subscription, USER_A } from './support/builders.js';
import { createNextWebhookHandler, type SyncDeps } from '../src/index.js';
import {
  ADAPTERS, count, eventRow, linkCustomer, setupSuite, storeFor, stripeSdk, subscriptionRow, WEBHOOK_SECRET, worker,
} from './support/harness.js';

const live = <T extends { livemode: boolean }>(e: T): T => ({ ...e, livemode: true });

describe.each(ADAPTERS)('livemode (%s adapter)', (adapter) => {
  const ctx = setupSuite();
  const testEndpoint = () => worker({ adapter, client: ctx.a, fake: ctx.fake, livemode: false });
  const liveEndpoint = () => worker({ adapter, client: ctx.a, fake: ctx.fake, livemode: true });

  async function nothingWritten() {
    expect(await count(ctx.a, 'stripe_events')).toBe(0);
    expect(await count(ctx.a, 'stripe_subscriptions')).toBe(0);
    expect(await count(ctx.a, 'stripe_customer_links')).toBe(0);
    expect(ctx.fake.calls).toHaveLength(0);
  }

  test('live_event_is_refused_by_a_test_mode_endpoint', async () => {
    ctx.fake.set(subscription({ livemode: true }));
    const r = await testEndpoint().deliver(live(event('customer.subscription.created', { id: 'sub_1' })));
    expect(r).toMatchObject({ status: 400, body: { outcome: 'livemode_mismatch' } });
    await nothingWritten();
  });

  test('test_event_is_refused_by_a_live_mode_endpoint', async () => {
    ctx.fake.set(subscription());
    const r = await liveEndpoint().deliver(event('customer.subscription.created', { id: 'sub_1' }));
    expect(r).toMatchObject({ status: 400, body: { outcome: 'livemode_mismatch' } });
    const r2 = await liveEndpoint().deliver(event('checkout.session.completed', checkoutSession()));
    expect(r2.status).toBe(400);
    await nothingWritten();
  });

  test('event_without_livemode_is_refused', async () => {
    const noMode: Partial<ReturnType<typeof event>> = event('customer.subscription.created', { id: 'sub_1' });
    delete noMode.livemode;
    const r = await testEndpoint().deliver(noMode);
    expect(r).toMatchObject({ status: 400, body: { outcome: 'livemode_mismatch' } });
    await nothingWritten();
  });

  test('fetched_subscription_from_the_other_mode_fails_without_writing', async () => {
    // Test endpoint, test event, but Stripe returns a live-mode subscription.
    await linkCustomer(ctx.a, 'cus_1', USER_A, false);
    ctx.fake.set(subscription({ livemode: true }));
    const e1 = event('customer.subscription.created', { id: 'sub_1' });
    expect(await testEndpoint().deliver(e1)).toMatchObject({ status: 500, body: { outcome: 'failed' } });
    expect(String((await eventRow(ctx.a, e1.id))?.last_error)).toMatch(/livemode=true, endpoint expects false/);

    // Live endpoint, live event, but Stripe returns a test-mode subscription.
    ctx.fake.set(subscription({ id: 'sub_2', livemode: false }));
    const e2 = live(event('customer.subscription.created', { id: 'sub_2' }));
    expect(await liveEndpoint().deliver(e2)).toMatchObject({ status: 500, body: { outcome: 'failed' } });
    expect(String((await eventRow(ctx.a, e2.id))?.last_error)).toMatch(/livemode=false, endpoint expects true/);

    expect(await count(ctx.a, 'stripe_subscriptions')).toBe(0);
  });

  test('stored_subscription_from_the_other_mode_is_not_overwritten', async () => {
    // A test-mode row exists (a database shared by both modes, against the advice in the docs).
    await linkCustomer(ctx.a, 'cus_1', USER_A, false);
    ctx.fake.set(subscription({ price: 'price_test' }));
    expect((await testEndpoint().deliver(event('customer.subscription.created', { id: 'sub_1' }))).status).toBe(200);
    const before = await subscriptionRow(ctx.a);

    ctx.fake.set(subscription({ price: 'price_live', livemode: true }));
    const e = live(event('customer.subscription.updated', { id: 'sub_1' }));
    expect(await liveEndpoint().deliver(e)).toMatchObject({ status: 500, body: { outcome: 'failed' } });
    expect(String((await eventRow(ctx.a, e.id))?.last_error)).toMatch(/other Stripe mode/);
    expect(await subscriptionRow(ctx.a)).toEqual(before);
  });

  test('customer_link_from_the_other_mode_is_not_relinked', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A, false);
    const e = live(event('checkout.session.completed', checkoutSession()));
    expect(await liveEndpoint().deliver(e)).toMatchObject({ status: 500, body: { outcome: 'failed' } });
    expect(String((await eventRow(ctx.a, e.id))?.last_error)).toMatch(/other Stripe mode/);
    const links = await ctx.a.query('select user_id, livemode from public.stripe_customer_links');
    expect(links.rows).toEqual([{ user_id: USER_A, livemode: false }]);
  });

  test('matching_mode_is_stored_on_every_row', async () => {
    const e1 = live(event('checkout.session.completed', checkoutSession()));
    expect((await liveEndpoint().deliver(e1)).status).toBe(200);
    ctx.fake.set(subscription({ livemode: true }));
    const e2 = live(event('customer.subscription.created', { id: 'sub_1' }));
    expect((await liveEndpoint().deliver(e2)).status).toBe(200);
    expect(await eventRow(ctx.a, e1.id)).toMatchObject({ livemode: true, status: 'succeeded' });
    expect(await subscriptionRow(ctx.a)).toMatchObject({ livemode: true });
    const links = await ctx.a.query('select livemode from public.stripe_customer_links');
    expect(links.rows).toEqual([{ livemode: true }]);
  });

  test('connect_event_is_recorded_as_ignored', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A, false);
    ctx.fake.set(subscription());
    const e = { ...event('customer.subscription.updated', { id: 'sub_1' }), account: 'acct_connected_1' };
    expect(await testEndpoint().deliver(e)).toMatchObject({ status: 200, body: { outcome: 'ignored' } });
    expect(await eventRow(ctx.a, e.id)).toMatchObject({ status: 'ignored', last_error: 'connect_event_unsupported' });
    expect(ctx.fake.calls).toHaveLength(0);
    expect(await count(ctx.a, 'stripe_subscriptions')).toBe(0);
  });

  test('missing_livemode_option_fails_at_startup', () => {
    const sync = { store: storeFor(adapter, ctx.a), stripe: ctx.fake } as unknown as SyncDeps;
    expect(() => createNextWebhookHandler({ stripe: stripeSdk, webhookSecret: WEBHOOK_SECRET, sync })).toThrow(/livemode is required/);
  });
});
