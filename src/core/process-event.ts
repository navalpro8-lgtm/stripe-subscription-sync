// processEvent(): the whole synchronization algorithm. Design: docs/SYNC_MODEL.md.
//
// Receives an event whose signature the adapter has already verified. Uses the event only to
// learn WHICH subscription (or customer) to look at; subscription state always comes from a
// fresh Stripe read, written with compare-and-swap on the row's revision.
//
// Not configurable on purpose: claims and takeover, the revision check, first-insert handling,
// tombstones, the retry count and the status transitions. See README "What NOT to touch".
import { defaultUserResolver } from '../config/user-mapping.js';
import { resolveEnabledEvents, type ImplementedEvent } from '../config/events.js';
import { ClaimLostError, MappingError, MissingFieldError } from './errors.js';
import type {
  CheckoutSessionLike,
  FinalStatus,
  ProcessResult,
  Snapshot,
  StripeEventLike,
  SyncDeps,
  UserResolver,
} from './types.js';

/** Retries after a revision conflict (so up to 6 attempts in total). */
const MAX_CONFLICT_RETRIES = 5;

/** Stripe statuses a subscription never leaves. A row in one of these is a tombstone. */
const TERMINAL_STATUSES = new Set(['canceled', 'incomplete_expired']);

interface Context {
  event: StripeEventLike;
  token: string;
  deps: SyncDeps;
  users: UserResolver;
}

type Handler = (c: Context) => Promise<'succeeded' | 'skipped'>;

const HANDLERS: Record<ImplementedEvent, Handler> = {
  'customer.subscription.created': (c) => syncSubscription(c, subscriptionIdFromEvent(c.event), false),
  'customer.subscription.updated': (c) => syncSubscription(c, subscriptionIdFromEvent(c.event), false),
  'customer.subscription.deleted': (c) => syncSubscription(c, subscriptionIdFromEvent(c.event), true),
  'invoice.paid': syncFromInvoice,
  'invoice.payment_failed': syncFromInvoice,
  'checkout.session.completed': linkFromCheckout,
};

// ---------------------------------------------------------------- entry point

/**
 * Processes one verified Stripe event and says which HTTP status to answer with:
 * 200 done (or duplicate / ignored / skipped), 409 another worker is processing it, 500 failed
 * (Stripe will redeliver). Database errors are thrown; answer 500 for those too.
 */
export async function processEvent(event: StripeEventLike, deps: SyncDeps): Promise<ProcessResult> {
  const enabled = resolveEnabledEvents(deps.enabledEvents);
  const log = deps.logger ?? {};
  const token = globalThis.crypto.randomUUID();
  const fields = { eventId: event.id, eventType: event.type };

  const claim = await deps.store.claimEvent(event.id, event.type, token);
  if (claim === 'done') return { httpStatus: 200, outcome: 'duplicate' };
  if (claim === 'busy') {
    log.info?.('event is being processed by another worker', fields);
    return { httpStatus: 409, outcome: 'busy' };
  }

  let status: FinalStatus;
  let error: string | null = null;
  try {
    const handler = enabled.has(event.type as ImplementedEvent) ? HANDLERS[event.type as ImplementedEvent] : undefined;
    status = handler ? await handler({ event, token, deps, users: deps.users ?? defaultUserResolver }) : 'ignored';
  } catch (err) {
    if (err instanceof ClaimLostError) {
      log.warn?.(err.message, fields);
      return { httpStatus: 500, outcome: 'claim_lost' };
    }
    status = 'failed';
    error = err instanceof Error ? err.message : String(err);
    log.error?.('event failed; Stripe will retry', { ...fields, error });
  }

  if (!(await deps.store.finishEvent(event.id, token, status, error))) {
    log.warn?.('claim was taken over before the event could be marked', fields);
    return { httpStatus: 500, outcome: 'claim_lost' };
  }
  log.info?.(`event ${status}`, fields);
  return { httpStatus: status === 'failed' ? 500 : 200, outcome: status };
}

// ---------------------------------------------------------------- handlers

/** Compare-and-swap loop. See docs/SYNC_MODEL.md, "Subscription write". */
async function syncSubscription(c: Context, subscriptionId: string, mustBeTerminal: boolean) {
  const { store, stripe, logger } = c.deps;

  for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
    if (attempt > 0) await sleep(10 + Math.random() * 40);

    const read = await store.beginRead(subscriptionId, c.event.id);
    // The stored row came from a Stripe read that started after this event arrived, so it already
    // reflects this event's change: nothing to fetch or write. After a conflict this is usually
    // why. Deletions still insist on seeing a terminal status themselves.
    if (read.superseded && !mustBeTerminal) {
      logger?.info?.('a later Stripe read already covers this event', { subscriptionId, eventId: c.event.id });
      return 'skipped';
    }

    // No transaction is open here: the Stripe call happens between two independent statements.
    const fetched = toSnapshot(await stripe.retrieveSubscription(subscriptionId), subscriptionId);

    if (mustBeTerminal && !TERMINAL_STATUSES.has(fetched.status)) {
      // A deleted event, but Stripe's read does not show it yet. Do not write a live state.
      throw new Error(`Subscription ${subscriptionId} is "${fetched.status}" in Stripe after a deleted event; retry later`);
    }

    const userId = await c.users.userForSubscription({ id: subscriptionId, customerId: fetched.customer_id }, store);
    const snapshot: Snapshot = { ...fetched, user_id: userId, read_seq: read.readSeq };
    const result = await store.applySnapshot(subscriptionId, read.revision, c.token, c.event.id, snapshot);

    switch (result) {
      case 'applied':
        return 'succeeded';
      case 'tombstoned':
        logger?.info?.('subscription is tombstoned; snapshot refused', { subscriptionId, eventId: c.event.id });
        return 'skipped';
      case 'claim_lost':
        throw new ClaimLostError(c.event.id);
      case 'user_mismatch':
        throw new MappingError(`Subscription ${subscriptionId} belongs to another user; refusing to change its owner`);
      case 'conflict':
        logger?.info?.('revision conflict; re-reading', { subscriptionId, attempt });
        continue;
    }
  }
  throw new Error(`Revision conflict on subscription ${subscriptionId}: gave up after ${MAX_CONFLICT_RETRIES} retries`);
}

/** invoice.paid / invoice.payment_failed only trigger a re-fetch of their subscription. */
async function syncFromInvoice(c: Context) {
  const invoice = rec(c.event.data.object);
  const subscriptionId =
    idOf(invoice.subscription) ?? // API versions before 2025-03-31.basil
    idOf(rec(rec(invoice.parent).subscription_details).subscription); // 2025-03-31.basil and later
  if (!subscriptionId) return 'skipped'; // e.g. a one-off invoice
  return syncSubscription(c, subscriptionId, false);
}

/** checkout.session.completed only links the session's customer to the application user. */
async function linkFromCheckout(c: Context) {
  const session = rec(c.event.data.object) as CheckoutSessionLike & { id?: unknown };
  const where = `checkout session ${String(session.id)}`;
  if (session.mode !== 'subscription') return 'skipped';

  const customerId = idOf(session.customer);
  if (!customerId) throw new MissingFieldError('customer', where);
  const userId = c.users.userFromCheckoutSession(session);
  if (!userId) throw new MappingError(`No valid client_reference_id on ${where}`);

  const result = await c.deps.store.linkCustomer(customerId, userId, c.event.id, c.token);
  if (result === 'claim_lost') throw new ClaimLostError(c.event.id);
  if (result === 'mismatch') throw new MappingError(`Customer ${customerId} is already linked to another user; not relinking`);
  return 'succeeded';
}

// ---------------------------------------------------------------- payload mapping
// Extension point 3 (schema mapping): to store another field, add it here, to Snapshot in
// types.ts, and to the table and apply_subscription_snapshot() in sql/schema.sql.

/**
 * Maps a subscription returned by Stripe to what we store. Handles both payload shapes: period
 * fields on each subscription item (2025-03-31.basil and later) or top-level (earlier), and product
 * as an ID string or an expanded object. Every item is kept. Throws rather than writing an
 * incomplete row: MissingFieldError for a missing field, an error if the item list is truncated.
 */
export function toSnapshot(raw: unknown, subscriptionId: string): Omit<Snapshot, 'user_id' | 'read_seq'> {
  const sub = rec(raw);
  const where = `subscription ${subscriptionId}`;
  const need = <T>(value: T | null, field: string): T => {
    if (value === null) throw new MissingFieldError(field, where);
    return value;
  };

  if (need(str(sub.id), 'id') !== subscriptionId) {
    throw new Error(`Stripe returned subscription ${String(sub.id)} when asked for ${subscriptionId}`);
  }
  const list = rec(sub.items);
  if (list.has_more === true) {
    throw new Error(`Stripe returned an incomplete item list (has_more) for ${where}; refusing a partial write`);
  }
  const rawItems = Array.isArray(list.data) ? (list.data as unknown[]) : [];
  if (rawItems.length === 0) throw new MissingFieldError('items.data[0]', where);

  const items = rawItems.map((raw, i) => {
    const item = rec(raw);
    const price = rec(item.price);
    const plan = rec(item.plan); // legacy item shape
    const field = `items.data[${i}]`;
    return {
      id: need(str(item.id), `${field}.id`),
      price_id: need(str(price.id) ?? str(plan.id), `${field}.price.id`),
      product_id: need(idOf(price.product) ?? idOf(plan.product), `${field}.price.product`),
      quantity: num(item.quantity),
      current_period_start: need(num(item.current_period_start) ?? num(sub.current_period_start), `${field}.current_period_start`),
      current_period_end: need(num(item.current_period_end) ?? num(sub.current_period_end), `${field}.current_period_end`),
    };
  });
  const first = items[0]!;

  return {
    customer_id: need(idOf(sub.customer), 'customer'),
    status: need(str(sub.status), 'status'),
    price_id: first.price_id,
    product_id: first.product_id,
    quantity: first.quantity,
    current_period_start: first.current_period_start,
    current_period_end: first.current_period_end,
    items,
    cancel_at_period_end: need(typeof sub.cancel_at_period_end === 'boolean' ? sub.cancel_at_period_end : null, 'cancel_at_period_end'),
    cancel_at: num(sub.cancel_at),
    canceled_at: num(sub.canceled_at),
    ended_at: num(sub.ended_at),
    trial_end: num(sub.trial_end),
  };
}

// ---------------------------------------------------------------- small helpers

function rec(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** An ID string, or the `id` of an expanded object. */
function idOf(value: unknown): string | null {
  return str(value) ?? str(rec(value).id);
}

function subscriptionIdFromEvent(event: StripeEventLike): string {
  const id = idOf(event.data.object);
  if (!id) throw new MissingFieldError('data.object.id', `event ${event.id}`);
  return id;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
