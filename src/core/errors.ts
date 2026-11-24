// Errors that make an event fail (500, Stripe retries). Messages are stored in
// stripe_events.last_error (after redaction, see redact.ts), so they contain IDs only, never
// payload contents.

/** A field required for the write is missing from the subscription Stripe returned. */
export class MissingFieldError extends Error {
  constructor(readonly field: string, where: string) {
    super(`Missing required field "${field}" on ${where}`);
    this.name = 'MissingFieldError';
  }
}

/** The application user for a Stripe object is missing, invalid, or conflicts with a stored one. */
export class MappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MappingError';
  }
}

/** No application user is linked to the subscription's customer yet. */
export class UnlinkedCustomerError extends MappingError {
  constructor(readonly customerId: string, subscriptionId: string) {
    super(`No user linked to customer ${customerId} (subscription ${subscriptionId}); waiting for checkout.session.completed`);
    this.name = 'UnlinkedCustomerError';
  }
}

/** The stored subscription row belongs to a different user than the one resolved now. */
export class OwnerMismatchError extends MappingError {
  constructor(subscriptionId: string) {
    super(`Subscription ${subscriptionId} belongs to another user; refusing to change its owner`);
    this.name = 'OwnerMismatchError';
  }
}

/** Something from the other Stripe mode (live vs test) than SyncDeps.livemode. Nothing is written. */
export class ModeMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModeMismatchError';
  }
}

/** Every compare-and-swap attempt lost to a concurrent writer. */
export class ConflictRetriesExhaustedError extends Error {
  constructor(subscriptionId: string, retries: number) {
    super(`Revision conflict on subscription ${subscriptionId}: gave up after ${retries} retries`);
    this.name = 'ConflictRetriesExhaustedError';
  }
}

/** Every read Stripe returned still showed the state from before the event being processed. */
export class StaleReadError extends Error {
  constructor(subscriptionId: string, field: string) {
    super(`Stripe kept returning subscription ${subscriptionId} with "${field}" from before this event; retry later`);
    this.name = 'StaleReadError';
  }
}

/** Another worker took over this event's claim. This worker must not write or mark anything. */
export class ClaimLostError extends Error {
  constructor(eventId: string) {
    super(`Claim on event ${eventId} was taken over by another worker`);
    this.name = 'ClaimLostError';
  }
}

/** True for the Stripe SDK's "no such object" error (HTTP 404 / code resource_missing). */
export function isStripeNotFound(err: unknown): boolean {
  const e = err as { statusCode?: unknown; code?: unknown } | null;
  return typeof e === 'object' && e !== null && (e.statusCode === 404 || e.code === 'resource_missing');
}
