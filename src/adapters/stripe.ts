// Adapts a Stripe SDK instance (`new Stripe(secretKey)`) to the core's SubscriptionRetriever.
import type { SubscriptionRetriever } from '../core/types.js';

export interface StripeSubscriptionsApi {
  subscriptions: { retrieve(id: string): Promise<unknown> };
}

export function fromStripeSdk(stripe: StripeSubscriptionsApi): SubscriptionRetriever {
  return { retrieveSubscription: (id) => stripe.subscriptions.retrieve(id) };
}
