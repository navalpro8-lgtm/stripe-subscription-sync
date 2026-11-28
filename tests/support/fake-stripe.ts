// In-memory stand-in for Stripe's subscription retrieval. No network, no Stripe account.
//
// retrieveSubscription() copies the stored state at the moment it is called (the "read"), then
// optionally waits on a hold before returning. That lets a test force "worker A read old state,
// then worker B committed newer state, then A tries to write" deterministically.
import type { SubscriptionRetriever } from '../../src/index.js';

export interface Hold {
  /** Resolves once a retrieve call has read the state and is waiting. */
  reached: Promise<void>;
  release(): void;
}

export class FakeStripe implements SubscriptionRetriever {
  private readonly subscriptions = new Map<string, Record<string, unknown>>();
  private readonly holds = new Map<string, Array<{ hold: Hold; markReached: () => void; released: Promise<void> }>>();
  private readonly stale = new Map<string, Array<Record<string, unknown>>>();
  readonly calls: string[] = [];
  /** Set by pageItems(): the item pager. Absent by default, like a retriever without one. */
  listSubscriptionItems?: (subscriptionId: string, startingAfter: string) => Promise<unknown>;
  /** Set by pageCustomerSubscriptions(): the customer-subscription lister used by reconcileCustomer. */
  listCustomerSubscriptions?: (customerId: string, startingAfter?: string) => Promise<unknown>;
  /** Set by pageEvents(): the subscription-event lister used by reconcileRecent. */
  listSubscriptionEvents?: (since: number, startingAfter?: string) => Promise<unknown>;
  /** Events served by pageEvents(), added with addEvent(). */
  private readonly events: Array<{ id: string; type: string; created: number; data: { object: { id: string } } }> = [];
  /** Every retrieve of these ids throws the given error. */
  private readonly failing = new Map<string, unknown>();
  /** The next retrieve (of any id) throws this instead of reading. */
  failNextRetrieve?: unknown;
  /** Runs after the state is read and before the call returns (used to inject concurrent writes). */
  afterRead?: (id: string) => Promise<void>;

  set(subscription: Record<string, unknown>): void {
    this.subscriptions.set(String(subscription.id), structuredClone(subscription));
  }

  /**
   * Serves `allItems` as Stripe's item list for `id`, `pageSize` at a time after a given item id.
   * `failAfter`: listing after that item id throws, like a failed Stripe call.
   */
  pageItems(id: string, allItems: unknown[], pageSize: number, opts: { failAfter?: string } = {}): void {
    this.listSubscriptionItems = async (subscriptionId, startingAfter) => {
      this.calls.push(`items:${subscriptionId}:${startingAfter}`);
      if (subscriptionId !== id) throw new Error(`FakeStripe: no item list for ${subscriptionId}`);
      if (opts.failAfter === startingAfter) throw new Error('FakeStripe: item page request failed');
      const start = allItems.findIndex((item) => (item as { id: string }).id === startingAfter) + 1;
      if (start === 0) throw new Error(`FakeStripe: unknown starting_after ${startingAfter}`);
      const data = structuredClone(allItems.slice(start, start + pageSize));
      return { object: 'list', data, has_more: start + pageSize < allItems.length };
    };
  }

  /** Lists stored subscriptions by customer, in id order, `pageSize` at a time. */
  pageCustomerSubscriptions(pageSize: number): void {
    this.listCustomerSubscriptions = async (customerId, startingAfter) => {
      this.calls.push(`list:${customerId}:${startingAfter ?? ''}`);
      const all = [...this.subscriptions.values()]
        .filter((s) => s.customer === customerId)
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const start = startingAfter === undefined ? 0 : all.findIndex((s) => s.id === startingAfter) + 1;
      return { object: 'list', data: structuredClone(all.slice(start, start + pageSize)), has_more: start + pageSize < all.length };
    };
  }

  /** Records a customer.subscription.* event for `subscriptionId`, created at `created` (unix seconds). */
  addEvent(subscriptionId: string, created: number, type = 'customer.subscription.updated'): void {
    this.events.push({ id: `evt_${this.events.length + 1}`, type, created, data: { object: { id: subscriptionId } } });
  }

  /** Lists added events created at or after `since`, newest first like Stripe, `pageSize` at a time. */
  pageEvents(pageSize: number): void {
    this.listSubscriptionEvents = async (since, startingAfter) => {
      this.calls.push(`events:${since}:${startingAfter ?? ''}`);
      const all = this.events.filter((e) => e.created >= since).sort((a, b) => b.created - a.created || b.id.localeCompare(a.id));
      const start = startingAfter === undefined ? 0 : all.findIndex((e) => e.id === startingAfter) + 1;
      if (startingAfter !== undefined && start === 0) throw new Error(`FakeStripe: unknown starting_after ${startingAfter}`);
      return { object: 'list', data: structuredClone(all.slice(start, start + pageSize)), has_more: start + pageSize < all.length };
    };
  }

  /** Every retrieve of `id` throws `err`. */
  failRetrieve(id: string, err: unknown): void {
    this.failing.set(id, err);
  }

  /** The next retrieve of `id` returns `snapshot` instead of the current state: a stale read. */
  serveStale(snapshot: Record<string, unknown>): void {
    const id = String(snapshot.id);
    this.stale.set(id, [...(this.stale.get(id) ?? []), structuredClone(snapshot)]);
  }

  /** The next retrieve of `id` reads the state, then waits until release() is called. */
  hold(id: string): Hold {
    let markReached!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => (markReached = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const hold = { reached, release };
    this.holds.set(id, [...(this.holds.get(id) ?? []), { hold, markReached, released }]);
    return hold;
  }

  async retrieveSubscription(id: string): Promise<unknown> {
    this.calls.push(id);
    if (this.failNextRetrieve !== undefined) {
      const err = this.failNextRetrieve;
      this.failNextRetrieve = undefined;
      throw err;
    }
    if (this.failing.has(id)) throw this.failing.get(id);
    const stored = this.subscriptions.get(id);
    // Shaped like the Stripe SDK's StripeInvalidRequestError for a missing object.
    if (!stored) throw Object.assign(new Error(`No such subscription: '${id}'`), { statusCode: 404, code: 'resource_missing' });
    const copy = this.stale.get(id)?.shift() ?? structuredClone(stored);
    await this.afterRead?.(id);
    const pending = this.holds.get(id)?.shift();
    if (pending) {
      pending.markReached();
      await pending.released;
    }
    return copy;
  }
}
