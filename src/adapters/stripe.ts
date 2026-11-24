// Adapts a Stripe SDK instance (`new Stripe(secretKey)`) to the core's SubscriptionRetriever.
import type { SubscriptionRetriever } from '../core/types.js';

export interface StripeSubscriptionsApi {
  subscriptions: { retrieve(id: string): Promise<unknown> };
  /** Used to page through items when a subscription's embedded list has `has_more`. */
  subscriptionItems?: {
    list(params: { subscription: string; limit?: number; starting_after?: string }): Promise<unknown>;
  };
}

export function fromStripeSdk(stripe: StripeSubscriptionsApi): SubscriptionRetriever {
  const items = stripe.subscriptionItems;
  return {
    retrieveSubscription: (id) => stripe.subscriptions.retrieve(id),
    ...(items && {
      listSubscriptionItems: (subscription: string, startingAfter: string) =>
        items.list({ subscription, limit: 100, starting_after: startingAfter }),
    }),
  };
}
