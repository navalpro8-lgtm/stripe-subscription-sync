// One OS process acting as one webhook server, for tests/multi-process.test.ts. Uses the BUILT
// module (dist/), a real Postgres pool, and an in-process fake Stripe serving a fixed state.
// Delivers its events in the given order and, like Stripe, redelivers on 409/500 in later passes.
//
// Input (argv[2]): path to a JSON file { databaseUrl, secret, stripeState: {id: subscription}, events: [...] }
// Output (stdout): JSON { outcomes: { [eventId]: string[] } }
import { readFileSync } from 'node:fs';
import pg from 'pg';
import Stripe from 'stripe';
import { createNextWebhookHandler, postgresStore } from '../../dist/index.js';

const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const stripe = new Stripe('sk_test_multi_process_never_used');
const pool = new pg.Pool({ connectionString: input.databaseUrl, max: 4 });
const retriever = {
  async retrieveSubscription(id) {
    await new Promise((r) => setTimeout(r, 2 + Math.random() * 15));
    const s = input.stripeState[id];
    if (!s) throw Object.assign(new Error(`No such subscription: '${id}'`), { statusCode: 404 });
    return structuredClone(s);
  },
};
const handler = createNextWebhookHandler({
  stripe,
  webhookSecret: input.secret,
  sync: { livemode: false, store: postgresStore(pool), stripe: retriever },
});

const outcomes = {};
async function deliver(evt) {
  const payload = JSON.stringify(evt);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: input.secret });
  const res = await handler(new Request('http://localhost/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body: payload,
  }));
  const { outcome } = await res.json();
  (outcomes[evt.id] ??= []).push(outcome);
  return res.status === 200;
}

// Like Stripe: deliver everything, then redeliver what was not acknowledged in later passes
// (independently of other events), until all are 200 or 100 passes have run.
let pending = input.events;
for (let pass = 0; pending.length > 0 && pass < 100; pass++) {
  if (pass > 0) await new Promise((r) => setTimeout(r, 20 + Math.random() * 30));
  const failed = [];
  // Four concurrent deliveries per process.
  await Promise.all(Array.from({ length: 4 }, async (_, lane) => {
    for (let i = lane; i < pending.length; i += 4) if (!(await deliver(pending[i]))) failed.push(pending[i]);
  }));
  pending = failed;
}
await pool.end();
process.stdout.write(JSON.stringify({ outcomes }));
