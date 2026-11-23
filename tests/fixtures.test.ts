// Replays every file in fixtures/ through the webhook handler. All fixtures are SYNTHETIC
// (see fixtures/README.md); this checks the documented shapes, not real Stripe output.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { ADAPTERS, eventRow, linkCustomer, setupSuite, subscriptionRow, worker } from './support/harness.js';

interface FixtureCase {
  _provenance: 'synthetic' | 'stripe-generated';
  _models: string;
  event: { id: string; type: string; data: { object: Record<string, unknown> } };
  retrieve?: Record<string, unknown>;
}

const load = (dir: string, name: string): FixtureCase =>
  JSON.parse(readFileSync(`fixtures/${dir}/${name}.json`, 'utf8')) as FixtureCase;

test('every_fixture_declares_its_provenance', () => {
  for (const dir of readdirSync('fixtures', { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const file of readdirSync(`fixtures/${dir.name}`)) {
      const c = JSON.parse(readFileSync(`fixtures/${dir.name}/${file}`, 'utf8')) as FixtureCase;
      expect(['synthetic', 'stripe-generated'], file).toContain(c._provenance);
      expect(c._models, file).toBeTruthy();
    }
  }
});

describe.each(ADAPTERS)('fixtures (%s adapter)', (adapter) => {
  const ctx = setupSuite();
  const replay = async (c: FixtureCase) => {
    if (c.retrieve) ctx.fake.set(c.retrieve);
    return worker({ adapter, client: ctx.a, fake: ctx.fake }).deliver(c.event);
  };

  test('basil_fixtures_link_create_renew_and_cancel', async () => {
    const dir = '2025-03-31.basil';
    const checkout = load(dir, 'checkout.session.completed');
    expect(await replay(checkout)).toMatchObject({ status: 200 });
    const linked = await ctx.a.query('select user_id from public.stripe_customer_links where stripe_customer_id = $1', ['cus_fx1']);
    expect(linked.rows).toEqual([{ user_id: checkout.event.data.object.client_reference_id }]);

    expect((await replay(load(dir, 'customer.subscription.created'))).status).toBe(200);
    expect(await subscriptionRow(ctx.a, 'sub_fx1')).toMatchObject({
      status: 'active', price_id: 'price_fx_pro', product_id: 'prod_fx_pro', revision: 1,
      current_period_start: new Date(1_767_225_600_000),
    });

    const invoicePaid = load(dir, 'invoice.paid');
    expect((await replay(invoicePaid)).status).toBe(200);
    expect(await subscriptionRow(ctx.a, 'sub_fx1')).toMatchObject({ revision: 2, last_event_id: invoicePaid.event.id });

    expect((await replay(load(dir, 'customer.subscription.deleted'))).status).toBe(200);
    const row = await subscriptionRow(ctx.a, 'sub_fx1');
    expect(row).toMatchObject({ status: 'canceled', revision: 3 });
    expect(row?.tombstoned_at).toBeInstanceOf(Date);
  });

  test('acacia_fixtures_use_top_level_periods_and_invoice_subscription', async () => {
    const dir = '2025-02-24.acacia';
    await linkCustomer(ctx.a, 'cus_fx1', '00000000-0000-4000-8000-0000000000f1');

    const updated = load(dir, 'customer.subscription.updated');
    expect((await replay(updated)).status).toBe(200);
    expect(await subscriptionRow(ctx.a, 'sub_fx1')).toMatchObject({
      price_id: 'price_fx_pro', product_id: 'prod_fx_pro', revision: 1,
      current_period_start: new Date(1_767_225_600_000),
    });

    const failed = load(dir, 'invoice.payment_failed');
    expect((await replay(failed)).status).toBe(200);
    expect(await eventRow(ctx.a, failed.event.id)).toMatchObject({ status: 'succeeded' });
    expect(await subscriptionRow(ctx.a, 'sub_fx1')).toMatchObject({ revision: 2 });
  });
});
