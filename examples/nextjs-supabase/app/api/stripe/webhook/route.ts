import { handleStripeWebhook } from '../../../../lib/billing';

// The Stripe SDK's synchronous constructEvent uses Node's crypto module.
export const runtime = 'nodejs';

export const POST = handleStripeWebhook;
