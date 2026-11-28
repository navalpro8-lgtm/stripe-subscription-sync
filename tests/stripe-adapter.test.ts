// fromStripeSdk() against a stub with the Stripe SDK's method shapes (no network).
import { expect, test } from 'vitest';
import { fromStripeSdk } from '../src/index.js';

test('stripe_adapter_pages_items_with_subscription_items_list', async () => {
  const calls: unknown[] = [];
  const retriever = fromStripeSdk({
    subscriptions: { retrieve: async (id: string) => ({ id }) },
    subscriptionItems: { list: async (params) => { calls.push(params); return { data: [], has_more: false }; } },
  });
  await retriever.listSubscriptionItems?.('sub_1', 'si_2');
  expect(calls).toEqual([{ subscription: 'sub_1', limit: 100, starting_after: 'si_2' }]);
});

test('stripe_adapter_without_subscription_items_has_no_pager', () => {
  const retriever = fromStripeSdk({ subscriptions: { retrieve: async (id: string) => ({ id }) } });
  expect(retriever.listSubscriptionItems).toBeUndefined();
});

test('stripe_adapter_lists_subscription_events_with_events_list', async () => {
  const calls: unknown[] = [];
  const retriever = fromStripeSdk({
    subscriptions: { retrieve: async (id: string) => ({ id }) },
    events: { list: async (params) => { calls.push(params); return { data: [], has_more: false }; } },
  });
  await retriever.listSubscriptionEvents?.(1_767_225_600);
  await retriever.listSubscriptionEvents?.(1_767_225_600, 'evt_9');
  expect(calls).toEqual([
    { type: 'customer.subscription.*', created: { gte: 1_767_225_600 }, limit: 100 },
    { type: 'customer.subscription.*', created: { gte: 1_767_225_600 }, limit: 100, starting_after: 'evt_9' },
  ]);
  expect(fromStripeSdk({ subscriptions: { retrieve: async (id: string) => ({ id }) } }).listSubscriptionEvents).toBeUndefined();
});
