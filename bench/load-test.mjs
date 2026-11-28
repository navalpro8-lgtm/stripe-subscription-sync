// Local load test: 100 concurrent connections for 10 s against the webhook handler.
// SYNTHETIC: it measures this module against a fake Stripe on one machine. It says nothing about
// real Stripe latency, real Stripe read freshness, your host or your database.
// Every scenario runs twice: read-order shortcut off (the default) and on.
// Everything is local: a throwaway embedded Postgres, a fake Stripe (20–80 ms per retrieve), and
// events signed with a local test secret. No Stripe or Supabase account is touched.
//
//   npm run build && npm i --no-save autocannon@8.0.0 && node bench/load-test.mjs
//   node bench/load-test.mjs --lock-comparison-only    # only scenario D below
//
// Scenario D compares two ways to handle one hot subscription while 50 others also get events:
//   - cas: the library as shipped (compare-and-swap on revision, retry on conflict);
//   - advisory_lock: THIS SCRIPT ONLY, not in the library. Each request takes a per-subscription
//     pg_advisory_lock on a pool connection, holds it across the whole event (Stripe fetch
//     included), and runs the event on that same connection.
// Idea for the comparison: Sunnatulla, dev.to.
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
  let inflight = 0;
  const retriever = {
    async retrieveSubscription(id) {
      const s = structuredClone(state.get(id));
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 60));
      if (!s) throw new Error(`no such subscription ${id}`);
      return s;
    },
  };
  const sync = (store) => ({ livemode: false, store, stripe: retriever, readOrderShortcut: process.env.READ_ORDER_SHORTCUT === '1' });
  const casHandler = createNextWebhookHandler({ stripe, webhookSecret: SECRET, sync: sync(postgresStore(pool)) });
  // Lock variant (bench only). The subscription id is read from the unverified body to pick the
  // lock key; the handler still verifies the signature before doing anything else.
  const lockHandler = async (request, body) => {
    const id = String(JSON.parse(body)?.data?.object?.id ?? '');
    const conn = await pool.connect(); // a waiter holds this connection while it waits
    try {
      await conn.query('select pg_advisory_lock(hashtextextended($1, 0))', [id]);
      try {
        return await createNextWebhookHandler({ stripe, webhookSecret: SECRET, sync: sync(postgresStore(conn)) })(request);
      } finally {
        await conn.query('select pg_advisory_unlock(hashtextextended($1, 0))', [id]);
      }
    } finally {
      conn.release();
    }
  };
  const handler = process.env.LOCK_VARIANT === '1' ? lockHandler : casHandler;

  http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      if (req.url === '/inflight') { // test control: webhook requests still being handled
        res.end(String(inflight));
        return;
      }
      if (req.url === '/stripe-state') { // test control: set Stripe-side state
        for (const s of JSON.parse(body)) state.set(s.id, s);
        res.end('ok');
        return;
      }
      const headers = { 'content-type': 'application/json' };
      if (req.headers['stripe-signature']) headers['stripe-signature'] = req.headers['stripe-signature'];
      inflight++;
      try {
        const r = await handler(new Request('http://localhost/webhook', { method: 'POST', headers, body }), body);
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(await r.text());
      } finally {
        inflight--;
      }
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

  const withServer = async (env, fn) => {
    const server = fork(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), ['--server'], {
      env: { ...process.env, DATABASE_URL: url, PORT: String(appPort), ...env },
    });
    await new Promise((r) => server.once('message', r));
    await fn(`http://127.0.0.1:${appPort}`);
    server.kill();
    await new Promise((r) => server.once('exit', r));
  };

  const results = [];
  if (!process.argv.includes('--lock-comparison-only')) {
    for (const shortcut of [false, true]) {
      await withServer({ READ_ORDER_SHORTCUT: shortcut ? '1' : '0', LOCK_VARIANT: '0' }, (base) =>
        scenarios(base, client, shortcut ? 'shortcut_on' : 'shortcut_off', results));
    }
  }
  // Scenario D: same setup for both variants, shortcut off.
  for (const variant of ['cas', 'advisory_lock']) {
    await withServer({ READ_ORDER_SHORTCUT: '0', LOCK_VARIANT: variant === 'advisory_lock' ? '1' : '0' }, (base) =>
      lockComparison(base, client, variant, results));
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
    // Requests still in flight when autocannon stops keep running server-side. Wait (up to 30 s)
    // until the server has finished them, so they cannot leak into the settle step or the next
    // scenario. Anything still 'processing' afterwards is reported as stuck.
    const drainMs = await waitIdle(base);
    if (mutate) await mutate();
    const settle = [];
    for (const id of subIds) {
      const { payload, headers } = sign(event(`evt_settle_${mode}_${name}_${id}`, 'customer.subscription.updated', id));
      settle.push((await (await fetch(`${base}/webhook`, { method: 'POST', headers, body: payload })).json()).outcome);
    }
    await waitIdle(base);
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
      drainMs,
      settleOutcomes: Object.fromEntries([...new Set(settle)].map((o) => [o, settle.filter((x) => x === o).length])),
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
  const pendingB = [];
  const subsB = await run('B_hot_subscription', {
    requests: [{ setupRequest: (req) => {
      // Not awaited (setupRequest is synchronous); collected so the settle step can wait for them.
      if (++seqB % 200 === 0) pendingB.push(setStripe([subscription('sub_hot', `price_${++price}`)]));
      const { payload, headers } = sign(event(`evt_b_${mode}_${seqB}`, 'customer.subscription.updated', 'sub_hot'));
      return { ...req, method: 'POST', body: payload, headers };
    } }],
  }, ['sub_hot'], async () => {
    await Promise.all(pendingB); // a late state change must not land after price_final
    await setStripe([subscription('sub_hot', 'price_final')]);
  });
  results.at(-1).finalRowMatchesStripe = subsB.length === 1 && subsB[0].price_id === 'price_final';

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

// D) One hot subscription (100 connections) and 50 other subscriptions (50 connections), at the
// same time, 10 s, pool of 20, fake Stripe 20–80 ms. Run once per variant (see the header).
// "totalMs" is from the start of the load until the server has finished every request.
async function lockComparison(base, client, variant, results) {
  const { default: autocannon } = await import('autocannon');
  const setStripe = (subs) => fetch(`${base}/stripe-state`, { method: 'POST', body: JSON.stringify(subs) });
  const sign = (evt) => {
    const payload = JSON.stringify(evt);
    return { payload, headers: { 'content-type': 'application/json', 'stripe-signature': stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET }) } };
  };
  const event = (id, objectId) => ({ id, object: 'event', type: 'customer.subscription.updated', created: T0, livemode: false, data: { object: { id: objectId } } });
  const post = (id, objectId) => (req) => {
    const { payload, headers } = sign(event(id, objectId));
    return { ...req, method: 'POST', body: payload, headers };
  };

  await client.query('truncate stripe_events, stripe_customer_links, stripe_subscriptions');
  await client.query(`insert into stripe_customer_links (stripe_customer_id, user_id, livemode, linked_by_event) values ($1, $2, false, 'load-setup')`, [CUSTOMER, USER]);
  const others = Array.from({ length: 50 }, (_, i) => `sub_other_${i}`);
  await setStripe([subscription('sub_hot', 'price_0'), ...others.map((id) => subscription(id, 'price_a'))]);

  let seqHot = 0;
  let seqOther = 0;
  let price = 0;
  const pending = [];
  const started = Date.now();
  const [hot, other] = await Promise.all([
    autocannon({ url: `${base}/webhook`, connections: 100, duration: 10, requests: [{ setupRequest: (req) => {
      if (++seqHot % 200 === 0) pending.push(setStripe([subscription('sub_hot', `price_${++price}`)]));
      return post(`evt_hot_${variant}_${seqHot}`, 'sub_hot')(req);
    } }] }),
    autocannon({ url: `${base}/webhook`, connections: 50, duration: 10, requests: [{ setupRequest: (req) => {
      const id = others[seqOther % others.length];
      return post(`evt_other_${variant}_${++seqOther}`, id)(req);
    } }] }),
  ]);
  const drainMs = await waitIdle(base, 600_000);
  const totalMs = Date.now() - started;

  // Settle as in A–C: one more serial event per subscription; each row must end at Stripe's state.
  await Promise.all(pending);
  await setStripe([subscription('sub_hot', 'price_final'), ...others.map((id) => subscription(id, 'price_final'))]);
  for (const id of ['sub_hot', ...others]) {
    const { payload, headers } = sign(event(`evt_settle_${variant}_${id}`, id));
    await fetch(`${base}/webhook`, { method: 'POST', headers, body: payload });
  }
  await waitIdle(base);

  const byStatus = async (prefix) => Object.fromEntries((await client.query(
    `select status, count(*)::int n from stripe_events where starts_with(event_id, $1) group by 1 order by 1`, [prefix])).rows.map((r) => [r.status, r.n]));
  const subs = (await client.query(`select subscription_id, price_id, revision from stripe_subscriptions order by 1`)).rows;
  const succeededSubEvents = (await client.query(
    `select count(*)::int n from stripe_events where status = 'succeeded' and event_type like 'customer.subscription.%'`)).rows[0].n;
  const sumRevisions = subs.reduce((a, s) => a + s.revision, 0);
  const codes = (r) => Object.fromEntries(Object.entries(r.statusCodeStats ?? {}).map(([k, v]) => [k, v.count]));
  const hotEvents = await byStatus(`evt_hot_${variant}_`);
  const otherEvents = await byStatus(`evt_other_${variant}_`);
  results.push({
    mode: variant,
    scenario: 'D_hot_plus_50_others',
    totalMs,
    drainMs,
    hot: { requests: hot.requests.total, statusCodes: codes(hot), timeouts: hot.timeouts, latencyMs: { p50: hot.latency.p50, p99: hot.latency.p99 }, events: hotEvents,
      failed: hotEvents.failed ?? 0 },
    others: { requests: other.requests.total, statusCodes: codes(other), timeouts: other.timeouts, latencyMs: { p50: other.latency.p50, p99: other.latency.p99 }, events: otherEvents,
      writesCompleted: otherEvents.succeeded ?? 0 },
    invariant_oneWritePerSucceededEvent: { succeededSubEvents, sumRevisions, ok: succeededSubEvents === sumRevisions },
    stuckProcessing: (await client.query(`select count(*)::int n from stripe_events where status = 'processing'`)).rows[0].n,
    finalRowsMatchStripe: subs.length === 51 && subs.every((s) => s.price_id === 'price_final'),
  });
}

async function waitIdle(base, limitMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < limitMs) {
    if ((await (await fetch(`${base}/inflight`)).text()) === '0') return Date.now() - start;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server still busy after ${limitMs / 1000} s`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = netServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
