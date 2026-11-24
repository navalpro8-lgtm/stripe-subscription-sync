// Local load test: 100 concurrent connections for 10 s against the webhook handler.
// SYNTHETIC: it measures this module against a fake Stripe on one machine. It says nothing about
// real Stripe latency, real Stripe read freshness, your host or your database.
// Every scenario runs twice: read-order shortcut off (the default) and on.
// Everything is local: a throwaway embedded Postgres, a fake Stripe (20–80 ms per retrieve), and
// events signed with a local test secret. No Stripe or Supabase account is touched.
//
//   npm run build && npm i --no-save autocannon@8.0.0 && node bench/load-test.mjs
//
// Each scenario checks database invariants afterwards, not only throughput:
//   - every 'succeeded' subscription event applied exactly one write (sum of revisions);
//   - after the load, one more event brings each row to Stripe's current state;
//   - nothing is left 'processing'.
import { fork } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import http from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import Stripe from 'stripe';

const SECRET = 'whsec_local_load_test_only';
const stripe = new Stripe('sk_test_local_never_used');
const CUSTOMER = 'cus_load';
const USER = '00000000-0000-4000-8000-000000000001';
const T0 = 1_767_225_600;

const subscription = (id, price) => ({
  id, object: 'subscription', customer: CUSTOMER, status: 'active', cancel_at_period_end: false,
  cancel_at: null, canceled_at: null, ended_at: null, trial_end: null,
  livemode: false,
  items: { object: 'list', data: [{ id: `si_${id}`, quantity: 1, current_period_start: T0, current_period_end: T0 + 2_592_000,
    price: { id: price, object: 'price', product: 'prod_load' } }] },
});

// ------------------------------------------------------------------ server (child process)
if (process.argv[2] === '--server') {
  const { createNextWebhookHandler, postgresStore } = await import('../dist/index.js');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
  const state = new Map(); // subscription id -> current Stripe state
  const retriever = {
    async retrieveSubscription(id) {
      const s = structuredClone(state.get(id));
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 60));
      if (!s) throw new Error(`no such subscription ${id}`);
      return s;
    },
  };
  const handler = createNextWebhookHandler({ stripe, webhookSecret: SECRET, sync: { livemode: false, store: postgresStore(pool), stripe: retriever, readOrderShortcut: process.env.READ_ORDER_SHORTCUT === '1' } });

  http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      if (req.url === '/stripe-state') { // test control: set Stripe-side state
        for (const s of JSON.parse(body)) state.set(s.id, s);
        res.end('ok');
        return;
      }
      const headers = { 'content-type': 'application/json' };
      if (req.headers['stripe-signature']) headers['stripe-signature'] = req.headers['stripe-signature'];
      const r = await handler(new Request('http://localhost/webhook', { method: 'POST', headers, body }));
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(await r.text());
    });
  }).listen(Number(process.env.PORT), '127.0.0.1', () => process.send?.('ready'));
} else {
  await main();
}

// ------------------------------------------------------------------ driver
async function main() {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');

  const pgPort = await freePort();
  const appPort = await freePort();
  const db = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'sss-load-')), user: 'postgres', password: 'postgres', port: pgPort, persistent: false, onLog: () => {} });
  await db.initialise();
  await db.start();
  await db.createDatabase('sss_load_test');
  const url = `postgres://postgres:postgres@127.0.0.1:${pgPort}/sss_load_test`;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(await readFile('sql/schema.sql', 'utf8'));

  const results = [];
  for (const shortcut of [false, true]) {
    const server = fork(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), ['--server'], {
      env: { ...process.env, DATABASE_URL: url, PORT: String(appPort), READ_ORDER_SHORTCUT: shortcut ? '1' : '0' },
    });
    await new Promise((r) => server.once('message', r));
    await scenarios(`http://127.0.0.1:${appPort}`, client, shortcut ? 'shortcut_on' : 'shortcut_off', results);
    server.kill();
    await new Promise((r) => server.once('exit', r));
  }
  console.log(JSON.stringify(results, null, 2));
  await client.end();
  await db.stop();
}

async function scenarios(base, client, mode, results) {
  const { default: autocannon } = await import('autocannon');
  const setStripe = (subs) => fetch(`${base}/stripe-state`, { method: 'POST', body: JSON.stringify(subs) });

  const sign = (evt) => {
    const payload = JSON.stringify(evt);
    return { payload, headers: { 'content-type': 'application/json', 'stripe-signature': stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET }) } };
  };
  const event = (id, type, objectId) => ({ id, object: 'event', type, created: T0, livemode: false, data: { object: { id: objectId } } });
  const reset = async () => {
    await client.query('truncate stripe_events, stripe_customer_links, stripe_subscriptions');
    await client.query(`insert into stripe_customer_links (stripe_customer_id, user_id, livemode, linked_by_event) values ($1, $2, false, 'load-setup')`, [CUSTOMER, USER]);
  };
  const run = async (name, opts, subIds, mutate) => {
    const r = await autocannon({ url: `${base}/webhook`, connections: 100, duration: 10, method: 'POST', ...opts });
    // Settle: one more serial event per subscription, so each row must end at Stripe's state.
    if (mutate) await mutate();
    for (const id of subIds) {
      const { payload, headers } = sign(event(`evt_settle_${mode}_${name}_${id}`, 'customer.subscription.updated', id));
      await fetch(`${base}/webhook`, { method: 'POST', headers, body: payload });
    }
    // Requests still in flight when autocannon stops keep running server-side; give them up to
    // 5 s to finish. Anything still 'processing' after that is reported as stuck.
    const waitStart = Date.now();
    while (Date.now() - waitStart < 5000) {
      const n = (await client.query(`select count(*)::int n from stripe_events where status = 'processing'`)).rows[0].n;
      if (n === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const ev = (await client.query(`select status, count(*)::int n from stripe_events group by 1 order by 1`)).rows;
    const subs = (await client.query(`select subscription_id, price_id, revision from stripe_subscriptions order by 1`)).rows;
    const succeededSubEvents = (await client.query(
      `select count(*)::int n from stripe_events where status = 'succeeded' and event_type like 'customer.subscription.%'`)).rows[0].n;
    const sumRevisions = subs.reduce((a, s) => a + s.revision, 0);
    results.push({
      mode,
      scenario: name,
      requests: r.requests.total,
      reqPerSec: Math.round(r.requests.average),
      latencyMs: { p50: r.latency.p50, p99: r.latency.p99, max: r.latency.max },
      statusCodes: Object.fromEntries(Object.entries(r.statusCodeStats ?? {}).map(([k, v]) => [k, v.count])),
      errors: r.errors, timeouts: r.timeouts,
      eventsByStatus: Object.fromEntries(ev.map((e) => [e.status, e.n])),
      subscriptions: subs.length,
      invariant_oneWritePerSucceededEvent: { succeededSubEvents, sumRevisions, ok: succeededSubEvents === sumRevisions },
      stuckProcessing: ev.find((e) => e.status === 'processing')?.n ?? 0,
    });
    return subs;
  };

  // A) Duplicate storm: the SAME signed event from 100 connections. Must apply exactly once.
  await reset();
  await setStripe([subscription('sub_dup', 'price_a')]);
  const dup = sign(event(`evt_dup_${mode}`, 'customer.subscription.updated', 'sub_dup'));
  await run('A_duplicate_storm', { body: dup.payload, headers: dup.headers }, []);

  // B) Hot row: distinct events, all for ONE subscription, Stripe state changing during the run.
  await reset();
  let price = 0;
  await setStripe([subscription('sub_hot', 'price_0')]);
  let seqB = 0;
  const subsB = await run('B_hot_subscription', {
    requests: [{ setupRequest: (req) => {
      if (++seqB % 200 === 0) setStripe([subscription('sub_hot', `price_${++price}`)]);
      const { payload, headers } = sign(event(`evt_b_${mode}_${seqB}`, 'customer.subscription.updated', 'sub_hot'));
      return { ...req, method: 'POST', body: payload, headers };
    } }],
  }, ['sub_hot'], () => setStripe([subscription('sub_hot', 'price_final')]));
  results.at(-1).finalRowMatchesStripe = subsB[0]?.price_id === 'price_final';

  // C) Spread: distinct events over 50 subscriptions.
  await reset();
  const ids = Array.from({ length: 50 }, (_, i) => `sub_${i}`);
  await setStripe(ids.map((id) => subscription(id, 'price_a')));
  let seqC = 0;
  const subsC = await run('C_spread_50_subscriptions', {
    requests: [{ setupRequest: (req) => {
      const id = ids[seqC % ids.length];
      const { payload, headers } = sign(event(`evt_c_${mode}_${++seqC}`, 'customer.subscription.updated', id));
      return { ...req, method: 'POST', body: payload, headers };
    } }],
  }, ids, () => setStripe(ids.map((id) => subscription(id, 'price_final'))));
  results.at(-1).finalRowsMatchStripe = subsC.length === 50 && subsC.every((s) => s.price_id === 'price_final');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = netServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
