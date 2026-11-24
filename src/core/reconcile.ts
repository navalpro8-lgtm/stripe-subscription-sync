// Reconciliation: re-read a subscription from Stripe and write it through the SAME claim and
// compare-and-swap path as a webhook. Library functions only; scheduling them is up to you.
// Contract: docs/SYNC_MODEL.md, "Reconciliation". Runbook: docs/RUNBOOK.md.
import { defaultUserResolver } from '../config/user-mapping.js';
import { resolveOptions } from '../config/options.js';
import {
  ClaimLostError,
  ConflictRetriesExhaustedError,
  isStripeNotFound,
  MappingError,
  ModeMismatchError,
  OwnerMismatchError,
  UnlinkedCustomerError,
} from './errors.js';
import { structuredLog, syncSubscription, type Context } from './process-event.js';
import { errorMessage } from './redact.js';
import type { SyncDeps } from './types.js';

/** The `event_type` of the stripe_events row each reconcile run records. */
export const RECONCILE_EVENT_TYPE = 'reconcile';

export type ReconcileFailureReason =
  | 'not_found' // Stripe has no such subscription (404)
  | 'unlinked_customer' // no user linked to the subscription's customer yet
  | 'owner_mismatch' // the stored row belongs to another user
  | 'mapping' // your UserResolver refused (MappingError)
  | 'mode_mismatch' // Stripe or the stored row is from the other mode
  | 'retries_exhausted' // every compare-and-swap attempt lost to concurrent writers
  | 'claim_lost' // the run's claim was taken over (it ran longer than claimTimeoutSeconds)
  | 'error'; // anything else: Stripe or network error, missing field, ...

export type ReconcileResult =
  | { subscriptionId: string; outcome: 'applied'; correlationId: string }
  | { subscriptionId: string; outcome: 'tombstoned'; correlationId: string }
  | { subscriptionId: string; outcome: 'failed'; reason: ReconcileFailureReason; error: string; correlationId: string };

/**
 * Fetches one subscription from Stripe and writes it with compare-and-swap, exactly as a webhook
 * would. Never takes the read-order shortcut. Never throws for the failures listed in
 * ReconcileFailureReason; database errors (store calls throwing) are thrown.
 *
 * Each run records a stripe_events row (`reconcile:<subscription>:<uuid>`, type 'reconcile'),
 * because the write path requires a claim.
 */
export async function reconcileSubscription(subscriptionId: string, deps: SyncDeps): Promise<ReconcileResult> {
  if (typeof subscriptionId !== 'string' || subscriptionId === '') throw new Error('reconcileSubscription: subscriptionId is required');
  const options = resolveOptions(deps);
  const correlationId = globalThis.crypto.randomUUID();
  const log = structuredLog(deps.logger, correlationId);
  const token = globalThis.crypto.randomUUID();
  const eventId = `reconcile:${subscriptionId}:${globalThis.crypto.randomUUID()}`;

  const claim = await deps.store.claimEvent(eventId, RECONCILE_EVENT_TYPE, token, options.livemode, options.claimTimeoutSeconds);
  if (claim !== 'claimed') throw new Error(`reconcileSubscription: could not claim ${eventId} (${claim})`);

  const c: Context = {
    event: { id: eventId, type: RECONCILE_EVENT_TYPE, livemode: options.livemode, data: { object: { id: subscriptionId } } },
    token, deps, options, users: deps.users ?? defaultUserResolver, log, attempts: 0,
  };

  let result: ReconcileResult;
  try {
    const outcome = await syncSubscription(c, subscriptionId, { mustBeTerminal: false, allowShortcut: false });
    result = { subscriptionId, outcome: outcome === 'tombstoned' ? 'tombstoned' : 'applied', correlationId };
  } catch (err) {
    result = { subscriptionId, outcome: 'failed', reason: classify(err), error: errorMessage(err), correlationId };
  }

  if (!(result.outcome === 'failed' && result.reason === 'claim_lost')) {
    const status = result.outcome === 'applied' ? 'succeeded' : result.outcome === 'tombstoned' ? 'skipped' : 'failed';
    const finished = await deps.store.finishEvent(eventId, token, status, result.outcome === 'failed' ? result.error : null);
    if (!finished) result = { subscriptionId, outcome: 'failed', reason: 'claim_lost', error: `Claim on ${eventId} was taken over`, correlationId };
  }

  const line = { eventId, subscriptionId, outcome: result.outcome, attempts: c.attempts, ...(result.outcome === 'failed' && { reason: result.reason, error: result.error }) };
  if (result.outcome === 'failed') log.error('stripe_sync.reconcile', line);
  else log.info('stripe_sync.reconcile', line);
  return result;
}

function classify(err: unknown): ReconcileFailureReason {
  if (isStripeNotFound(err)) return 'not_found';
  if (err instanceof ClaimLostError) return 'claim_lost';
  if (err instanceof ModeMismatchError) return 'mode_mismatch';
  if (err instanceof ConflictRetriesExhaustedError) return 'retries_exhausted';
  if (err instanceof UnlinkedCustomerError) return 'unlinked_customer';
  if (err instanceof OwnerMismatchError) return 'owner_mismatch';
  if (err instanceof MappingError) return 'mapping';
  return 'error';
}

export interface ReconcileCustomerOptions {
  /** Stop after this many subscriptions (default 1000, at most 10000); `truncated` says so. */
  maxSubscriptions?: number;
}

export interface ReconcileCustomerResult {
  customerId: string;
  results: ReconcileResult[];
  /** True if Stripe had more subscriptions than maxSubscriptions; run again or raise the limit. */
  truncated: boolean;
}

/**
 * Lists one customer's subscriptions from Stripe (every status, cursor-paged) and runs
 * reconcileSubscription() on each, one at a time. Needs `listCustomerSubscriptions` on the
 * retriever (fromStripeSdk provides it). A Stripe error while listing is thrown: nothing has
 * been reconciled for the pages not yet read, and the ones already reconciled stay written.
 */
export async function reconcileCustomer(
  customerId: string,
  deps: SyncDeps,
  opts: ReconcileCustomerOptions = {},
): Promise<ReconcileCustomerResult> {
  if (typeof customerId !== 'string' || customerId === '') throw new Error('reconcileCustomer: customerId is required');
  const list = deps.stripe.listCustomerSubscriptions?.bind(deps.stripe);
  if (!list) throw new Error('reconcileCustomer: the SubscriptionRetriever has no listCustomerSubscriptions');
  const max = opts.maxSubscriptions ?? 1000;
  if (!Number.isInteger(max) || max < 1 || max > 10_000) throw new Error('reconcileCustomer: maxSubscriptions must be an integer from 1 to 10000');
  resolveOptions(deps);

  const results: ReconcileResult[] = [];
  let startingAfter: string | undefined;
  let hasMore = true;
  while (hasMore && results.length < max) {
    const page = (await list(customerId, startingAfter)) as { data?: Array<{ id?: unknown }>; has_more?: unknown } | null;
    const data = Array.isArray(page?.data) ? page.data : [];
    hasMore = page?.has_more === true;
    if (data.length === 0 && hasMore) throw new Error(`reconcileCustomer: empty page with has_more for ${customerId}`);
    for (const sub of data) {
      if (typeof sub.id !== 'string') throw new Error(`reconcileCustomer: subscription without id for ${customerId}`);
      if (results.length >= max) {
        hasMore = true;
        break;
      }
      results.push(await reconcileSubscription(sub.id, deps));
      startingAfter = sub.id;
    }
  }
  return { customerId, results, truncated: hasMore };
}
