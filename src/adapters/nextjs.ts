// Next.js App Router route handler (a web-standard Request → Response function, so it does not
// import Next.js). Use it from a route that runs on the Node.js runtime:
//
//   export const runtime = 'nodejs';
//   export const POST = createNextWebhookHandler({ stripe, webhookSecret, sync });
import { processEvent } from '../core/process-event.js';
import { resolveOptions } from '../config/options.js';
import type { StripeEventLike, SyncDeps } from '../core/types.js';

/** The part of the Stripe SDK used here: signature verification. */
export interface WebhookVerifier {
  webhooks: { constructEvent(payload: string, header: string, secret: string): unknown };
}

export interface NextWebhookOptions {
  stripe: WebhookVerifier;
  webhookSecret: string;
  sync: SyncDeps;
}

export function createNextWebhookHandler({ stripe, webhookSecret, sync }: NextWebhookOptions) {
  if (!webhookSecret) throw new Error('createNextWebhookHandler: webhookSecret is required');
  resolveOptions(sync); // fail at startup on an invalid option or unknown event name

  return async function POST(req: Request): Promise<Response> {
    const signature = req.headers.get('stripe-signature');
    if (!signature) return reply(400, 'missing_signature');

    // Verify against the raw body exactly as received. Parsing first would break the signature.
    const rawBody = await req.text();
    let event: StripeEventLike;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret) as StripeEventLike;
    } catch {
      return reply(400, 'bad_signature');
    }

    try {
      const result = await processEvent(event, sync);
      return reply(result.httpStatus, result.outcome);
    } catch (err) {
      sync.logger?.error?.('webhook processing error', { eventId: event.id, error: err instanceof Error ? err.message : String(err) });
      return reply(500, 'error');
    }
  };
}

function reply(status: number, outcome: string): Response {
  return Response.json({ outcome }, { status });
}
