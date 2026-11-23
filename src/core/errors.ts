// Errors that make an event fail (500, Stripe retries). Messages are stored in
// stripe_events.last_error, so they contain IDs only, never payload contents.

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

/** Another worker took over this event's claim. This worker must not write or mark anything. */
export class ClaimLostError extends Error {
  constructor(eventId: string) {
    super(`Claim on event ${eventId} was taken over by another worker`);
    this.name = 'ClaimLostError';
  }
}
