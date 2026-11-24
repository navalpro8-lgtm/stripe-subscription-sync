// Stripe payload shape differences across API versions, and incomplete payloads.
import { describe, expect, test } from 'vitest';
import { DAY, event, invoice, subscription, T0, USER_A } from './support/builders.js';
import {
  ADAPTERS, count, eventRow, linkCustomer, setupSuite, subscriptionRow, worker, type WorkerOptions,
} from './support/harness.js';

const at = (unix: number) => new Date(unix * 1000);

describe.each(ADAPTERS)('payload shapes (%s adapter)', (adapter) => {
  const ctx = setupSuite();
  const w = (o: Partial<WorkerOptions> = {}) => worker({ adapter, client: ctx.a, fake: ctx.fake, ...o });

  test('invoice_new_and_old_shape', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription({ id: 'sub_new' }));
    ctx.fake.set(subscription({ id: 'sub_old', shape: 'legacy' }));

    const viaParent = await w().deliver(event('invoice.paid', invoice('sub_new', 'items')));
    const viaTopLevel = await w().deliver(event('invoice.payment_failed', invoice('sub_old', 'legacy')));
    const noSubscription = event('invoice.paid', invoice(null));
    const skipped = await w().deliver(noSubscription);

    expect([viaParent.status, viaTopLevel.status, skipped.status]).toEqual([200, 200, 200]);
    expect(await subscriptionRow(ctx.a, 'sub_new')).toMatchObject({ revision: 1, user_id: USER_A });
    expect(await subscriptionRow(ctx.a, 'sub_old')).toMatchObject({ revision: 1, user_id: USER_A });
    expect(await eventRow(ctx.a, noSubscription.id)).toMatchObject({ status: 'skipped' });
    expect(await count(ctx.a, 'stripe_subscriptions')).toBe(2);
  });

  test('period_fields_new_and_legacy_location', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription({ id: 'sub_items', start: T0, end: T0 + 30 * DAY }));
    ctx.fake.set(subscription({ id: 'sub_legacy', shape: 'legacy', start: T0 + DAY, end: T0 + 31 * DAY }));
    // Both locations present: the item-level fields win.
    const both = subscription({ id: 'sub_both', start: T0 + 2 * DAY, end: T0 + 32 * DAY });
    ctx.fake.set({ ...both, current_period_start: T0 - DAY, current_period_end: T0 });

    for (const id of ['sub_items', 'sub_legacy', 'sub_both']) {
      expect((await w().deliver(event('customer.subscription.created', { id }))).status).toBe(200);
    }

    expect(await subscriptionRow(ctx.a, 'sub_items')).toMatchObject({ current_period_start: at(T0), current_period_end: at(T0 + 30 * DAY) });
    expect(await subscriptionRow(ctx.a, 'sub_legacy')).toMatchObject({ current_period_start: at(T0 + DAY), current_period_end: at(T0 + 31 * DAY) });
    expect(await subscriptionRow(ctx.a, 'sub_both')).toMatchObject({ current_period_start: at(T0 + 2 * DAY), current_period_end: at(T0 + 32 * DAY) });
  });

  test('product_as_id_string', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription({ id: 'sub_string', product: 'prod_string' }));
    ctx.fake.set(subscription({ id: 'sub_object', product: { id: 'prod_object', object: 'product' } }));
    // Legacy item with only plan (no price): plan.product as an ID string.
    ctx.fake.set(subscription({ id: 'sub_plan', shape: 'legacy', price: 'plan_x', product: 'prod_plan', omit: ['items.data.0.price'] }));

    for (const id of ['sub_string', 'sub_object', 'sub_plan']) {
      expect((await w().deliver(event('customer.subscription.created', { id }))).status).toBe(200);
    }

    expect(await subscriptionRow(ctx.a, 'sub_string')).toMatchObject({ product_id: 'prod_string' });
    expect(await subscriptionRow(ctx.a, 'sub_object')).toMatchObject({ product_id: 'prod_object' });
    expect(await subscriptionRow(ctx.a, 'sub_plan')).toMatchObject({ product_id: 'prod_plan', price_id: 'plan_x' });
  });

  test('multi_item_subscription_stores_every_item', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription({
      id: 'sub_multi', price: 'price_base', product: 'prod_base', quantity: 1,
      extraItems: [{ price: 'price_addon', product: 'prod_addon', quantity: 3 }],
    }));
    ctx.fake.set(subscription({
      id: 'sub_multi_legacy', shape: 'legacy', price: 'price_base', product: 'prod_base',
      extraItems: [{ price: 'price_seat', product: 'prod_seat', quantity: 5 }],
    }));

    for (const id of ['sub_multi', 'sub_multi_legacy']) {
      expect((await w().deliver(event('customer.subscription.created', { id }))).status).toBe(200);
    }

    const period = { current_period_start: T0, current_period_end: T0 + 30 * DAY };
    expect(await subscriptionRow(ctx.a, 'sub_multi')).toMatchObject({
      price_id: 'price_base', product_id: 'prod_base', // first item, for simple queries
      items: [
        { id: 'si_sub_multi', price_id: 'price_base', product_id: 'prod_base', quantity: 1, ...period },
        { id: 'si_sub_multi_2', price_id: 'price_addon', product_id: 'prod_addon', quantity: 3, ...period },
      ],
    });
    // Legacy shape: item periods come from the subscription's top-level fields.
    expect(await subscriptionRow(ctx.a, 'sub_multi_legacy')).toMatchObject({
      items: [
        { price_id: 'price_base', product_id: 'prod_base', ...period },
        { price_id: 'price_seat', product_id: 'prod_seat', quantity: 5, ...period },
      ],
    });
  });

  test('incomplete_item_list_fails_without_state_change', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription({ price: 'price_a' }));
    await w().deliver(event('customer.subscription.created', { id: 'sub_1' }));
    const before = await subscriptionRow(ctx.a);

    // Stripe says the embedded item list is incomplete and this retriever cannot page:
    // refuse to write a partial picture.
    ctx.fake.set(subscription({ price: 'price_b', itemsHasMore: true }));
    const truncated = event('customer.subscription.updated', { id: 'sub_1' });
    expect((await w().deliver(truncated)).status).toBe(500);
    expect(String((await eventRow(ctx.a, truncated.id))?.last_error)).toMatch(/has_more/);

    // A later item without a product is just as incomplete.
    ctx.fake.set(subscription({ price: 'price_b', extraItems: [{ price: 'price_addon', product: 'prod_addon' }], omit: ['items.data.1.price.product'] }));
    const noProduct = event('customer.subscription.updated', { id: 'sub_1' });
    expect((await w().deliver(noProduct)).status).toBe(500);
    expect(String((await eventRow(ctx.a, noProduct.id))?.last_error)).toMatch(/items\.data\[1\]/);

    expect(await subscriptionRow(ctx.a)).toEqual(before);
  });

  /** sub_1 with 6 items; Stripe embeds the first 2 (has_more) and pages the rest 2 at a time. */
  function pagedSubscription(price: string, opts: { failAfter?: string } = {}) {
    const full = subscription({
      price,
      extraItems: [2, 3, 4, 5, 6].map((n) => ({ price: `price_addon_${n}`, product: `prod_addon_${n}`, quantity: n })),
    });
    const allItems = (full.items as { data: unknown[] }).data;
    ctx.fake.set({ ...full, items: { object: 'list', has_more: true, data: allItems.slice(0, 2) } });
    ctx.fake.pageItems('sub_1', allItems, 2, opts);
    return allItems.map((i) => (i as { id: string }).id);
  }

  test('item_list_is_paged_when_has_more', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    const ids = pagedSubscription('price_base');
    const r = await w().deliver(event('customer.subscription.created', { id: 'sub_1' }));
    expect(r).toMatchObject({ status: 200, body: { outcome: 'succeeded' } });

    const row = await subscriptionRow(ctx.a);
    expect((row?.items as Array<{ id: string }>).map((i) => i.id)).toEqual(ids); // all 6, in Stripe's order
    expect(row).toMatchObject({ price_id: 'price_base' });
    expect((row?.items as Array<{ quantity: number }>)[5]).toMatchObject({ product_id: 'prod_addon_6', quantity: 6 });
    // One retrieve, then two more pages: after the 2nd item and after the 4th.
    expect(ctx.fake.calls).toEqual(['sub_1', `items:sub_1:${ids[1]}`, `items:sub_1:${ids[3]}`]);
  });

  test('failure_on_a_later_item_page_fails_without_writing', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription({ price: 'price_a' }));
    await w().deliver(event('customer.subscription.created', { id: 'sub_1' }));
    const before = await subscriptionRow(ctx.a);

    // Page 1 succeeds, page 2 (after the 4th item) fails.
    const ids = pagedSubscription('price_b', { failAfter: 'si_sub_1_4' });
    const updated = event('customer.subscription.updated', { id: 'sub_1' });
    expect(await w().deliver(updated)).toMatchObject({ status: 500, body: { outcome: 'failed' } });
    expect(String((await eventRow(ctx.a, updated.id))?.last_error)).toMatch(/item page request failed/);
    expect(await subscriptionRow(ctx.a)).toEqual(before);

    // Stripe redelivers once the page works: everything is written.
    pagedSubscription('price_b');
    expect((await w().deliver(updated)).status).toBe(200);
    const row = await subscriptionRow(ctx.a);
    expect(row).toMatchObject({ price_id: 'price_b', revision: 2 });
    expect((row?.items as Array<{ id: string }>).map((i) => i.id)).toEqual(ids);
  });

  test('missing_required_field_fails_without_state_change_then_retry_succeeds', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription({ price: 'price_a' }));
    await w().deliver(event('customer.subscription.created', { id: 'sub_1' }));
    const before = await subscriptionRow(ctx.a);

    const missing = ['items.data.0.price', 'items.data.0.current_period_end', 'customer', 'status', 'cancel_at_period_end'];
    for (const field of missing) {
      ctx.fake.set(subscription({ price: 'price_b', omit: [field] }));
      const evt = event('customer.subscription.updated', { id: 'sub_1' });
      const res = await w().deliver(evt);

      expect(res.status, field).toBe(500);
      expect(await eventRow(ctx.a, evt.id), field).toMatchObject({ status: 'failed' });
      expect(String((await eventRow(ctx.a, evt.id))?.last_error), field).toMatch(/missing/i);
      expect(await subscriptionRow(ctx.a), field).toEqual(before);
    }

    // The same event fails while the field is missing, and succeeds on Stripe's retry once present.
    const retried = event('customer.subscription.updated', { id: 'sub_1' });
    ctx.fake.set(subscription({ price: 'price_b', omit: ['items.data.0.price'] }));
    expect((await w().deliver(retried)).status).toBe(500);
    ctx.fake.set(subscription({ price: 'price_b' }));
    expect((await w().deliver(retried)).status).toBe(200);
    expect(await eventRow(ctx.a, retried.id)).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(await subscriptionRow(ctx.a)).toMatchObject({ price_id: 'price_b', revision: 2 });
  });
});
