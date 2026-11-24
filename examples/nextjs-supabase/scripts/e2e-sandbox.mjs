// Manual end-to-end harness for a Stripe SANDBOX and a throwaway Supabase project.
//
// Starts the built example app (`next start`) and `stripe listen` forwarding to it, then serves a
// small control API on 127.0.0.1:3999 so a test driver can make Stripe API calls, re-deliver an
// event, and read a user's entitlement. Keys are read from .env.local and never printed.
//
//   npm run build && node scripts/e2e-sandbox.mjs        (needs the Stripe CLI on PATH, or STRIPE_BIN)
//
// Control API (127.0.0.1 only):
//   POST /api        {"method":"POST","path":"/v1/customers","params":{...}}  -> Stripe response
//   POST /redeliver  {"eventId":"evt_..."}  -> re-sends that event, signed, to the app
//   GET  /entitlement?user=<id>             -> getEntitlement() with the example policy
//   POST /stop                              -> stops everything
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { getEntitlement, supabaseStore } from 'stripe-subscription-sync';

const root = path.resolve(import.meta.dirname, '..');
const logDir = path.join(root, 'scripts', '.e2e');
mkdirSync(logDir, { recursive: true });

const env = Object.fromEntries(
  readFileSync(path.join(root, '.env.local'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const die = (msg) => { console.error(msg); process.exit(1); };
if (!env.STRIPE_SECRET_KEY?.startsWith('sk_test_')) die('STRIPE_SECRET_KEY must be a sandbox key starting with sk_test_.');
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) die('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');

const STRIPE_BIN = process.env.STRIPE_BIN ?? 'stripe';
const EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
];
const APP = 'http://localhost:3000/api/stripe/webhook';

const stripe = new Stripe(env.STRIPE_SECRET_KEY);
const store = supabaseStore(
  createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }),
);

// The signing secret `stripe listen` will use; kept in this process only.
const webhookSecret = execFileSync(STRIPE_BIN, ['listen', '--api-key', env.STRIPE_SECRET_KEY, '--print-secret'], { encoding: 'utf8' }).trim();
if (!webhookSecret.startsWith('whsec_')) die('Could not get a webhook signing secret from `stripe listen --print-secret`.');

const children = [];
const start = (name, cmd, args, extraEnv = {}) => {
  const log = createWriteStream(path.join(logDir, `${name}.log`), { flags: 'w' });
  const child = spawn(cmd, args, { cwd: root, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.on('exit', (code) => console.log(`${name} exited (${code})`));
  children.push(child);
};

start('app', process.execPath, [path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', '3000'], {
  STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: webhookSecret,
  STRIPE_LIVEMODE: 'false', // sk_test_ only (checked above)
  SUPABASE_URL: env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
});
start('listen', STRIPE_BIN, ['listen', '--api-key', env.STRIPE_SECRET_KEY, '--forward-to', APP, '--events', EVENTS.join(',')]);

const body = (req) => new Promise((resolve) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => resolve(data ? JSON.parse(data) : {}));
});

http
  .createServer(async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value, null, 2));
    };
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname === '/api') {
        const { method, path: apiPath, params } = await body(req);
        const r = await stripe.rawRequest(method, apiPath, params ?? {});
        return send(200, r);
      }
      if (req.method === 'POST' && url.pathname === '/redeliver') {
        const { eventId } = await body(req);
        const evt = await stripe.events.retrieve(eventId);
        const payload = JSON.stringify(evt);
        const header = stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
        const r = await fetch(APP, { method: 'POST', headers: { 'stripe-signature': header, 'content-type': 'application/json' }, body: payload });
        return send(200, { status: r.status, body: await r.json() });
      }
      if (req.method === 'GET' && url.pathname === '/entitlement') {
        return send(200, { entitlement: await getEntitlement(store, url.searchParams.get('user') ?? '') });
      }
      if (req.method === 'POST' && url.pathname === '/stop') {
        send(200, { stopping: true });
        for (const c of children) c.kill();
        setTimeout(() => process.exit(0), 500);
        return;
      }
      send(404, { error: 'unknown route' });
    } catch (err) {
      send(500, { error: err instanceof Error ? err.message : String(err) });
    }
  })
  .listen(3999, '127.0.0.1', () => console.log('control API on http://127.0.0.1:3999; logs in scripts/.e2e/'));
