// Extension point 1: entitlement policy.
//
// THIS IS AN EXAMPLE POLICY. It is deliberately simple; replace it with your product's rules
// (grace periods for past_due, per-product access, seat counts, ...).
//
// Entitlement is computed on read from the user's subscription rows. No aggregate is stored, so
// there is nothing to keep in sync and a policy change applies immediately to every user.
import type { StoredSubscription, SyncStore } from '../core/types.js';

export type EntitlementPolicy<E = Entitlement> = (subscriptions: StoredSubscription[]) => E;

export type Entitlement = 'active' | 'none';

const ACTIVE_STATUSES = new Set(['active', 'trialing']);

/** EXAMPLE: 'active' if ANY of the user's subscriptions is active or trialing, else 'none'. */
export const exampleEntitlementPolicy: EntitlementPolicy = (subscriptions) =>
  subscriptions.some((s) => ACTIVE_STATUSES.has(s.status)) ? 'active' : 'none';

/** Reads the user's committed subscription rows and applies the policy. */
export async function getEntitlement<E = Entitlement>(
  store: SyncStore,
  userId: string,
  policy: EntitlementPolicy<E> = exampleEntitlementPolicy as unknown as EntitlementPolicy<E>,
): Promise<E> {
  return policy(await store.listSubscriptionsForUser(userId));
}
