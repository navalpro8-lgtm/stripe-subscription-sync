// Core
export { processEvent, toSnapshot } from './core/process-event.js';
export { ClaimLostError, MappingError, MissingFieldError } from './core/errors.js';
export type * from './core/types.js';

// Extension points
export { exampleEntitlementPolicy, getEntitlement, type Entitlement, type EntitlementPolicy } from './policy/entitlements.js';
export { defaultUserResolver, isValidUserId } from './config/user-mapping.js';
export { DEFAULT_ENABLED_EVENTS, IMPLEMENTED_EVENTS, resolveEnabledEvents, type ImplementedEvent } from './config/events.js';

// Adapters
export { createNextWebhookHandler, type NextWebhookOptions, type WebhookVerifier } from './adapters/nextjs.js';
export { postgresStore, type QueryExecutor } from './adapters/postgres.js';
export { supabaseStore, type RpcClient } from './adapters/supabase.js';
export { fromStripeSdk, type StripeSubscriptionsApi } from './adapters/stripe.js';
export { storeFromFunctions, type FunctionCaller } from './adapters/sql-functions.js';
