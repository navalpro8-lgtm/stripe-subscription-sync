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
      sync: { store, stripe: fromStripeSdk(stripe), logger: console },
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
