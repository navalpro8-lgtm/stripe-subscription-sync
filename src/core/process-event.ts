// processEvent(): the whole synchronization algorithm. Design: docs/SYNC_MODEL.md.
//
// Receives an event whose signature the adapter has already verified. Uses the event only to
// learn WHICH subscription (or customer) to look at; subscription state always comes from a
// fresh Stripe read, written with compare-and-swap on the row's revision.
//
// Not configurable on purpose: claims and takeover, the revision check, first-insert handling,
// tombstones, the retry count and the status transitions. See README "What NOT to touch".
import { defaultUserResolver } from '../config/user-mapping.js';
import type { ImplementedEvent } from '../config/events.js';
import { resolveOptions, type ResolvedOptions } from '../config/options.js';
import {
  ClaimLostError,
  ConflictRetriesExhaustedError,
  MappingError,
  StaleReadError,
  MissingFieldError,
  ModeMismatchError,
  OwnerMismatchError,
} from './errors.js';
import { errorMessage, redactFields } from './redact.js';
import type {
  CheckoutSessionLike,
  SubscriptionRetriever,
  FinalStatus,
  Logger,
  ProcessResult,
  Snapshot,
  StoredSubscription,
  StripeEventLike,
  SyncDeps,
  UserResolver,
} from './types.js';

/** Retries after a revision conflict or a stale read (so up to 9 attempts in total). */
const MAX_CONFLICT_RETRIES = 8;
/** Exponential backoff with full jitter between attempts: up to 25, 50, 100, ... ms, capped. */
const BACKOFF_BASE_MS = 25;
const BACKOFF_CAP_MS = 1000;

/**
 * Stale-read guard window. For a customer.subscription.updated event created less than this many
 * seconds ago, a fetch that still shows the event's `previous_attributes` value of a guarded field
 * (while the event itself shows a different value) is treated as a stale read and retried, not
 * written. Older events are not checked: by then the field may legitimately have changed back.
 */
const STALE_GUARD_SECONDS = 60;
const STALE_GUARDED_FIELDS = ['status', 'cancel_at_period_end'] as const;

/** Upper bound on item pages fetched for one subscription read, against a list that never ends. */
const MAX_ITEM_PAGES = 100;

/** Stripe statuses a subscription never leaves. A row in one of these is a tombstone. */
const TERMINAL_STATUSES = new Set(['canceled', 'incomplete_expired']);

/** @internal Shared with reconcile.ts. */
export interface Context {
  event: StripeEventLike;
  token: string;
  deps: SyncDeps;
  options: ResolvedOptions;
  users: UserResolver;
  log: StructuredLog;
  /** Stripe reads (compare-and-swap attempts) made so far in this delivery. */
  attempts: number;
}

/** @internal What one compare-and-swap loop ended with. */
export type SyncOutcome = 'applied' | 'tombstoned' | 'covered' | 'unchanged';

type Handler = (c: Context) => Promise<'succeeded' | 'skipped'>;

const asStatus = (o: SyncOutcome): 'succeeded' | 'skipped' => (o === 'applied' ? 'succeeded' : 'skipped');

const HANDLERS: Record<ImplementedEvent, Handler> = {
  'customer.subscription.created': async (c) => asStatus(await syncSubscription(c, subscriptionIdFromEvent(c.event), { mustBeTerminal: false })),
  'customer.subscription.updated': async (c) => asStatus(await syncSubscription(c, subscriptionIdFromEvent(c.event), { mustBeTerminal: false })),
  'customer.subscription.deleted': async (c) => asStatus(await syncSubscription(c, subscriptionIdFromEvent(c.event), { mustBeTerminal: true })),
  'invoice.paid': syncFromInvoice,
  'invoice.payment_failed': syncFromInvoice,
  'checkout.session.completed': linkFromCheckout,
};

// ---------------------------------------------------------------- structured, redacted logging

/**
 * @internal Every log line goes through here: a stable `event` name plus fields, all string
 * values redacted. Fields are ids, types, outcomes and counts; payloads are never logged.
 */
export interface StructuredLog {
  info(event: string, fields: Record<string, unknown>): void;
  warn(event: string, fields: Record<string, unknown>): void;
  error(event: string, fields: Record<string, unknown>): void;
}

/** @internal */
export function structuredLog(logger: Logger | undefined, correlationId: string): StructuredLog {
  const emit = (level: 'info' | 'warn' | 'error') => (event: string, fields: Record<string, unknown>) =>
    logger?.[level]?.(event, redactFields({ event, correlationId, ...fields }));
  return { info: emit('info'), warn: emit('warn'), error: emit('error') };
}

// ---------------------------------------------------------------- entry point

/**
 * Processes one verified Stripe event and says which HTTP status to answer with:
 * 200 done (or duplicate / ignored / skipped), 400 event from the other Stripe mode, 409 another
 * worker is processing it, 500 failed (Stripe will redeliver). Database errors are thrown; answer
 * 500 for those too.
 */
export async function processEvent(event: StripeEventLike, deps: SyncDeps): Promise<ProcessResult> {
  const options = resolveOptions(deps);
  const correlationId = globalThis.crypto.randomUUID();
  const log = structuredLog(deps.logger, correlationId);
  const token = globalThis.crypto.randomUUID();
  const started = Date.now();
  const fields = { eventId: event.id, eventType: event.type };
  const done = (result: ProcessResult, attempts: number, error?: string): ProcessResult => {
    const line = { ...fields, outcome: result.outcome, httpStatus: result.httpStatus, attempts, durationMs: Date.now() - started, ...(error && { error }) };
    if (result.httpStatus >= 500 || result.httpStatus === 400) log.error('stripe_sync.event', line);
    else log.info('stripe_sync.event', line);
    return result;
  };

  // Mode first: an event from the other Stripe mode means this endpoint is misconfigured. Nothing
  // is recorded; the 400 makes Stripe's retries visible in its Dashboard.
  if (event.livemode !== options.livemode) {
    return done({ httpStatus: 400, outcome: 'livemode_mismatch' }, 0, `event livemode=${String(event.livemode)}, endpoint expects ${options.livemode}`);
  }

  const claim = await deps.store.claimEvent(event.id, event.type, token, options.livemode, options.claimTimeoutSeconds);
  if (claim === 'done') return done({ httpStatus: 200, outcome: 'duplicate' }, 0);
  if (claim === 'busy') return done({ httpStatus: 409, outcome: 'busy' }, 0);

  const c: Context = { event, token, deps, options, users: deps.users ?? defaultUserResolver, log, attempts: 0 };
  let status: FinalStatus;
  let error: string | null = null;
  try {
    const type = event.type as ImplementedEvent;
    const handler = options.enabled.has(type) ? HANDLERS[type] : undefined;
    if (typeof event.account === 'string' && event.account !== '') {
      // Stripe Connect is not supported: record and acknowledge, never fetch with our key.
      status = 'ignored';
      error = 'connect_event_unsupported';
    } else {
      status = handler ? await handler(c) : 'ignored';
    }
  } catch (err) {
    if (err instanceof ClaimLostError) return done({ httpStatus: 500, outcome: 'claim_lost' }, c.attempts);
    status = 'failed';
    error = `${errorMessage(err)} [correlation ${correlationId}]`;
  }

  if (!(await deps.store.finishEvent(event.id, token, status, error))) {
    return done({ httpStatus: 500, outcome: 'claim_lost' }, c.attempts);
  }
  return done({ httpStatus: status === 'failed' ? 500 : 200, outcome: status }, c.attempts, error ?? undefined);
}

// ---------------------------------------------------------------- handlers

/**
 * @internal Compare-and-swap loop, shared by webhooks and reconcileSubscription().
 * See docs/SYNC_MODEL.md, "Subscription write".
 */
export async function syncSubscription(
  c: Context,
  subscriptionId: string,
  o: { mustBeTerminal: boolean; allowShortcut?: boolean; skipUnchanged?: boolean },
): Promise<SyncOutcome> {
  const { store, stripe } = c.deps;
  const shortcut = c.options.readOrderShortcut && (o.allowShortcut ?? true) && !o.mustBeTerminal;

  let staleField: string | null = null;
  for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
    if (attempt > 0) await sleep(Math.random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1)));

    const read = await store.beginRead(subscriptionId, c.event.id);
    // Opt-in read-order shortcut (SyncDeps.readOrderShortcut). The stored row came from a Stripe
    // read that started after this event arrived; ASSUMING that read reflects this event's change,
    // there is nothing to fetch or write. Deletions and reconciliation never take it.
    if (shortcut && read.superseded) {
      c.log.info('stripe_sync.read_order_skip', { eventId: c.event.id, subscriptionId });
      return 'covered';
    }

    // No transaction is open here: the Stripe call happens between two independent statements.
    c.attempts++;
    const fetched = toSnapshot(await retrieveWithAllItems(stripe, subscriptionId), subscriptionId);

    if (fetched.livemode !== c.options.livemode) {
      throw new ModeMismatchError(`Subscription ${subscriptionId} has livemode=${fetched.livemode}, endpoint expects ${c.options.livemode}; nothing written`);
    }
    if (o.mustBeTerminal && !TERMINAL_STATUSES.has(fetched.status)) {
      // A deleted event, but Stripe's read does not show it yet. Do not write a live state.
      throw new Error(`Subscription ${subscriptionId} is "${fetched.status}" in Stripe after a deleted event; retry later`);
    }
    staleField = contradictsEvent(c.event, fetched);
    if (staleField) {
      // Stripe returned the state from before this very event: a stale read. Do not write it.
      c.log.warn('stripe_sync.stale_read', { eventId: c.event.id, subscriptionId, field: staleField, attempt });
      continue;
    }

    const userId = await c.users.userForSubscription({ id: subscriptionId, customerId: fetched.customer_id }, store);
    const snapshot: Snapshot = { ...fetched, user_id: userId, read_seq: read.readSeq };
    if (o.skipUnchanged && read.revision > 0) {
      // reconcileRecent() only: if the row still has the revision read above and holds what
      // Stripe just returned, write nothing. Any other case goes through applySnapshot as usual.
      const stored = (await store.listSubscriptionsForUser(userId)).find((s) => s.subscription_id === subscriptionId);
      if (stored && Number(stored.revision) === read.revision && stored.tombstoned_at === null && sameAsStored(stored, snapshot)) {
        c.log.info('stripe_sync.reconcile_unchanged', { eventId: c.event.id, subscriptionId });
        return 'unchanged';
      }
    }
    const result = await store.applySnapshot(subscriptionId, read.revision, c.token, c.event.id, snapshot);

    switch (result) {
      case 'applied':
        return 'applied';
      case 'tombstoned':
        c.log.info('stripe_sync.tombstone_refused', { eventId: c.event.id, subscriptionId });
        return 'tombstoned';
      case 'claim_lost':
        throw new ClaimLostError(c.event.id);
      case 'user_mismatch':
        throw new OwnerMismatchError(subscriptionId);
      case 'mode_mismatch':
        throw new ModeMismatchError(`Stored subscription ${subscriptionId} is from the other Stripe mode; nothing written`);
      case 'conflict':
        c.log.info('stripe_sync.revision_conflict', { eventId: c.event.id, subscriptionId, attempt });
        continue;
    }
  }
  if (staleField) throw new StaleReadError(subscriptionId, staleField);
  throw new ConflictRetriesExhaustedError(subscriptionId, MAX_CONFLICT_RETRIES);
}

/** The guarded field the fetched snapshot shows at its pre-event value, or null. See STALE_GUARD_SECONDS. */
function contradictsEvent(event: StripeEventLike, fetched: { status: string; cancel_at_period_end: boolean }): string | null {
  if (event.type !== 'customer.subscription.updated' || typeof event.created !== 'number') return null;
  if (Math.abs(Date.now() / 1000 - event.created) > STALE_GUARD_SECONDS) return null;
  const now = rec(event.data.object);
  const before = rec(event.data.previous_attributes);
  for (const field of STALE_GUARDED_FIELDS) {
    if (field in before && now[field] !== before[field] && fetched[field] === before[field]) return field;
  }
  return null;
}

/** invoice.paid / invoice.payment_failed only trigger a re-fetch of their subscription. */
async function syncFromInvoice(c: Context) {
  const invoice = rec(c.event.data.object);
  const subscriptionId =
    idOf(invoice.subscription) ?? // API versions before 2025-03-31.basil
    idOf(rec(rec(invoice.parent).subscription_details).subscription); // 2025-03-31.basil and later
  if (!subscriptionId) return 'skipped'; // e.g. a one-off invoice
  return asStatus(await syncSubscription(c, subscriptionId, { mustBeTerminal: false }));
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

  const result = await c.deps.store.linkCustomer(customerId, userId, c.event.id, c.token, c.options.livemode);
  if (result === 'claim_lost') throw new ClaimLostError(c.event.id);
  if (result === 'mode_mismatch') throw new ModeMismatchError(`Customer ${customerId} is linked in the other Stripe mode; not relinking`);
  if (result === 'mismatch') throw new MappingError(`Customer ${customerId} is already linked to another user; not relinking`);
  return 'succeeded';
}

/**
 * Retrieves the subscription and, if its embedded item list is incomplete (`has_more`) and the
 * retriever can list items, pages through the rest. Any page failing fails the whole read, so
 * nothing partial is written. The pages are separate Stripe reads: an item change between them
 * can produce a mixed list, which the next event for the subscription repairs.
 */
async function retrieveWithAllItems(stripe: SubscriptionRetriever, subscriptionId: string): Promise<unknown> {
  const raw = await stripe.retrieveSubscription(subscriptionId);
  const sub = rec(raw);
  const list = rec(sub.items);
  if (list.has_more !== true || !stripe.listSubscriptionItems) return raw; // toSnapshot refuses has_more

  const items = Array.isArray(list.data) ? [...(list.data as unknown[])] : [];
  for (let page = 1, hasMore = true; hasMore; page++) {
    if (page > MAX_ITEM_PAGES) throw new Error(`Subscription ${subscriptionId}: more than ${MAX_ITEM_PAGES} item pages; refusing`);
    const after = str(rec(items.at(-1)).id);
    if (!after) throw new MissingFieldError(`items.data[${items.length - 1}].id`, `subscription ${subscriptionId}`);
    const next = rec(await stripe.listSubscriptionItems(subscriptionId, after));
    const data = Array.isArray(next.data) ? (next.data as unknown[]) : [];
    hasMore = next.has_more === true;
    if (data.length === 0 && hasMore) throw new Error(`Subscription ${subscriptionId}: empty item page with has_more; refusing`);
    items.push(...data);
  }
  return { ...sub, items: { ...list, data: items, has_more: false } };
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
    livemode: need(typeof sub.livemode === 'boolean' ? sub.livemode : null, 'livemode'),
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

/** True if the stored row holds every stored field of `snapshot` (read_seq aside). */
function sameAsStored(stored: StoredSubscription, snap: Snapshot): boolean {
  const secs = (iso: string | null) => (iso === null ? null : Math.floor(Date.parse(iso) / 1000));
  const items = Array.isArray(stored.items) ? stored.items : [];
  return (
    stored.user_id === snap.user_id &&
    stored.customer_id === snap.customer_id &&
    stored.livemode === snap.livemode &&
    stored.status === snap.status &&
    stored.price_id === snap.price_id &&
    stored.product_id === snap.product_id &&
    stored.quantity === snap.quantity &&
    secs(stored.current_period_start) === snap.current_period_start &&
    secs(stored.current_period_end) === snap.current_period_end &&
    stored.cancel_at_period_end === snap.cancel_at_period_end &&
    secs(stored.cancel_at) === snap.cancel_at &&
    secs(stored.canceled_at) === snap.canceled_at &&
    secs(stored.ended_at) === snap.ended_at &&
    secs(stored.trial_end) === snap.trial_end &&
    items.length === snap.items.length &&
    snap.items.every((item, i) => {
      const s = items[i];
      return (
        s !== undefined &&
        s.id === item.id &&
        s.price_id === item.price_id &&
        s.product_id === item.product_id &&
        s.quantity === item.quantity &&
        s.current_period_start === item.current_period_start &&
        s.current_period_end === item.current_period_end
      );
    })
  );
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
