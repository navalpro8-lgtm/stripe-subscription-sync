// Next.js App Router route handler (a web-standard Request → Response function, so it does not
// import Next.js). Use it from a route that runs on the Node.js runtime:
//
//   export const runtime = 'nodejs';
//   export const POST = createNextWebhookHandler({ stripe, webhookSecret, sync });
import { processEvent, structuredLog } from '../core/process-event.js';
import { resolveOptions } from '../config/options.js';
import { errorMessage } from '../core/redact.js';
import type { StripeEventLike, SyncDeps } from '../core/types.js';

/** The part of the Stripe SDK used here: signature verification. */
export interface WebhookVerifier {
  webhooks: { constructEvent(payload: string, header: string, secret: string): unknown };
}

/** Default request body limit: 1 MiB. Stripe does not document a maximum event size. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export interface NextWebhookOptions {
  stripe: WebhookVerifier;
  /**
   * The endpoint's signing secret (whsec_...). One secret is enough to rotate: when you roll it
   * in Stripe with a delay, Stripe signs each event with every active secret until the old one
   * expires (see README "Rotating the webhook secret").
   */
  webhookSecret: string;
  sync: SyncDeps;
  /** Larger bodies get 413 before signature verification; nothing is read past the limit. */
  maxBodyBytes?: number;
}

export function createNextWebhookHandler({ stripe, webhookSecret, sync, maxBodyBytes = DEFAULT_MAX_BODY_BYTES }: NextWebhookOptions) {
  if (typeof webhookSecret !== 'string' || webhookSecret === '') throw new Error('createNextWebhookHandler: webhookSecret is required');
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) throw new Error('createNextWebhookHandler: maxBodyBytes must be a positive integer');
  resolveOptions(sync); // fail at startup on an invalid option or unknown event name

  return async function POST(req: Request): Promise<Response> {
    const signature = req.headers.get('stripe-signature');
    if (!signature) return reply(400, 'missing_signature');

    // Verify against the raw body exactly as received. Parsing first would break the signature.
    const rawBody = await readBody(req, maxBodyBytes);
    if (rawBody === null) return reply(413, 'body_too_large');
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
      // A database error (the store threw). Stripe will redeliver.
      structuredLog(sync.logger, globalThis.crypto.randomUUID()).error('stripe_sync.webhook_error', {
        eventId: event.id, eventType: event.type, error: errorMessage(err),
      });
      return reply(500, 'error');
    }
  };
}

/** The body as text, or null if it is larger than `max` bytes (checked before and while reading). */
async function readBody(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return '';

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function reply(status: number, outcome: string): Response {
  return Response.json({ outcome }, { status });
}
