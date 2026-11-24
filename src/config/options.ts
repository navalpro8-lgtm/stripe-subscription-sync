// Validation of the SyncDeps options that change behaviour. Called once at startup by the adapters
// (so a bad value fails the deploy, not the first webhook) and again by processEvent().
import { resolveEnabledEvents, type ImplementedEvent } from './events.js';
import type { SyncDeps } from '../core/types.js';

export interface ResolvedOptions {
  readOrderShortcut: boolean;
  enabled: ReadonlySet<ImplementedEvent>;
}

export function resolveOptions(deps: SyncDeps): ResolvedOptions {
  if (deps.readOrderShortcut !== undefined && typeof deps.readOrderShortcut !== 'boolean') {
    throw new Error('SyncDeps.readOrderShortcut must be a boolean');
  }
  return {
    readOrderShortcut: deps.readOrderShortcut ?? false,
    enabled: resolveEnabledEvents(deps.enabledEvents),
  };
}
