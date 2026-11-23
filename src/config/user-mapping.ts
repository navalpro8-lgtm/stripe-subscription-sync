// Extension point 2: Stripe customer → application user id.
//
// Default: checkout.session.completed links the session's customer to `client_reference_id`, and
// every subscription write looks its customer up in stripe_customer_links.
//
// `client_reference_id` is only trustworthy if YOUR server sets it from the authenticated user when
// it creates the Checkout Session (outside this module). Never take it from the browser, a URL
// parameter, or metadata a client can edit. See SECURITY.md.
//
// Missing or invalid mapping is an error: the event fails and Stripe retries it. Replace this file
// (or pass your own UserResolver) if your users map to customers some other way.
import { MappingError } from '../core/errors.js';
import type { CheckoutSessionLike, UserResolver } from '../core/types.js';

const MAX_USER_ID_LENGTH = 255;

/** Accepts any non-blank id without surrounding whitespace, up to 255 characters. Tighten it
 *  (e.g. a UUID check) if your ids have a known format. */
export function isValidUserId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_USER_ID_LENGTH && value.trim() === value;
}

export const defaultUserResolver: UserResolver = {
  userFromCheckoutSession(session: CheckoutSessionLike): string | null {
    return isValidUserId(session.client_reference_id) ? session.client_reference_id : null;
  },

  async userForSubscription(subscription, store) {
    const userId = await store.findUserByCustomer(subscription.customerId);
    if (!isValidUserId(userId)) {
      throw new MappingError(
        `No user linked to customer ${subscription.customerId} (subscription ${subscription.id}); ` +
          'waiting for checkout.session.completed',
      );
    }
    return userId;
  },
};
