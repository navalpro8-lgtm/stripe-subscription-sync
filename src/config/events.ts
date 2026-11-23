// Extension point 4: which of the implemented handlers are enabled.
// You can only choose among these; adding a new event type means writing a handler in
// core/process-event.ts. Events that are not enabled are acknowledged (200) and recorded as ignored.

export const IMPLEMENTED_EVENTS = [
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
  'checkout.session.completed',
] as const;

export type ImplementedEvent = (typeof IMPLEMENTED_EVENTS)[number];

export const DEFAULT_ENABLED_EVENTS: readonly ImplementedEvent[] = IMPLEMENTED_EVENTS;

/** Throws on anything that is not an implemented event, so a typo fails at startup, not silently. */
export function resolveEnabledEvents(enabled: readonly string[] = DEFAULT_ENABLED_EVENTS): ReadonlySet<ImplementedEvent> {
  for (const type of enabled) {
    if (!(IMPLEMENTED_EVENTS as readonly string[]).includes(type)) {
      throw new Error(`enabledEvents: "${type}" has no handler. Implemented: ${IMPLEMENTED_EVENTS.join(', ')}`);
    }
  }
  return new Set(enabled as readonly ImplementedEvent[]);
}
