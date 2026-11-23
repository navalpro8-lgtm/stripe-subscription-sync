// Interfaces the core depends on. Everything here is injected by the app; the core imports no
// framework, database driver or Stripe SDK.
import type { ImplementedEvent } from '../config/events.js';

// ---------------------------------------------------------------- Stripe shapes we read
// Deliberately minimal and structural, so the core does not depend on a Stripe SDK version.
// Fields marked "id or expanded" may be an ID string or an expanded object with an `id`.

export type IdOrObject = string | { id: string };

export interface StripeEventLike {
  id: string;
  type: string;
  data: { object: unknown };
}

export interface CheckoutSessionLike {
  mode?: string | null;
  customer?: IdOrObject | null;
  client_reference_id?: string | null;
}

/** What the core writes. Times are unix seconds, converted to timestamptz in SQL. */
export interface Snapshot {
  user_id: string;
  customer_id: string;
  status: string;
  price_id: string;
  product_id: string;
  quantity: number | null;
  current_period_start: number;
  current_period_end: number;
  cancel_at_period_end: boolean;
  cancel_at: number | null;
  canceled_at: number | null;
  ended_at: number | null;
  trial_end: number | null;
  /** From beginRead(): marks when the Stripe read for this snapshot started. */
  read_seq: string;
}

/** A row of stripe_subscriptions as returned by list_user_subscriptions (timestamps as ISO strings). */
export interface StoredSubscription {
  subscription_id: string;
  user_id: string;
  customer_id: string;
  status: string;
  price_id: string;
  product_id: string;
  quantity: number | null;
  current_period_start: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
  cancel_at: string | null;
  canceled_at: string | null;
  ended_at: string | null;
  trial_end: string | null;
  tombstoned_at: string | null;
  revision: number;
  read_seq: number | string;
  last_event_id: string;
  updated_at: string;
}

// ---------------------------------------------------------------- injected dependencies

/** Fetches the current subscription from Stripe. The result is parsed by toSnapshot(). */
export interface SubscriptionRetriever {
  retrieveSubscription(id: string): Promise<unknown>;
}

export type ClaimResult = 'claimed' | 'done' | 'busy';
export type FinalStatus = 'succeeded' | 'failed' | 'skipped' | 'ignored';
export type ApplyResult = 'applied' | 'conflict' | 'claim_lost' | 'tombstoned' | 'user_mismatch';

export interface ReadStart {
  /** Stored revision, 0 if there is no row. */
  revision: number;
  /** Opaque marker taken now, before the Stripe read. Passed back in the snapshot. */
  readSeq: string;
  /** The stored row already came from a Stripe read that began after this event first arrived. */
  superseded: boolean;
}
export type LinkResult = 'linked' | 'already_linked' | 'mismatch' | 'claim_lost';

/** Extension point 3: persistence. The shipped adapters call the functions in sql/schema.sql. */
export interface SyncStore {
  claimEvent(eventId: string, eventType: string, token: string): Promise<ClaimResult>;
  /** Returns false if the caller no longer holds the claim (nothing was changed). */
  finishEvent(eventId: string, token: string, status: FinalStatus, error: string | null): Promise<boolean>;
  /** Call immediately before the Stripe read. */
  beginRead(subscriptionId: string, eventId: string): Promise<ReadStart>;
  applySnapshot(
    subscriptionId: string,
    expectedRevision: number,
    token: string,
    eventId: string,
    snapshot: Snapshot,
  ): Promise<ApplyResult>;
  linkCustomer(customerId: string, userId: string, eventId: string, token: string): Promise<LinkResult>;
  findUserByCustomer(customerId: string): Promise<string | null>;
  listSubscriptionsForUser(userId: string): Promise<StoredSubscription[]>;
}

/** Extension point 2: how Stripe objects map to your application's user id. */
export interface UserResolver {
  /** From a verified checkout.session.completed. Return null if there is no valid user id. */
  userFromCheckoutSession(session: CheckoutSessionLike): string | null;
  /** Owner of a subscription about to be written. Throw MappingError if it cannot be resolved. */
  userForSubscription(subscription: { id: string; customerId: string }, store: SyncStore): Promise<string>;
}

/** Extension point 5: optional logger. Any subset of methods may be provided. */
export interface Logger {
  info?(message: string, fields?: Record<string, unknown>): void;
  warn?(message: string, fields?: Record<string, unknown>): void;
  error?(message: string, fields?: Record<string, unknown>): void;
}

export interface SyncDeps {
  store: SyncStore;
  stripe: SubscriptionRetriever;
  /** Default: defaultUserResolver (config/user-mapping.ts). */
  users?: UserResolver;
  /** Extension point 4. Default: every implemented event (config/events.ts). */
  enabledEvents?: readonly ImplementedEvent[];
  logger?: Logger;
}

export type Outcome = FinalStatus | 'duplicate' | 'busy' | 'claim_lost';

export interface ProcessResult {
  httpStatus: 200 | 409 | 500;
  outcome: Outcome;
}
