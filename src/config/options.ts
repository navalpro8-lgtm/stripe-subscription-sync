// Validation of the SyncDeps options that change behaviour. Called once at startup by the adapters
// (so a bad value fails the deploy, not the first webhook) and again by processEvent().
import { resolveEnabledEvents, type ImplementedEvent } from './events.js';
import type { SyncDeps } from '../core/types.js';

/** Default claim takeover threshold. See README "Choosing claimTimeoutSeconds". */
export const DEFAULT_CLAIM_TIMEOUT_SECONDS = 120;
export const MIN_CLAIM_TIMEOUT_SECONDS = 10;
export const MAX_CLAIM_TIMEOUT_SECONDS = 3600;

export interface ResolvedOptions {
  livemode: boolean;
  claimTimeoutSeconds: number;
  readOrderShortcut: boolean;
  enabled: ReadonlySet<ImplementedEvent>;
}

export function resolveOptions(deps: SyncDeps): ResolvedOptions {
  if (typeof deps.livemode !== 'boolean') {
    throw new Error('SyncDeps.livemode is required: true for a live-mode endpoint, false for a sandbox or test mode');
  }
  const timeout = deps.claimTimeoutSeconds ?? DEFAULT_CLAIM_TIMEOUT_SECONDS;
  if (!Number.isInteger(timeout) || timeout < MIN_CLAIM_TIMEOUT_SECONDS || timeout > MAX_CLAIM_TIMEOUT_SECONDS) {
    throw new Error(
      `SyncDeps.claimTimeoutSeconds must be an integer from ${MIN_CLAIM_TIMEOUT_SECONDS} to ${MAX_CLAIM_TIMEOUT_SECONDS}, got ${String(deps.claimTimeoutSeconds)}`,
    );
  }
  if (deps.readOrderShortcut !== undefined && typeof deps.readOrderShortcut !== 'boolean') {
    throw new Error('SyncDeps.readOrderShortcut must be a boolean');
  }
  return {
    livemode: deps.livemode,
    claimTimeoutSeconds: timeout,
    readOrderShortcut: deps.readOrderShortcut ?? false,
    enabled: resolveEnabledEvents(deps.enabledEvents),
  };
}
