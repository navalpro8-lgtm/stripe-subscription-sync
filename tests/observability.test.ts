// Structured, redacted logs; sql/health.sql; and the body-size limit at the route boundary.
import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { createNextWebhookHandler, DEFAULT_MAX_BODY_BYTES, reconcileSubscription, redact, type Logger } from '../src/index.js';
import { checkoutSession, event, subscription, USER_A } from './support/builders.js';
import {
  ADAPTERS, ageClaim, count, linkCustomer, setupSuite, storeFor, stripeSdk, syncDeps, WEBHOOK_SECRET, worker,
  type WorkerOptions,
} from './support/harness.js';

// Canary strings: none of them may ever appear in a log line or in last_error.
const CANARY_KEY = 'sk_live_CANARYkey1234567890';
const CANARY_SECRET = 'whsec_CANARYsecret1234567890';
const CANARY_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.Y2FuYXJ5c2lnbmF0dXJl';
const CANARY_EMAIL = 'canary.person@example.com';
const CANARIES = [CANARY_KEY, CANARY_SECRET, CANARY_JWT, CANARY_EMAIL, 'CANARYkey', 'CANARYsecret', 'canary.person'];
const ALL = `${CANARY_KEY} ${CANARY_SECRET} ${CANARY_JWT} ${CANARY_EMAIL}`;

function capture() {
  const lines: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
  const logger: Logger = {
    info: (message, fields) => lines.push({ level: 'info', message, fields }),
    warn: (message, fields) => lines.push({ level: 'warn', message, fields }),
    error: (message, fields) => lines.push({ level: 'error', message, fields }),
  };
  return { logger, lines };
}

describe.each(ADAPTERS)('logging and redaction (%s adapter)', (adapter) => {
  const ctx = setupSuite();
  const opts = (o: Partial<WorkerOptions> = {}): WorkerOptions => ({ adapter, client: ctx.a, fake: ctx.fake, ...o });

  test('canaries_never_reach_logs_or_last_error', async () => {
    const { logger, lines } = capture();
    const w = worker(opts({ logger }));
    await linkCustomer(ctx.a, 'cus_1', USER_A);

    // 1. A Stripe SDK error whose message echoes secrets.
    ctx.fake.set(subscription());
    ctx.fake.failNextRetrieve = new Error(`Invalid API Key provided: ${CANARY_KEY}; contact ${CANARY_EMAIL} ${CANARY_JWT} ${CANARY_SECRET}`);
    expect((await w.deliver(event('customer.subscription.updated', { id: 'sub_1', metadata: { note: ALL } }))).status).toBe(500);

    // 2. An object id that contains secrets (it is echoed in error messages).
    const weirdId = `sub_${CANARY_KEY}_${CANARY_EMAIL}`;
    ctx.fake.set(subscription({ id: weirdId, omit: ['status'] }));
    expect((await w.deliver(event('customer.subscription.updated', { id: weirdId }))).status).toBe(500);

    // 3. A checkout session with secrets in client-controlled fields.
    const session = { ...checkoutSession({ clientReferenceId: CANARY_EMAIL }), customer_email: CANARY_EMAIL, metadata: { k: ALL } };
    expect((await w.deliver(event('checkout.session.completed', session))).status).toBe(500);

    // 4. A database error whose message contains secrets (the store throws).
    const broken = worker(opts({ logger, wrapStore: (s) => ({ ...s, claimEvent: async () => { throw new Error(`connect failed ${ALL}`); } }) }));
    expect((await broken.deliver(event('customer.subscription.updated', { id: 'sub_1' }))).status).toBe(500);

    // 5. A reconcile failure echoing secrets.
    ctx.fake.failNextRetrieve = new Error(`upstream said ${ALL}`);
    expect(await reconcileSubscription('sub_1', syncDeps(opts({ logger })))).toMatchObject({ outcome: 'failed', reason: 'error' });

    const logged = JSON.stringify(lines);
    const stored = JSON.stringify((await ctx.a.query('select last_error from public.stripe_events')).rows);
    for (const canary of CANARIES) {
      expect(logged).not.toContain(canary);
      expect(stored).not.toContain(canary);
    }
    expect(logged).toContain('[redacted:stripe_key]');
    expect(stored).toContain('[redacted:email]');
  });

  test('every_delivery_logs_one_structured_line', async () => {
    const { logger, lines } = capture();
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription());
    const evt = event('customer.subscription.created', { id: 'sub_1' });
    await worker(opts({ logger })).deliver(evt);
    await worker(opts({ logger })).deliver(evt); // duplicate

    const finals = lines.filter((l) => l.message === 'stripe_sync.event');
    expect(finals).toHaveLength(2);
    expect(finals[0]).toMatchObject({ level: 'info', fields: { event: 'stripe_sync.event', eventId: evt.id, eventType: evt.type, outcome: 'succeeded', httpStatus: 200, attempts: 1 } });
    expect(finals[1]).toMatchObject({ fields: { outcome: 'duplicate', attempts: 0 } });
    const ids = finals.map((l) => l.fields?.correlationId);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[0]).not.toBe(ids[1]); // one correlation id per delivery
  });

  test('failed_event_stores_its_correlation_id', async () => {
    const { logger, lines } = capture();
    ctx.fake.set(subscription({ customer: 'cus_nobody' }));
    const evt = event('customer.subscription.created', { id: 'sub_1' });
    await worker(opts({ logger })).deliver(evt);
    const final = lines.find((l) => l.message === 'stripe_sync.event');
    expect(final).toMatchObject({ level: 'error', fields: { outcome: 'failed', httpStatus: 500 } });
    const stored = (await ctx.a.query('select last_error from public.stripe_events where event_id = $1', [evt.id])).rows[0].last_error;
    expect(stored).toContain(`[correlation ${String(final?.fields?.correlationId)}]`);
  });

  test('health_queries_run', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription({ customer: 'cus_nobody' }));
    await worker(opts()).deliver(event('customer.subscription.created', { id: 'sub_1' })); // failed
    const stuck = event('customer.subscription.updated', { id: 'sub_1' });
    await ctx.a.query(
      `insert into public.stripe_events (event_id, event_type, livemode, status, claimed_by, claimed_at, attempts)
       values ($1, $2, false, 'processing', gen_random_uuid(), now(), 1)`, [stuck.id, stuck.type]);
    await ageClaim(ctx.a, stuck.id, 3600);

    const results = (await ctx.a.query(await readFile('sql/health.sql', 'utf8'))) as unknown as Array<{ rows: Array<Record<string, unknown>> }>;
    expect(results).toHaveLength(7);
    expect(results[0]!.rows.map((r) => r.event_id)).toEqual([stuck.id]);
    expect(results[1]!.rows).toEqual([expect.objectContaining({ event_type: 'customer.subscription.created', failed: '1' })]);
    expect(results[6]!.rows).toContainEqual(expect.objectContaining({ table_name: 'stripe_events', livemode: false, rows: '2' }));
  });
});

describe('redact()', () => {
  test('redacts_keys_secrets_jwts_and_emails', () => {
    expect(redact(`a ${ALL} b`)).toBe('a [redacted:stripe_key] [redacted:webhook_secret] [redacted:jwt] [redacted:email] b');
    expect(redact('sub_rk_test_abc123')).toBe('sub_[redacted:stripe_key]');
    expect(redact('x'.repeat(2000))).toHaveLength(1001);
  });
});

describe.each(ADAPTERS)('body-size limit at the route (%s adapter)', (adapter) => {
  const ctx = setupSuite();

  function signedRequest(evt: object, init: { stream?: boolean } = {}) {
    const payload = JSON.stringify(evt);
    const header = stripeSdk.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    const headers = { 'content-type': 'application/json', 'stripe-signature': header };
    if (!init.stream) return new Request('http://localhost/webhook', { method: 'POST', headers, body: payload });
    // No content-length: the limit must hold while reading.
    const bytes = new TextEncoder().encode(payload);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 256) controller.enqueue(bytes.slice(i, i + 256));
        controller.close();
      },
    });
    return new Request('http://localhost/webhook', { method: 'POST', headers, body, duplex: 'half' } as RequestInit);
  }

  test('oversized_body_gets_413_and_writes_nothing', async () => {
    await linkCustomer(ctx.a, 'cus_1', USER_A);
    ctx.fake.set(subscription());
    const { handler } = worker({ adapter, client: ctx.a, fake: ctx.fake, maxBodyBytes: 2000 });
    const big = event('customer.subscription.updated', { id: 'sub_1', metadata: { pad: 'x'.repeat(3000) } });

    const declared = await handler(signedRequest(big));
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ outcome: 'body_too_large' });

    const req = signedRequest(big, { stream: true });
    expect(req.headers.get('content-length')).toBeNull();
    expect((await handler(req)).status).toBe(413);

    expect(await count(ctx.a, 'stripe_events')).toBe(0);
    expect(ctx.fake.calls).toHaveLength(0);

    // Under the limit (streamed too): processed normally.
    const small = event('customer.subscription.updated', { id: 'sub_1' });
    expect((await handler(signedRequest(small, { stream: true }))).status).toBe(200);
    expect(await count(ctx.a, 'stripe_subscriptions')).toBe(1);
  });

  test('body_limit_is_validated_and_defaults_to_1_mib', () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(1024 * 1024);
    const sync = { livemode: false, store: storeFor(adapter, ctx.a), stripe: ctx.fake };
    for (const bad of [0, -1, 1.5]) {
      expect(() => createNextWebhookHandler({ stripe: stripeSdk, webhookSecret: WEBHOOK_SECRET, sync, maxBodyBytes: bad })).toThrow(/maxBodyBytes/);
    }
  });
});
