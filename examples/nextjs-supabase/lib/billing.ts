// Wiring for this example: Stripe SDK + server-side Supabase client + the sync module.
// Everything is created on first use, so `next build` does not need the secrets.
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import {
  createNextWebhookHandler,
  fromStripeSdk,
  getEntitlement,
  supabaseStore,
  type SyncStore,
} from 'stripe-subscription-sync';

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

/** STRIPE_LIVEMODE must be "true" or "false" and match the key: the module refuses the other mode. */
function livemode(): boolean {
  const value = env('STRIPE_LIVEMODE');
  if (value !== 'true' && value !== 'false') throw new Error('STRIPE_LIVEMODE must be "true" or "false"');
  const keyIsLive = /^(sk|rk)_live_/.test(env('STRIPE_SECRET_KEY'));
  if ((value === 'true') !== keyIsLive) {
    throw new Error('STRIPE_LIVEMODE does not match STRIPE_SECRET_KEY');
  }
  return value === 'true';
}

let cached: { stripe: Stripe; store: SyncStore; handler: (req: Request) => Promise<Response> } | undefined;

function billing() {
  if (!cached) {
    const stripe = new Stripe(env('STRIPE_SECRET_KEY'));
    // Service-role client: server only. Only service_role may call the sync functions.
    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const store = supabaseStore(supabase);
    const handler = createNextWebhookHandler({
      stripe,
      webhookSecret: env('STRIPE_WEBHOOK_SECRET'),
      sync: { livemode: livemode(), store, stripe: fromStripeSdk(stripe), logger: console },
    });
    cached = { stripe, store, handler };
  }
  return cached;
}

export function handleStripeWebhook(req: Request): Promise<Response> {
  return billing().handler(req);
}

/** Call with the user id from YOUR authentication (e.g. supabase.auth.getUser() on the server). */
export function entitlementFor(userId: string) {
  return getEntitlement(billing().store, userId);
}
