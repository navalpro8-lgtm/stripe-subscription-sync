// SyncStore for any Postgres client with a `query(text, values)` method, e.g. a node-postgres
// Pool or Client. The client must connect as a role allowed to execute the functions.
import type { SyncStore } from '../core/types.js';
import { storeFromFunctions } from './sql-functions.js';

export interface QueryExecutor {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export function postgresStore(db: QueryExecutor): SyncStore {
  return storeFromFunctions(async (fn, args) => {
    const names = Object.keys(args);
    // Function and argument names are constants from sql-functions.ts; values are parameters.
    const text = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as result`;
    const res = await db.query(text, names.map((n) => args[n]));
    return res.rows[0]?.result ?? null;
  });
}
