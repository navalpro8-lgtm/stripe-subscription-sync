// Wires the real Next.js route handler to a real Postgres connection and a FakeStripe, and sends
// it requests signed with the real Stripe SDK. Tests assert database state through `db`.
import pg from 'pg';
import Stripe from 'stripe';
import { afterAll, beforeAll, beforeEach, inject } from 'vitest';
import {
  createNextWebhookHandler,
  postgresStore,
  supabaseStore,
  type ImplementedEvent,
  type SyncStore,
  type UserResolver,
} from '../../src/index.js';
import { FakeStripe } from './fake-stripe.js';

export const WEBHOOK_SECRET = 'whsec_synthetic_test_secret';
// Used only for signing and constructEvent; it never makes a network request.
export const stripeSdk = new Stripe('sk_test_synthetic_never_used');

export type AdapterName = 'postgres' | 'supabase';
export const ADAPTERS: AdapterName[] = ['postgres', 'supabase'];

export async function connect(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: inject('databaseUrl') });
  await client.connect();
  return client;
}

export async function truncateAll(client: pg.Client): Promise<void> {
  await client.query('truncate public.stripe_events, public.stripe_customer_links, public.stripe_subscriptions');
}

/** Two separate connections (two "workers") and a fresh FakeStripe per test, on an empty DB. */
export function setupSuite() {
  const ctx = {} as { a: pg.Client; b: pg.Client; fake: FakeStripe };
  beforeAll(async () => {
    ctx.a = await connect();
    ctx.b = await connect();
  });
  beforeEach(async () => {
    await truncateAll(ctx.a);
    ctx.fake = new FakeStripe();
  });
  afterAll(async () => {
    await ctx.a?.end();
    await ctx.b?.end();
  });
  return ctx;
}

/** A promise gate a store wrapper can wait on. */
export function gate() {
  let markReached!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => (markReached = r));
  const released = new Promise<void>((r) => (release = r));
  return { reached, release, async pass() { markReached(); await released; } };
}

/** Supabase-shaped client whose rpc() forwards to Postgres. Checks argument names and result
 *  parsing of the supabase adapter; it is not supabase-js and not PostgREST. */
export function rpcStub(client: pg.Client) {
  return {
    async rpc(fn: string, args: Record<string, unknown>) {
      const keys = Object.keys(args);
      const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as result`;
      try {
        const res = await client.query(sql, keys.map((k) => args[k]));
        return { data: res.rows[0]?.result ?? null, error: null };
      } catch (err) {
        return { data: null, error: { message: (err as Error).message } };
      }
    },
  };
}

export function storeFor(adapter: AdapterName, client: pg.Client): SyncStore {
  return adapter === 'postgres' ? postgresStore(client) : supabaseStore(rpcStub(client));
}

export interface WorkerOptions {
  adapter: AdapterName;
  client: pg.Client;
  fake: FakeStripe;
  users?: UserResolver;
  enabledEvents?: readonly ImplementedEvent[];
  wrapStore?: (store: SyncStore) => SyncStore;
  readOrderShortcut?: boolean;
  /** Default false: the harness serves test mode, like the builders' events. */
  livemode?: boolean;
  claimTimeoutSeconds?: number;
}

/** One "worker": a route handler with its own DB connection. */
export function worker(o: WorkerOptions) {
  const store = (o.wrapStore ?? ((s) => s))(storeFor(o.adapter, o.client));
  const handler = createNextWebhookHandler({
    stripe: stripeSdk,
    webhookSecret: WEBHOOK_SECRET,
    sync: {
      livemode: o.livemode ?? false,
      store,
      stripe: o.fake,
      users: o.users,
      enabledEvents: o.enabledEvents,
      readOrderShortcut: o.readOrderShortcut,
      claimTimeoutSeconds: o.claimTimeoutSeconds,
    },
  });
  return {
    store,
    async deliver(evt: object, sign: { secret?: string; tamper?: boolean; omitHeader?: boolean } = {}) {
      const payload = JSON.stringify(evt);
      const header = stripeSdk.webhooks.generateTestHeaderString({ payload, secret: sign.secret ?? WEBHOOK_SECRET });
      const body = sign.tamper ? payload.replace('"type"', '"type" ') : payload;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (!sign.omitHeader) headers['stripe-signature'] = header;
      const res = await handler(new Request('http://localhost/api/stripe/webhook', { method: 'POST', headers, body }));
      return { status: res.status, body: (await res.json()) as { outcome: string } };
    },
  };
}

// ---- database reads used in assertions

export async function subscriptionRow(client: pg.Client, id = 'sub_1') {
  const res = await client.query('select * from public.stripe_subscriptions where subscription_id = $1', [id]);
  return res.rows[0] as Record<string, unknown> | undefined;
}

export async function eventRow(client: pg.Client, id: string) {
  const res = await client.query('select * from public.stripe_events where event_id = $1', [id]);
  return res.rows[0] as Record<string, unknown> | undefined;
}

export async function count(client: pg.Client, table: string): Promise<number> {
  const res = await client.query(`select count(*)::int as n from public.${table}`);
  return res.rows[0].n as number;
}

export async function linkCustomer(client: pg.Client, customerId: string, userId: string, livemode = false): Promise<void> {
  await client.query(
    `insert into public.stripe_customer_links (stripe_customer_id, user_id, livemode, linked_by_event) values ($1, $2, $3, 'test-setup')`,
    [customerId, userId, livemode],
  );
}

/** Makes a claim look `seconds` old (default 10 minutes: past the default 120 s threshold). */
export async function ageClaim(client: pg.Client, eventId: string, seconds = 600): Promise<void> {
  await client.query(`update public.stripe_events set claimed_at = now() - make_interval(secs => $2) where event_id = $1`, [eventId, seconds]);
}
