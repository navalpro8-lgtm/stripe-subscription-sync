// A SyncStore that calls the SQL functions in sql/schema.sql. Both shipped database adapters are
// this plus a one-line way to call a function; all atomicity lives in the SQL functions.
import type {
  ApplyResult,
  ClaimResult,
  LinkResult,
  StoredSubscription,
  SyncStore,
} from '../core/types.js';

/** Calls public.<fn> with named arguments and returns its single result value. */
export type FunctionCaller = (fn: string, args: Record<string, unknown>) => Promise<unknown>;

const CLAIM_RESULTS: readonly ClaimResult[] = ['claimed', 'done', 'busy'];
const APPLY_RESULTS: readonly ApplyResult[] = ['applied', 'conflict', 'claim_lost', 'tombstoned', 'user_mismatch'];
const LINK_RESULTS: readonly LinkResult[] = ['linked', 'already_linked', 'mismatch', 'claim_lost'];

export function storeFromFunctions(call: FunctionCaller): SyncStore {
  return {
    async claimEvent(eventId, eventType, token) {
      const r = await call('claim_event', { p_event_id: eventId, p_event_type: eventType, p_token: token });
      return oneOf('claim_event', r, CLAIM_RESULTS);
    },

    async finishEvent(eventId, token, status, error) {
      const r = await call('finish_event', { p_event_id: eventId, p_token: token, p_status: status, p_error: error });
      return r === true;
    },

    async beginRead(subscriptionId, eventId) {
      const r = (await call('begin_subscription_read', { p_subscription_id: subscriptionId, p_event_id: eventId })) as
        | { revision?: unknown; read_seq?: unknown; superseded?: unknown }
        | null;
      if (typeof r?.revision !== 'number' || typeof r.read_seq !== 'string' || typeof r.superseded !== 'boolean') {
        throw new Error(`begin_subscription_read returned ${JSON.stringify(r)}`);
      }
      return { revision: r.revision, readSeq: r.read_seq, superseded: r.superseded };
    },

    async applySnapshot(subscriptionId, expectedRevision, token, eventId, snapshot) {
      const r = await call('apply_subscription_snapshot', {
        p_subscription_id: subscriptionId,
        p_expected_revision: expectedRevision,
        p_claim_token: token,
        p_event_id: eventId,
        p_snapshot: snapshot,
      });
      return oneOf('apply_subscription_snapshot', r, APPLY_RESULTS);
    },

    async linkCustomer(customerId, userId, eventId, token) {
      const r = await call('link_customer', {
        p_customer_id: customerId,
        p_user_id: userId,
        p_event_id: eventId,
        p_claim_token: token,
      });
      return oneOf('link_customer', r, LINK_RESULTS);
    },

    async findUserByCustomer(customerId) {
      const r = await call('find_user_for_customer', { p_customer_id: customerId });
      return typeof r === 'string' ? r : null;
    },

    async listSubscriptionsForUser(userId) {
      const r = await call('list_user_subscriptions', { p_user_id: userId });
      if (!Array.isArray(r)) throw new Error(`list_user_subscriptions returned ${JSON.stringify(r)}`);
      return r as StoredSubscription[];
    },
  };
}

function oneOf<T extends string>(fn: string, value: unknown, allowed: readonly T[]): T {
  if ((allowed as readonly unknown[]).includes(value)) return value as T;
  throw new Error(`${fn} returned unexpected value ${JSON.stringify(value)}`);
}
