// Synthetic Stripe-shaped objects for tests. Hand-written, NOT captured from Stripe. They follow
// the shapes in Stripe's API reference that this module reads; see fixtures/ for the same shapes
// as labelled JSON files.

export type Shape = 'items' | 'legacy';

export const DAY = 86_400;
export const T0 = 1_767_225_600; // 2026-01-01T00:00:00Z

export interface SubscriptionOptions {
  id?: string;
  customer?: string | { id: string };
  status?: string;
  price?: string;
  product?: string | { id: string; object: 'product' };
  quantity?: number;
  cancelAtPeriodEnd?: boolean;
  start?: number;
  end?: number;
  shape?: Shape;
  omit?: string[]; // dotted paths to delete, for missing-field tests
}

export function subscription(o: SubscriptionOptions = {}): Record<string, unknown> {
  const id = o.id ?? 'sub_1';
  const start = o.start ?? T0;
  const end = o.end ?? start + 30 * DAY;
  const status = o.status ?? 'active';
  const price = o.price ?? 'price_pro';
  const product = o.product ?? 'prod_pro';
  const shape = o.shape ?? 'items';
  const terminal = status === 'canceled' || status === 'incomplete_expired';

  const item: Record<string, unknown> = {
    id: `si_${id}`,
    object: 'subscription_item',
    price: { id: price, object: 'price', product },
    quantity: o.quantity ?? 1,
  };
  const sub: Record<string, unknown> = {
    id,
    object: 'subscription',
    customer: o.customer ?? 'cus_1',
    status,
    cancel_at_period_end: o.cancelAtPeriodEnd ?? false,
    cancel_at: null,
    canceled_at: terminal ? start + DAY : null,
    ended_at: terminal ? start + DAY : null,
    trial_end: null,
    items: { object: 'list', data: [item] },
  };
  if (shape === 'items') {
    item.current_period_start = start;
    item.current_period_end = end;
  } else {
    item.plan = { id: price, object: 'plan', product };
    sub.current_period_start = start;
    sub.current_period_end = end;
  }
  for (const path of o.omit ?? []) deletePath(sub, path);
  return sub;
}

function deletePath(obj: Record<string, unknown>, path: string): void {
  const keys = path.split('.');
  let cur: unknown = obj;
  for (const key of keys.slice(0, -1)) cur = (cur as Record<string, unknown>)[key];
  delete (cur as Record<string, unknown>)[keys[keys.length - 1]!];
}

export function invoice(subscriptionId: string | null, shape: Shape = 'items'): Record<string, unknown> {
  const base = { id: 'in_1', object: 'invoice', customer: 'cus_1' };
  if (subscriptionId === null) return { ...base, parent: null };
  return shape === 'items'
    ? { ...base, parent: { type: 'subscription_details', subscription_details: { subscription: subscriptionId } } }
    : { ...base, subscription: subscriptionId };
}

export function checkoutSession(o: { customer?: string | null; clientReferenceId?: string | null; mode?: string } = {}) {
  return {
    id: 'cs_1',
    object: 'checkout.session',
    mode: o.mode ?? 'subscription',
    customer: o.customer === undefined ? 'cus_1' : o.customer,
    client_reference_id: o.clientReferenceId === undefined ? USER_A : o.clientReferenceId,
    subscription: 'sub_1',
  };
}

let seq = 0;
export function event(type: string, object: unknown, id?: string) {
  return { id: id ?? `evt_${++seq}`, object: 'event', type, created: T0, livemode: false, data: { object } };
}

// Application user ids (UUIDs, as Supabase auth would produce).
export const USER_A = '00000000-0000-4000-8000-00000000000a';
export const USER_B = '00000000-0000-4000-8000-00000000000b';
