// End-to-end check of reconcileRecent against REAL Stripe test mode and a real (embedded) Postgres.
// Creates a product, two prices, a customer and a subscription in your Stripe TEST account, then
// checks the database row after: first reconcile, a no-op reconcile, a price change, cancel at
// period end, and cancel. Cancels the subscription and archives the product at the end.
//
//   npm ci && npm run build && STRIPE_SECRET_KEY=sk_test_... node scripts/e2e-real-stripe.mjs
//
// Refuses to run with a live key. Not part of npm test (it needs network access to Stripe).
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import Stripe from 'stripe';
import { fromStripeSdk, postgresStore, reconcileRecent } from '../dist/index.js';

const key = process.env.STRIPE_SECRET_KEY ?? '';
if (!key.startsWith('sk_test_')) throw new Error('Refusing to run: STRIPE_SECRET_KEY must be a test-mode key (sk_test_...)');

const stripe = new Stripe(key);
const TAG = { created_by: 'stripe-subscription-sync issue #2 e2e run' };
const USER_ID = 'e2e-user-1';
let failures = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Postgres: the same setup the repo's tests use, with the shipped schema ---
const pgDir = await mkdtemp(join(tmpdir(), 'sss-e2e-'));
const embedded = new EmbeddedPostgres({ databaseDir: pgDir, user: 'postgres', password: 'postgres', port: 55432, persistent: false, onLog: () => {} });
await embedded.initialise();
await embedded.start();
await embedded.createDatabase('sss_e2e');
const pool = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:55432/sss_e2e' });
await pool.query(await readFile('sql/schema.sql', 'utf8'));

const deps = { livemode: false, store: postgresStore(pool), stripe: fromStripeSdk(stripe), logger: { info() {}, warn: console.warn, error: console.error } };
const row = async (id) => (await pool.query('select * from public.stripe_subscriptions where subscription_id = $1', [id])).rows[0];
// Stripe's events list can lag the API write by a moment; poll until the subscription's latest event shows up.
async function waitForEvent(subId, type, since) {
  for (let i = 0; i < 20; i++) {
    const page = await stripe.events.list({ type, created: { gte: Math.floor(since.getTime() / 1000) }, limit: 100 });
    if (page.data.some((e) => e.data.object.id === subId)) return true;
    await sleep(1500);
  }
  return false;
}

let sub, product;
try {
  // Margin of a minute so clock skew between this machine and Stripe can't drop the events.
  const since = new Date(Date.now() - 60_000);

  // --- Real Stripe test objects ---
  product = await stripe.products.create({ name: 'sss e2e plan', metadata: TAG });
  const priceA = await stripe.prices.create({ product: product.id, currency: 'usd', unit_amount: 500, recurring: { interval: 'month' }, metadata: TAG });
  const priceB = await stripe.prices.create({ product: product.id, currency: 'usd', unit_amount: 900, recurring: { interval: 'month' }, metadata: TAG });
  const customer = await stripe.customers.create({ description: 'sss e2e customer', metadata: TAG, payment_method: 'pm_card_visa', invoice_settings: { default_payment_method: 'pm_card_visa' } });
  sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: priceA.id }], metadata: TAG });
  console.log(`created in Stripe test mode: ${customer.id}, ${sub.id} (status ${sub.status})`);

  // The app normally links customer → user from checkout.session.completed; do that link directly.
  await pool.query(
    `insert into public.stripe_customer_links (stripe_customer_id, user_id, livemode, linked_by_event) values ($1, $2, false, 'e2e-manual-link')`,
    [customer.id, USER_ID],
  );

  // --- 1. First run: no row yet → written ---
  check('Stripe listed the create event', await waitForEvent(sub.id, 'customer.subscription.created', since));
  let r = await reconcileRecent({ since }, deps);
  let stored = await row(sub.id);
  check('run 1: subscription found and written', r.checked >= 1 && r.updated >= 1 && r.failed === 0, JSON.stringify({ checked: r.checked, updated: r.updated, unchanged: r.unchanged, failed: r.failed }));
  check('run 1: row status matches Stripe', stored?.status === sub.status, `row=${stored?.status} stripe=${sub.status}`);
  check('run 1: row price is price A', stored?.price_id === priceA.id, `row=${stored?.price_id}`);
  check('run 1: row owned by linked user, test mode', stored?.user_id === USER_ID && stored?.livemode === false);
  const rev1 = stored?.revision;

  // --- 2. Second run, nothing changed in Stripe → no write ---
  r = await reconcileRecent({ since }, deps);
  stored = await row(sub.id);
  const mine = r.results.find((x) => x.subscriptionId === sub.id);
  check('run 2: unchanged, nothing rewritten', mine?.outcome === 'unchanged' && stored?.revision === rev1, `outcome=${mine?.outcome} revision ${rev1}→${stored?.revision}`);

  // --- 3. Price change in Stripe (no webhook delivered anywhere) → reconcile picks it up ---
  const changeAt = new Date(Date.now() - 60_000);
  await stripe.subscriptions.update(sub.id, { items: [{ id: sub.items.data[0].id, price: priceB.id }], proration_behavior: 'none' });
  check('Stripe listed the update event', await waitForEvent(sub.id, 'customer.subscription.updated', changeAt));
  r = await reconcileRecent({ since }, deps);
  stored = await row(sub.id);
  check('run 3: price change applied', stored?.price_id === priceB.id && stored?.revision > rev1, `row price=${stored?.price_id} revision=${stored?.revision}`);

  // --- 4. Cancel at period end ---
  await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
  await sleep(3000);
  r = await reconcileRecent({ since }, deps);
  stored = await row(sub.id);
  check('run 4: cancel_at_period_end recorded', stored?.cancel_at_period_end === true, `row=${stored?.cancel_at_period_end}`);

  // --- 5. Cancel now ---
  const cancelAt = new Date(Date.now() - 60_000);
  await stripe.subscriptions.cancel(sub.id);
  check('Stripe listed the delete event', await waitForEvent(sub.id, 'customer.subscription.deleted', cancelAt));
  r = await reconcileRecent({ since }, deps);
  stored = await row(sub.id);
  const live = await stripe.subscriptions.retrieve(sub.id);
  check('run 5: row says canceled, same as Stripe', stored?.status === 'canceled' && live.status === 'canceled', `row=${stored?.status} stripe=${live.status}`);
  check('run 5: no failures', r.failed === 0, JSON.stringify({ checked: r.checked, updated: r.updated, unchanged: r.unchanged, failed: r.failed }));
  sub = null; // already canceled
} finally {
  // Leave nothing billing in the test account: cancel the subscription if a step threw, archive the product.
  if (sub) await stripe.subscriptions.cancel(sub.id).catch(() => {});
  if (product) await stripe.products.update(product.id, { active: false }).catch(() => {});
  await pool.end();
  await embedded.stop();
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
