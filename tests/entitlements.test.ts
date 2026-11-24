// Unit tests for the EXAMPLE entitlement policy (pure function; no database).
import { describe, expect, test } from 'vitest';
import { exampleEntitlementPolicy, type StoredSubscription } from '../src/index.js';

const row = (status: string, id = `sub_${status}`): StoredSubscription => ({
  subscription_id: id,
  user_id: 'user_1',
  customer_id: 'cus_1',
  livemode: false,
  status,
  price_id: 'price_1',
  product_id: 'prod_1',
  quantity: 1,
  current_period_start: '2026-01-01T00:00:00+00:00',
  current_period_end: '2026-02-01T00:00:00+00:00',
  items: [{ id: 'si_1', price_id: 'price_1', product_id: 'prod_1', quantity: 1, current_period_start: 1767225600, current_period_end: 1769904000 }],
  cancel_at_period_end: false,
  cancel_at: null,
  canceled_at: null,
  ended_at: null,
  trial_end: null,
  tombstoned_at: status === 'canceled' ? '2026-01-02T00:00:00+00:00' : null,
  revision: 1,
  read_seq: 1,
  last_event_id: 'evt_1',
  updated_at: '2026-01-01T00:00:00+00:00',
});

describe('exampleEntitlementPolicy', () => {
  test('no_subscriptions_means_none', () => {
    expect(exampleEntitlementPolicy([])).toBe('none');
  });

  test.each(['active', 'trialing'])('%s_subscription_means_active', (status) => {
    expect(exampleEntitlementPolicy([row(status)])).toBe('active');
  });

  test.each(['past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'paused', 'some_future_status'])(
    '%s_subscription_alone_means_none',
    (status) => {
      expect(exampleEntitlementPolicy([row(status)])).toBe('none');
    },
  );

  test('any_active_subscription_wins_over_others', () => {
    expect(exampleEntitlementPolicy([row('canceled'), row('past_due'), row('active')])).toBe('active');
    expect(exampleEntitlementPolicy([row('canceled', 'a'), row('canceled', 'b')])).toBe('none');
  });

  test('cancel_at_period_end_does_not_end_access_early', () => {
    expect(exampleEntitlementPolicy([{ ...row('active'), cancel_at_period_end: true }])).toBe('active');
  });
});
