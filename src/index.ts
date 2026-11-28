// Core
export { processEvent, toSnapshot } from './core/process-event.js';
export {
  reconcileCustomer,
  reconcileRecent,
  reconcileSubscription,
  RECONCILE_EVENT_TYPE,
  type ReconcileCustomerOptions,
  type ReconcileCustomerResult,
  type ReconcileFailureReason,
  type ReconcileRecentItem,
  type ReconcileRecentOptions,
  type ReconcileRecentResult,
  type ReconcileResult,
} from './core/reconcile.js';
export {
  ClaimLostError,
  ConflictRetriesExhaustedError,
  isStripeNotFound,
  MappingError,
  MissingFieldError,
  ModeMismatchError,
  OwnerMismatchError,
  StaleReadError,
  UnlinkedCustomerError,
} from './core/errors.js';
export { redact } from './core/redact.js';
export type * from './core/types.js';

// Extension points
export { exampleEntitlementPolicy, getEntitlement, type Entitlement, type EntitlementPolicy } from './policy/entitlements.js';
export { defaultUserResolver, isValidUserId } from './config/user-mapping.js';
export { DEFAULT_CLAIM_TIMEOUT_SECONDS, MAX_CLAIM_TIMEOUT_SECONDS, MIN_CLAIM_TIMEOUT_SECONDS, resolveOptions } from './config/options.js';
export { DEFAULT_ENABLED_EVENTS, IMPLEMENTED_EVENTS, resolveEnabledEvents, type ImplementedEvent } from './config/events.js';

// Adapters
export { createNextWebhookHandler, DEFAULT_MAX_BODY_BYTES, type NextWebhookOptions, type WebhookVerifier } from './adapters/nextjs.js';
export { postgresStore, type QueryExecutor } from './adapters/postgres.js';
export { supabaseStore, type RpcClient } from './adapters/supabase.js';
export { fromStripeSdk, type StripeSubscriptionsApi } from './adapters/stripe.js';
export { storeFromFunctions, type FunctionCaller } from './adapters/sql-functions.js';
