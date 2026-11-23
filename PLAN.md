# PLAN: stripe-subscription-sync

Status: **implemented**. The plan was approved with the defaults in §10, and `embedded-postgres` was chosen for local tests. The sync design is fixed in [docs/SYNC_MODEL.md](docs/SYNC_MODEL.md); this plan says how it maps to files, interfaces, SQL and tests.

## Where the implementation differs from this plan

- **An eighth SQL function, `holds_event_claim`.** It locks the event row and checks the claim. Both `apply_subscription_snapshot` and `link_customer` call it. It has the same grants as the other seven.
- **Fixture directories:** `fixtures/2025-03-31.basil/` and `fixtures/2025-02-24.acacia/`, the last version before basil, in place of 2024-06-20. All are synthetic. `tests/fixtures.test.ts` replays them, which adds 3 tests beyond §6.
- **Toolchain:**
  - Node ≥ 22.12 (`vitest` 5 requires it) and TypeScript 6.0.3 (`typescript-eslint` does not support 7 yet).
  - Postgres 17 (embedded locally, and the service container in CI).
  - Dev dependencies are pinned to releases at least about two weeks old.
- **Size:** `src/` is 650 lines; `process-event.ts` is 226, below the 250–350 estimate.
- **Mutation check:** each correctness mechanism was broken on purpose (8 mutations) and at least one test failed for each.

## 1. Files

Line counts are estimates, not limits I will compress to meet.

| File | Purpose | Est. lines |
|---|---|---|
| `src/core/process-event.ts` | `processEvent()`, the three handlers, the CAS retry loop, `toSnapshot()` payload mapping | 270–330 |
| `src/core/types.ts` | Minimal structural Stripe shapes we read, `SyncStore`, `SubscriptionRetriever`, `UserResolver`, `Logger`, results | 110–140 |
| `src/core/errors.ts` | `MissingFieldError`, `MappingError`, `ClaimLostError` | 25–35 |
| `src/policy/entitlements.ts` | EXAMPLE policy + `getEntitlement(store, userId, policy)` | 25–35 |
| `src/config/events.ts` | `IMPLEMENTED_EVENTS`, `DEFAULT_ENABLED_EVENTS`, validation | 20–30 |
| `src/config/user-mapping.ts` | Default resolver: `client_reference_id` → link table → user id | 35–50 |
| `src/adapters/sql-functions.ts` | `SyncStore` built from one `call(fn, args)` function (shared by both DB adapters) | 50–70 |
| `src/adapters/postgres.ts` | `call` via a query executor `{ query(text, values) }` (pg `Pool`/`Client` fit) | 20–30 |
| `src/adapters/supabase.ts` | `call` via `{ rpc(fn, args) }` (supabase-js client fits) | 20–30 |
| `src/adapters/nextjs.ts` | Route handler: raw body, `constructEvent`, `processEvent`, status → `Response` | 30–40 |
| `src/adapters/stripe.ts` | `fromStripeSdk(stripe)` → `SubscriptionRetriever` | 10–15 |
| `src/index.ts` | Public exports | 15–25 |
| **src/ total** | | **~630–830** |

If `src/` lands above 800 lines it will be because of the snapshot mapping and the store adapter; I will report the real number rather than squeeze code.

Outside `src/`:

- `sql/schema.sql`: plain Postgres tables, constraints, 7 functions. `sql/supabase.sql`: RLS + grants only.
- `tests/` (see §6), `tests/support/` (fake Stripe, DB helpers, Supabase role shim), `fixtures/`.
- `examples/nextjs-supabase/`: own `package.json`, `app/api/stripe/webhook/route.ts` (`runtime = 'nodejs'`), `lib/billing.ts` (wiring + `getEntitlement` call), `.env.example`, README. No pages, no auth. Depends on the module via `file:../..`; never imported by `src/`.
- `README.md`, `docs/SYNC_MODEL.md`, `KNOWN_LIMITATIONS.md`, `SECURITY.md`, `.env.example`, `docker-compose.yml` (Postgres 16 for tests), `.github/workflows/ci.yml` (Postgres service container), `eslint.config.js`, `tsconfig.json`, `vitest.config.ts`.

## 2. Dependencies

**Runtime: none.** The core and adapters use structural interfaces, so they need no SDK at runtime. The app passes in its own `stripe`, `pg` or supabase-js instance. `crypto.randomUUID` and `Request`/`Response` are Node globals (Node ≥ 20).

**Dev only**, each for one reason: `typescript`; `vitest` (test runner); `pg` + `@types/pg` (real Postgres in tests); `stripe` (real `constructEvent` and `generateTestHeaderString` in signature tests, and type-checking that `fromStripeSdk` accepts the real SDK); `eslint` + `typescript-eslint`; `@types/node`. The example app additionally has `next`, `react`, `react-dom`, `@supabase/supabase-js`, `stripe`.

## 3. Interfaces (core)

```ts
// types.ts (abridged)
export interface StripeEventLike { id: string; type: string; data: { object: unknown } }

export interface SubscriptionRetriever {             // extension: the app's Stripe client
  retrieveSubscription(id: string): Promise<unknown> // parsed by toSnapshot(), never trusted blindly
}

export interface Snapshot {                          // what apply_subscription_snapshot receives (jsonb)
  user_id: string; customer_id: string; status: string;
  price_id: string; product_id: string; quantity: number | null;
  current_period_start: number; current_period_end: number;   // unix seconds
  cancel_at_period_end: boolean;
  cancel_at: number | null; canceled_at: number | null; ended_at: number | null; trial_end: number | null;
}

export type ClaimResult  = 'claimed' | 'done' | 'busy';
export type FinalStatus  = 'succeeded' | 'failed' | 'skipped' | 'ignored';
export type ApplyResult  = 'applied' | 'conflict' | 'claim_lost' | 'tombstoned' | 'user_mismatch';
export type LinkResult   = 'linked' | 'already_linked' | 'mismatch' | 'claim_lost';

export interface SyncStore {                         // extension 3: persistence
  claimEvent(eventId: string, eventType: string, token: string): Promise<ClaimResult>;
  finishEvent(eventId: string, token: string, status: FinalStatus, error?: string): Promise<boolean>;
  getRevision(subscriptionId: string): Promise<number>;            // 0 if no row
  applySnapshot(subscriptionId: string, expectedRevision: number, token: string,
                eventId: string, snapshot: Snapshot): Promise<ApplyResult>;
  linkCustomer(customerId: string, userId: string, eventId: string, token: string): Promise<LinkResult>;
  findUserByCustomer(customerId: string): Promise<string | null>;
  listSubscriptionsForUser(userId: string): Promise<StoredSubscription[]>;
}

export interface UserResolver {                      // extension 2
  userFromCheckoutSession(session: CheckoutSessionLike): string | null;    // null/invalid → event fails
  userForSubscription(sub: { id: string; customerId: string }, store: SyncStore): Promise<string>; // throws MappingError
}

export interface Logger { info?(msg: string, f?: object): void; warn?(...): void; error?(...): void } // extension 5

export interface SyncDeps {
  store: SyncStore; stripe: SubscriptionRetriever;
  users?: UserResolver;                              // default: config/user-mapping.ts
  enabledEvents?: readonly ImplementedEvent[];       // extension 4, default: all implemented
  logger?: Logger;
}

// process-event.ts
export function processEvent(event: StripeEventLike, deps: SyncDeps):
  Promise<{ httpStatus: 200 | 409 | 500; outcome: string }>;

// policy/entitlements.ts (extension 1)
export type EntitlementPolicy<E = 'active' | 'none'> = (rows: StoredSubscription[]) => E;
export const exampleEntitlementPolicy: EntitlementPolicy;   // 'active' if ANY row active|trialing
export function getEntitlement<E>(store: SyncStore, userId: string, policy?: EntitlementPolicy<E>): Promise<E>;

// adapters
export function createNextWebhookHandler(o: { stripe: { webhooks: { constructEvent(raw: string, sig: string, secret: string): unknown } };
  webhookSecret: string; sync: SyncDeps }): (req: Request) => Promise<Response>;
export function postgresStore(db: { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }): SyncStore;
export function supabaseStore(client: { rpc(fn: string, args: object): PromiseLike<{ data: unknown; error: { message: string } | null }> }): SyncStore;
export function fromStripeSdk(stripe: { subscriptions: { retrieve(id: string): Promise<unknown> } }): SubscriptionRetriever;
```

Not configurable (hard-coded, per the brief): revision check, claim token/takeover and its 120 s threshold, first-insert handling, tombstones, retry count and jitter, retry transitions.

### `toSnapshot(sub, userId)` mapping rules

- `customer`: string or expanded `{ id }`.
- `item = items.data[0]` (required). `price_id = item.price?.id ?? item.plan?.id`. `product_id` from `item.price?.product ?? item.plan?.product`, as ID string or expanded `{ id }`.
- `current_period_start/end`: `item.current_period_*` first, then legacy top-level `sub.current_period_*`.
- Required: `id`, `customer`, `status`, `price_id`, `product_id`, both period fields, `cancel_at_period_end` (boolean). Any missing → `MissingFieldError(field)` → event `failed`, 500, no write. Optional fields default to `null`.

### HTTP mapping

| Situation | Status | `stripe_events` |
|---|---|---|
| Bad/missing signature | 400 | untouched |
| New event processed (write or link) | 200 | `succeeded` |
| Handled type, nothing to do (no subscription id, non-subscription checkout, tombstoned) | 200 | `skipped` |
| Unknown or disabled type | 200 | `ignored` |
| Duplicate of succeeded/skipped/ignored | 200 | unchanged |
| Duplicate while another worker holds a fresh claim | 409 | unchanged |
| Missing field, missing/invalid mapping, Stripe error, retries exhausted, `user_mismatch`, deleted-but-not-terminal | 500 | `failed` |
| Claim lost (apply or finish) | 500 | unchanged (owned by the other worker) |

## 4. Schema (`sql/schema.sql`, plain Postgres)

```sql
create table public.stripe_events (
  event_id   text primary key,
  event_type text not null,
  status     text not null check (status in ('processing','succeeded','failed','skipped','ignored')),
  claimed_by uuid,
  claimed_at timestamptz,
  attempts   integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.stripe_customer_links (
  stripe_customer_id text primary key,       -- one customer → one user; a user may have several customers
  user_id            text not null,          -- text so any app id type fits; Supabase compares with auth.uid()::text
  linked_by_event    text not null,
  created_at         timestamptz not null default now()
);

create table public.stripe_subscriptions (
  subscription_id      text primary key,     -- the unique constraint the first insert relies on
  user_id              text not null,
  customer_id          text not null,
  status               text not null,        -- no CHECK: a new Stripe status should not break writes
  price_id             text not null,
  product_id           text not null,
  quantity             integer,
  current_period_start timestamptz not null,
  current_period_end   timestamptz not null,
  cancel_at_period_end boolean not null,
  cancel_at timestamptz, canceled_at timestamptz, ended_at timestamptz, trial_end timestamptz,
  tombstoned_at        timestamptz,          -- set once status is terminal; row is then frozen
  revision             integer not null check (revision > 0),
  last_event_id        text not null,
  updated_at           timestamptz not null default now()
);
create index on public.stripe_subscriptions (user_id);
```

Functions (all `language plpgsql`, `security invoker`, `set search_path = public`; tables referenced schema-qualified):

| Function | Returns | Contract |
|---|---|---|
| `claim_event(p_event_id, p_event_type, p_token)` | `'claimed'\|'done'\|'busy'` | `INSERT ... ON CONFLICT DO UPDATE ... WHERE status = 'failed' OR (status = 'processing' AND claimed_at < now() - interval '120 seconds')`; bumps `attempts`. If nothing returned, reads status → `done` or `busy`. |
| `finish_event(p_event_id, p_token, p_status, p_error)` | boolean | `UPDATE ... WHERE event_id = $1 AND claimed_by = $2 AND status = 'processing'`. |
| `get_subscription_revision(p_subscription_id)` | integer | `coalesce(revision, 0)`. |
| `apply_subscription_snapshot(p_subscription_id, p_expected_revision, p_claim_token, p_event_id, p_snapshot jsonb)` | text (ApplyResult) | Lock event row `FOR UPDATE` and check claim → upsert as in SYNC_MODEL step 3 → on no write, classify. One transaction (the function call). |
| `link_customer(p_customer_id, p_user_id, p_event_id, p_claim_token)` | text (LinkResult) | Claim check, then `INSERT ... ON CONFLICT DO NOTHING`; if existing row has another user → `mismatch`. |
| `find_user_for_customer(p_customer_id)` | text or null | |
| `list_user_subscriptions(p_user_id)` | jsonb array | Rows for the user (tombstoned included; the policy decides). |

Lock order is always event row, then subscription/link row, so the functions cannot deadlock each other.

Insert path note: the brief asks for `INSERT ... ON CONFLICT` with a revision condition. That is used as is; the inserted revision is `p_expected_revision + 1`, which is 1 for a first insert. `expected > 0` with no row cannot happen because rows are never deleted.

## 5. `sql/supabase.sql` (RLS and grants only)

- `alter table ... enable row level security` on all three tables.
- `revoke all on` the three tables `from public, anon, authenticated`; `grant select, insert, update on` them `to service_role` (no `delete`: rows are never deleted).
- `grant select on stripe_subscriptions to authenticated` + policy `using (user_id = (select auth.uid())::text)`. No policies on the other two tables, so `authenticated` and `anon` read nothing there.
- `revoke execute on function` each of the 7 `from public, anon, authenticated`; `grant execute ... to service_role`.
- No `SECURITY DEFINER`: `service_role` already has the table privileges it needs.

The README claim about new public tables no longer being auto-granted from 30 Oct 2026 will be checked against current official Supabase docs and cited, or explicitly marked unverified.

## 6. Tests

Every test except the policy unit tests asserts the resulting database state. Real Postgres via `DATABASE_URL`. The test setup refuses to run unless the database name contains `test`, because it drops and recreates the schema. Signed requests go through `createNextWebhookHandler` with the real `stripe` SDK for signing and verification, and a `FakeStripe` for retrieval.

`FakeStripe`: holds subscription state per id; `retrieveSubscription` copies the state *at call time*, then waits on an optional gate (`fake.hold(id)` → `{ reached, release }`), so interleavings are forced rather than timed. Concurrency tests use two separate `pg.Client` connections. The behaviour tests run twice: through `postgresStore` and through `supabaseStore` with an `rpc` stub that forwards to the same Postgres (this checks argument names and result parsing, not supabase-js itself).

| Test | Forces | Asserts in DB |
|---|---|---|
| `bad_signature_writes_nothing` | tampered body, wrong secret, missing header | 400 ×3, all tables empty |
| `duplicate_event_does_not_apply_twice` | same event twice, sequentially | revision 1, attempts 1, `succeeded` |
| `concurrent_duplicate_deliveries_apply_once` | same event on two connections, `Promise.all` | revision 1, one claim, `succeeded` |
| `duplicate_while_processing_is_not_acknowledged_then_succeeds_after_first_finishes` | hold first fetch; redeliver | 2nd = 409 and row still `processing`; after release 200; a 3rd delivery = 200, revision 1 |
| `concurrent_first_insert_creates_one_subscription` | two events, both read r=0, both fetches held then released | one row, revision 2, both events `succeeded` |
| `overlapping_fetches_never_overwrite_a_newer_committed_write` | A fetches old state (held), B fetches new and commits, release A | A's first apply was a conflict; final row = new state |
| `conflict_retries_exhausted_leaves_event_failed_and_retryable` | each fetch bumps revision from another connection | `failed`, row not written by this event; redelivery without interference → `succeeded` |
| `stale_worker_cannot_apply_after_claim_takeover` | A held; claim backdated; B takes over and finishes; release A | A gets 500, row = B's write, event owned by B, `succeeded` |
| `expired_worker_cannot_mark_another_workers_attempt` | store wrapper holds A before `finishEvent`; B takes over (held) | A's finish affects 0 rows, event still `processing` by B; B finishes `succeeded` |
| `crash_after_insert_is_recovered_on_retry` | claim inserted then abandoned | redelivery = 409 while fresh; after backdating claim, 200, row written, attempts 2 |
| `missing_required_field_fails_without_state_change_then_retry_succeeds` | fetch lacks price | 500, `failed`, row unchanged; fixed fetch → 200, revision +1 |
| `deleted_subscription_is_not_resurrected` | after cancel, late `subscription.created` whose fetch returns stale `active` | row stays `canceled`, revision unchanged, event `skipped` |
| `deleted_event_with_non_terminal_fetch_is_retried` | `.deleted` event, fetch still `active` | `failed`, row unchanged |
| `cancellation_does_not_revoke_another_active_subscription` | user with 2 subs, cancel one | `getEntitlement` = `active` |
| `invoice_new_and_old_shape` | `invoice.subscription` and `parent.subscription_details.subscription`; and neither | row written both ways; neither → `skipped`, no row |
| `period_fields_new_and_legacy_location` | periods on item vs top-level | stored periods match |
| `product_as_id_string` | product as string and as expanded object | `product_id` stored |
| `downgrade_and_cancellation` | price change, `cancel_at_period_end`, then deleted | price updated; still active; then canceled + tombstoned, entitlement `none` |
| `entitlement_reflects_latest_committed_rows` | read while a newer fetch is held | entitlement from committed rows only, updates after commit |
| `subscription_before_checkout_link_fails_then_succeeds_after_link` | `subscription.created` before `checkout.session.completed` | `failed`, no row; after checkout, retry → row with correct `user_id` |
| `checkout_without_client_reference_id_fails_and_writes_nothing` | | `failed`, no link |
| `customer_link_is_never_reassigned` | second checkout, same customer, different user | `failed`, link unchanged |
| `subscription_owner_never_changes` | custom resolver returns another user | `failed` (`user_mismatch`), `user_id` unchanged |
| `unknown_and_disabled_events_are_acknowledged_as_ignored` | unknown type; implemented type not enabled | 200, `ignored`, no subscription rows |
| Permissions (Supabase role shim on plain Postgres): `other_users_subscription_not_readable`, `anon_cannot_read`, `authenticated_cannot_write`, `function_not_executable_by_authenticated` | `SET ROLE` + `request.jwt.claims` | row counts / permission errors |
| `entitlements.test.ts` (unit) | | active/trialing → active; past_due, canceled, incomplete, empty → none; any-of rule |

The role shim (`tests/support/supabase-shim.sql`) creates `anon`, `authenticated`, `service_role` (BYPASSRLS) and an `auth.uid()` that reads `request.jwt.claims`. It is labelled as a stand-in, and the compatibility table will say RLS was tested against it, not against a Supabase project.

## 7. Fixtures

`fixtures/2025-03-31.basil/` (items-level periods, `invoice.parent`) and `fixtures/2024-06-20/` (top-level periods, `invoice.subscription`). All hand-written, each with `"_provenance": "synthetic"` and a `_models` note naming the documented shape it follows. No Stripe account is available here, so none will be labelled `stripe-generated`. Before naming the directories I will confirm those API version strings against Stripe's changelog.

## 8. Docs to write after approval

README (does / does not, 15-minute reading map, five extension points, What to change / What NOT to touch with links to code and tests, compatibility table), KNOWN_LIMITATIONS.md, SECURITY.md (reference implementation, not an audit; client_reference_id is only trustworthy when the Checkout Session is created server-side, since Payment Links and the pricing table let the client supply it, to be confirmed against Stripe docs), `.env.example`. The README will only state guarantees that have a test in §6.

## 9. Verification

`npm run lint`, `typecheck` (module and example), `test`, `build`, then a fresh clone into a temp directory using only the README setup. CI workflow will be committed but has not run until the repo is pushed; the compatibility table will say so.

## 10. Decisions to confirm

1. **No Docker or Postgres on this machine.** The tests need a real Postgres server with multiple connections. Options: (a) you install Docker Desktop or Postgres 16 and I use `docker compose` / `DATABASE_URL`; (b) I add `embedded-postgres` as a dev dependency (downloads real Postgres binaries) for local runs only. PGlite is out, since it is single-connection.
2. `user_id` is `text` (fits UUIDs and other id types). Supabase RLS compares `auth.uid()::text`.
3. "Maximum 5 retries" read as 6 attempts total.
4. Additions beyond the brief, each with a test: `tombstoned` and `user_mismatch` apply results; failing a `.deleted` event whose fetch is not yet terminal; link mismatch fails instead of overwriting.
5. Store reads (`get_subscription_revision`, `find_user_for_customer`, `list_user_subscriptions`) are SQL functions too, so both adapters are a single `call(fn, args)` and the supabase adapter needs only `rpc`. Authenticated users can still read their own rows directly from the table through RLS.
6. Only `items.data[0]` is stored (price/product/quantity/periods). Multi-item subscriptions are a listed limitation.
7. A subscription Stripe returns 404 for fails and is retried; this is listed as a limitation, not handled.
