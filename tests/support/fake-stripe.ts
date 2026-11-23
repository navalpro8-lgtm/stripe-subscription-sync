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
  readonly calls: string[] = [];
  /** Runs after the state is read and before the call returns (used to inject concurrent writes). */
  afterRead?: (id: string) => Promise<void>;

  set(subscription: Record<string, unknown>): void {
    this.subscriptions.set(String(subscription.id), structuredClone(subscription));
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
    const stored = this.subscriptions.get(id);
    if (!stored) throw new Error(`FakeStripe: no such subscription ${id}`);
    const copy = structuredClone(stored);
    await this.afterRead?.(id);
    const pending = this.holds.get(id)?.shift();
    if (pending) {
      pending.markReached();
      await pending.released;
    }
    return copy;
  }
}
