// SyncStore for a Supabase client, calling the SQL functions through `rpc`. Use a server-side
// client created with the service role key (only service_role may execute the functions).
// Never use this from a browser.
import type { SyncStore } from '../core/types.js';
import { storeFromFunctions } from './sql-functions.js';

export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export function supabaseStore(client: RpcClient): SyncStore {
  return storeFromFunctions(async (fn, args) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`Supabase rpc ${fn} failed: ${error.message}`);
    return data;
  });
}
