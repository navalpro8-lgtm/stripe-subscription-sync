// Packaging smoke test: pack the module, install the tarball into a throwaway project, import
// every public export at runtime, and typecheck a consumer file against the shipped .d.ts files.
// No registry access is needed: the package has no runtime dependencies.
//
//   npm run build && node scripts/pack-smoke.mjs
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const opts = (cwd) => ({ cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const run = (cmd, args, cwd) => execFileSync(cmd, args, opts(cwd));
// npm is a .cmd shim on Windows, which needs a shell; arguments with spaces are quoted.
const runNpm = (args, cwd) => execFileSync(npm, args.map((a) => (a.includes(' ') ? `"${a}"` : a)), { ...opts(cwd), shell: process.platform === 'win32' });

const EXPECTED_RUNTIME_EXPORTS = [
  'ClaimLostError', 'ConflictRetriesExhaustedError', 'DEFAULT_CLAIM_TIMEOUT_SECONDS', 'DEFAULT_ENABLED_EVENTS',
  'DEFAULT_MAX_BODY_BYTES', 'IMPLEMENTED_EVENTS', 'MAX_CLAIM_TIMEOUT_SECONDS', 'MIN_CLAIM_TIMEOUT_SECONDS', 'MappingError',
  'MissingFieldError', 'ModeMismatchError', 'OwnerMismatchError', 'RECONCILE_EVENT_TYPE', 'UnlinkedCustomerError',
  'createNextWebhookHandler', 'defaultUserResolver', 'exampleEntitlementPolicy', 'fromStripeSdk', 'getEntitlement',
  'isStripeNotFound', 'isValidUserId', 'postgresStore', 'processEvent', 'reconcileCustomer', 'reconcileSubscription',
  'redact', 'resolveEnabledEvents', 'resolveOptions', 'storeFromFunctions', 'supabaseStore', 'toSnapshot',
];
const REQUIRED_FILES = ['package/dist/index.js', 'package/dist/index.d.ts', 'package/sql/schema.sql', 'package/sql/supabase.sql',
  'package/sql/health.sql', 'package/sql/migrations/0002_v0.2.0.sql', 'package/LICENSE', 'package/README.md'];
const FORBIDDEN = [/\.env(\.|$)/, /^package\/tests\//, /^package\/examples\//, /^package\/node_modules\//];

const work = await mkdtemp(join(tmpdir(), 'sss-pack-'));
try {
  // 1. Pack and inspect the file list.
  const packed = JSON.parse(runNpm(['pack', '--json', '--pack-destination', work], root));
  const files = packed[0].files.map((f) => `package/${f.path}`);
  for (const f of REQUIRED_FILES) if (!files.includes(f)) throw new Error(`tarball is missing ${f}`);
  for (const f of files) if (FORBIDDEN.some((re) => re.test(f))) throw new Error(`tarball must not contain ${f}`);
  const tarball = join(work, packed[0].filename);
  console.log(`packed ${packed[0].filename}: ${files.length} files, ${packed[0].size} bytes`);

  // 2. Install into a throwaway consumer project.
  const app = join(work, 'consumer');
  await mkdir(app);
  await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'sss-consumer', private: true, type: 'module' }));
  runNpm(['install', '--no-audit', '--no-fund', '--ignore-scripts', tarball], app);
  if (!(await readdir(join(app, 'node_modules'))).includes('stripe-subscription-sync')) throw new Error('install failed');

  // 3. Runtime: every expected export is there, and nothing unexpected.
  await writeFile(join(app, 'runtime.mjs'), `
    import * as m from 'stripe-subscription-sync';
    const got = Object.keys(m).sort();
    const want = ${JSON.stringify([...EXPECTED_RUNTIME_EXPORTS].sort())};
    if (JSON.stringify(got) !== JSON.stringify(want)) { console.error('exports differ', { got, want }); process.exit(1); }
    console.log('runtime exports ok:', got.length);
  `);
  console.log(run(process.execPath, ['runtime.mjs'], app).trim());

  // 4. Types: a consumer using the main entry points typechecks against the shipped .d.ts.
  await writeFile(join(app, 'consumer.ts'), `
    import {
      createNextWebhookHandler, fromStripeSdk, getEntitlement, postgresStore, reconcileCustomer, reconcileSubscription,
      supabaseStore, type ReconcileResult, type SyncDeps, type SyncStore,
    } from 'stripe-subscription-sync';
    declare const pool: { query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };
    declare const supabase: { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> };
    declare const stripe: { subscriptions: { retrieve(id: string): Promise<unknown> }; webhooks: { constructEvent(p: string, h: string, s: string): unknown } };
    const store: SyncStore = postgresStore(pool);
    const deps: SyncDeps = { livemode: false, store, stripe: fromStripeSdk(stripe), claimTimeoutSeconds: 120 };
    export const POST: (req: Request) => Promise<Response> = createNextWebhookHandler({ stripe, webhookSecret: 'whsec_x', sync: deps, maxBodyBytes: 1024 });
    export const viaSupabase: SyncStore = supabaseStore(supabase);
    export async function repair(): Promise<ReconcileResult['outcome']> {
      await reconcileCustomer('cus_1', deps, { maxSubscriptions: 10 });
      await getEntitlement(store, 'user_1');
      return (await reconcileSubscription('sub_1', deps)).outcome;
    }
    // @ts-expect-error livemode is required
    export const missingMode: SyncDeps = { store, stripe: fromStripeSdk(stripe) };
  `);
  await writeFile(join(app, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022', lib: ['es2022', 'dom'], skipLibCheck: false, types: [] },
    files: ['consumer.ts'],
  }));
  run(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], app);
  console.log('consumer typecheck ok');
} finally {
  await rm(work, { recursive: true, force: true });
}
