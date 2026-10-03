# ThrottlFlow 0.2: architecture, API and operations

This guide describes the upgraded repository. Version 0.2.0 is prepared locally and requires a separate npm publication. Nothing in the package requires a ThrottlFlow-hosted backend, an account with the author or an API key issued by the author.

## 1. What it does

ThrottlFlow controls how much work one subject may start over time. A subject can be a user, tenant, authenticated API key, trusted IP address or an application-defined identifier. Your application calls `check(subject)` before performing protected work. An allowed result consumes quota; a denied result tells you when to try again. Store failures reject with errors instead of being confused with ordinary quota denials.

Typical uses include protecting login attempts, verification messages, public API routes, AI generation, file processing and outbound API calls. The package is a decision engine. It does not authenticate callers, queue their work, bill customers or defend your network against volumetric attacks.

## 2. Languages and tools

| Technology | Purpose |
| --- | --- |
| JavaScript / ES2022 | Runtime algorithms, stores, adapters and examples |
| TypeScript declaration files | Typed public API for TypeScript users; runtime stays JavaScript |
| SQL / PostgreSQL | Persistent shared quotas and transactional row locking |
| Lua / Redis | Atomic shared decisions with low network overhead |
| Node.js 22+ | Supported server runtime |
| esbuild | Bundles runtime code into CommonJS and portable modules |
| npm | Installs dependencies, runs checks, creates the publishable tarball |
| Node test runner / strict assertions | Behaviour and integration tests |
| Supertest, Express, Fastify, Koa | Framework integration testing |
| PGlite | Embedded PostgreSQL engine for local SQL/migration checks |
| Fengari | Executes the actual Lua script against a deterministic command model |
| GitHub Actions | Node version matrix plus real Redis/PostgreSQL integration jobs |

Frameworks and database clients are supplied by the consuming application. Redis clients and framework packages used by tests are development dependencies, not runtime dependencies installed into every user's app. `pg` remains an optional peer dependency for compatibility.

## 3. Files and responsibilities

| File | Responsibility |
| --- | --- |
| `src/index.js` | Main public exports, including Node database stores |
| `src/core.js` | Portable exports without database driver or Node crypto imports |
| `src/factory.js` | Option/key/cost validation, store selection, timeout/abort handling, metrics and observer hooks |
| `src/algorithms.js` | Constant-size token bucket, GCRA and approximate counter calculations; decision construction and configuration signatures |
| `src/memory.js` | Bounded in-process state; exact weighted event lists and cleanup |
| `src/redis.js` | Atomic Lua script, server time, hashed key layout, cluster hash tags, cached-script execution and TTL expiration |
| `src/postgres.js` | Transactions, per-key locks, migrations, exact event queries, constant-state updates and batched cleanup |
| `src/schema.js` | Embedded SQL matching the numbered migration files |
| `src/adapters.js` | HTTP/framework adapters, failure policy and response headers |
| `src/policies.js` | Scoped keys, dynamic plan resolution, sequential composition and storage circuit breaker |
| `src/control.js` | Abort and timeout races with listener/timer cleanup |
| `src/errors.js` | Capacity, policy, store and timeout error classes |
| `src/index.d.ts` | ESM API declarations; build derives corresponding CommonJS declarations |
| `scripts/build.js` | Checks SQL parity and emits compiled modules, wrappers, declarations and source maps |
| `scripts/benchmark-stores.js` | Native database latency checks for a hot key and many keys |
| `migrations/001-initial.sql` | Original tables and indexes |
| `migrations/002-weighted-algorithms.sql` | Weighted event costs, new algorithms and scalar state |
| `examples/` | Runnable Express, Redis, PostgreSQL and cleanup demonstrations |
| `test/` | Algorithms, HTTP adapters, published imports/types and storage contracts |
| `.github/workflows/throttl.yml` | Real service tests on Node 22, 24 and 26 |

## 4. One request from beginning to end

1. The host application authenticates a caller and identifies a policy.
2. An adapter or application code selects a trusted subject key and operation cost.
3. `limiter.check()` validates the key, cost and optional deadline.
4. The selected store reads the current state atomically for that subject.
5. The algorithm removes or ignores expired usage, refills capacity or updates its virtual schedule.
6. If sufficient capacity exists, the store consumes the requested units. Otherwise it preserves the quota.
7. The store returns `{ allowed, limit, remaining, resetAt, retryAfterMs }`.
8. The limiter updates local metrics and invokes optional hooks without waiting for them.
9. An HTTP adapter forwards accepted requests, returns 429 for denied requests or applies the configured storage-error policy.
10. The host application performs its protected work only after an allowed decision.

Checking first protects expensive operations but means failed application work still consumes the attempted request. The package does not automatically refund those attempts.

## 5. Creating a limiter

```js
import throttl from 'throttlflow';
const limiter = throttl({ limit: 10, windowMs: 60_000 });
await limiter.check('user-123');
await limiter.check('user-123', { cost: 2 });
await limiter.reset('user-123');
await limiter.cleanup();
console.log(limiter.stats());
```

All public limiter methods that access a store return Promises. `stats()` is synchronous. `limiter.store` exposes the selected store for store-specific administration and memory capacity inspection.

Common options:

| Setting | Meaning |
| --- | --- |
| `store` | A supplied shared store; omitted means a new memory store for this limiter |
| `maxKeys` | Default memory active-key ceiling, 100,000 |
| `maxEvents` | Default memory exact-window retained-event ceiling, 1,000,000 |
| `clock` | Memory-mode clock function; default `Date.now`; useful for deterministic tests |
| `timeoutMs` | Maximum caller waiting time; overridable per check |
| `onDecision` | Optional decision observer |
| `onError` | Optional check-error observer |
| `onHookError` | Optional observer-failure reporter |

When you explicitly construct `memoryStore({ maxKeys, maxEvents, clock })`, those store-owned limits and clock take precedence over limiter-level memory settings. Memory settings do not size PostgreSQL or Redis.

Keys are nonempty strings of at most 512 characters. `subjectKey('tenant-id', 'user-id')` uses an unambiguous JSON tuple instead of unsafe string concatenation. It does not authenticate those strings. SHA-256 storage hashing keeps raw identifiers out of Redis/PostgreSQL keys, but hashing is not encryption and predictable identifiers can be guessed.

## 6. Algorithm semantics

### Exact sliding window

```js
throttl({ algorithm: 'sliding-window', limit: 5, windowMs: 60_000 });
```

Counts accepted quota units whose timestamps are strictly greater than `now - windowMs`. Events exactly on the cutoff expire. Each accepted check creates one weighted event; denied checks create none. If a new cost requires several old events to expire, retry calculation waits until enough cumulative cost has expired. `resetAt` identifies the earliest live event's expiration, which may release fewer units than a large requested cost needs. Use `retryAfterMs` for that requested cost.

Default limit ceiling: 10,000 units per configured window. A larger `maxSlidingWindowLimit` is an explicit configuration choice. Exactness requires retaining event history, and PostgreSQL still writes one event per accepted check. Larger ceilings increase resource demand.

### Token bucket

```js
throttl({ algorithm: 'token-bucket', capacity: 20, refillRate: 5, refillIntervalMs: 1000 });
```

Starts with 20 tokens and replenishes five per second, including fractional tokens. An operation consumes its integer cost. Balance cannot exceed capacity. A denial reports the time required to refill enough units for that cost. `limit` in its decision is burst capacity and `resetAt` means estimated full-bucket time.

A bucket with capacity 100 and refill 100/minute can initially admit 100 requests and then admit replenished requests during that minute. It is not identical to a strict maximum of 100 in every rolling minute.

### GCRA

```js
throttl({ algorithm: 'gcra', limit: 60, windowMs: 60_000, burst: 5 });
```

Maintains a theoretical arrival time, advancing it by `cost * windowMs / limit` when a check is accepted. A burst allowance permits several requests immediately, then enforces recovery spacing. The example permits five immediate units and replenishes about one unit per second. Burst defaults to one.

Decision `limit` and `remaining` describe burst units, not the average `limit/windowMs` setting. `resetAt` is the time when the virtual schedule has fully recovered. The requested cost cannot exceed burst capacity.

The virtual timestamp uses safe integer microseconds to prevent floating-point drift at modern Unix timestamps. Its interval is rounded upward to one microsecond, conservatively pacing rates that do not divide evenly. Configuration above one unit per microsecond is rejected; this numeric ceiling is not a measured throughput claim. Extremely large virtual schedules outside safe integer range are rejected rather than silently admitting traffic.

### Approximate sliding-window counter

```js
throttl({ algorithm: 'sliding-window-counter', limit: 100, windowMs: 60_000 });
```

Keeps the current fixed-bucket count and previous bucket's count. Estimated live usage is `current + previous * remainingFractionOfCurrentWindow`. It uses constant-size state, but does not know individual request times in the previous bucket. Bursts can cause overestimation or underestimation. Do not select this algorithm when an exact rolling guarantee is required. `resetAt` reports the next bucket boundary; `retryAfterMs` follows the estimate and may span more than one boundary for large costs.

## 7. Memory storage

```js
import { memoryStore } from 'throttlflow';
const store = memoryStore({ maxKeys: 10_000, maxEvents: 100_000 });
const limiter = throttl({ limit: 5, windowMs: 60_000, store });
console.log(store.stats());
```

Each memory store owns a Map. Exact windows maintain arrays with a moving head index and periodic compaction; scalar algorithms keep small state objects. Capacity checks sweep expired entries before rejecting new state. Active entries are never evicted to admit a different subject. Backward clock adjustments are clamped so they cannot reopen a quota.

Share the same memory store object only for identical policies or differently scoped keys. Conflicting configurations for an existing key raise a configuration error. Processes, workers, separate limiter/store objects and serverless instances do not share memory.

## 8. Redis storage

Redis users supply their own client and Redis endpoint. With node-redis, pass `{ client, namespace }`. With ioredis, add `clientType: 'ioredis'`. With a compatible executor, pass `{ execute(script, keys, args), namespace }`; the function must execute the supplied script atomically on Redis.

For each namespace/subject tuple the adapter derives a SHA-256 hash tag. The metadata hash and exact-window sorted set have the same `{hash-tag}`, so Redis Cluster routes both to one slot. Scalar algorithms only retain the hash. Exact windows also retain a sorted set, with timestamp scores and unique sequence/cost members.

Lua reads Redis `TIME`, clamps backward time, validates the stored policy signature, expires old exact events, decides and writes state. Redis does not interleave another client's commands during the script. Cache-capable clients use `EVALSHA`; only `NOSCRIPT` triggers a fallback to `EVAL`. A network timeout can be ambiguous, so it is not retried.

Per-key TTLs expire idle data. `cleanup()` returns zero because Redis manages expiration. Reset deletes only the subject's two structures. The adapter never scans or flushes the whole database.

Production responsibilities: provide a reachable Redis service, sensible client connection/retry configuration, TLS/credentials where appropriate, enough memory, persistence if needed, and a no-eviction policy for strict quotas. Eviction, failover or disabled persistence can reset recent quotas. The package cannot prevent administrative deletion or state loss.

## 9. PostgreSQL storage and concurrency

`throttl_keys` is the shared policy/state table. Its primary key is `(namespace, key_hash)`. It contains a policy configuration hash, algorithm, expiry, last-seen timestamp and scalar JSON state. Legacy token columns remain readable during schema upgrade. `throttl_window_events` contains accepted exact-window timestamps and costs with a cascading foreign key. Indexes support subject/time queries and expiration lookup.

A request opens a transaction, ensures the subject row exists, then reads it using `FOR UPDATE`. Another request for that same namespace/key waits for the first transaction. Once the first commits, the waiting transaction sees its consumed capacity. Different subject rows can proceed concurrently. A transaction alone would not prevent simultaneous reads of the same previous quota; the row lock provides that coordination.

Token bucket, GCRA and approximate counter update one subject row. Exact mode queries the sum of live event costs and inserts one accepted event. Denials needing weighted recovery inspect ordered cumulative costs. Cleanup happens separately instead of deleting expired events on every exact check.

`timeoutMs` applies a transaction-local PostgreSQL statement timeout, not a single deadline for all statements combined. Configure `connectionTimeoutMillis` on the caller-owned pool, and optionally a limiter-level total wait timeout. If rollback fails, the connection is released with the rollback error so the pool discards it.

### Migrations

`store.migrate()` obtains a transaction-scoped advisory migration lock, creates a migration ledger, applies missing numbered migrations and records their versions. Concurrent deployment processes cannot race the migration sequence. The public `postgresMigrations` export exposes the numbered SQL for controlled migration tooling. `postgresSchema` exposes the combined schema SQL.

Run migrations with deployment credentials before starting runtime instances. Runtime credentials need table access, not schema-creation privileges. Upgrade every writer before using weighted costs or new algorithms. Running old and new writers together can ignore weights or interpret new state incorrectly.

### Cleanup

Schedule `store.cleanup()` every minute as a starting point and adjust to traffic/retention needs. It selects up to `cleanupBatchSize` expired subjects with `FOR UPDATE SKIP LOCKED`, deletes them and lets the foreign key delete their events. It also locks a bounded set of active exact-window subjects with stale events and prunes those events. It skips subjects currently being decided so cleanup cannot remove state halfway through a decision.

`cleanup()` returns the number of expired subject rows removed; it does not include stale event rows. Repeated runs drain an expiration backlog. A batch may temporarily skip a busy subject, so a zero return is not a proof that no eligible rows exist anywhere. Monitor table sizes and schedule recurring maintenance.

Time partitioning is a deployment-specific future optimization rather than an automatic schema rewrite in this release. The current migration does not partition an existing event table or promise constant storage for exact windows.

## 10. HTTP adapters

All adapters use the same `key`, optional `cost`, `headers`, `signal` and `onStoreError` options. Key and cost functions may be asynchronous. Authentication and key-extraction errors do not become fail-open approvals; they propagate to application error handling. Quota denial is 429. Capacity or storage failure is 503 by default. An explicit failure policy can allow traffic when storage is unavailable.

Express: `limiter.middleware(options)` or `expressMiddleware(limiter, options)`.

Fastify: `app.addHook('onRequest', fastifyHook(limiter, options))`. If identity comes from a later authentication hook, choose a later lifecycle stage or authenticate before the rate-limit hook.

Koa: `app.use(koaMiddleware(limiter, { key: ctx => ctx.state.user.id }))` after authentication middleware.

Fetch/Next.js:

```js
export const POST = fetchHandler(limiter, {
  key: async request => (await authenticate(request)).userId,
  signal: request => request.signal,
}, async (request, routeContext) => Response.json({ accepted: true }));
```

Allowed responses retain status, body and existing headers, with quota headers added. Denied requests do not invoke the wrapped handler. Authentication comes from application code, not a trusted-looking user-supplied header.

Hapi: `await server.register(hapiPlugin(limiter, { key: request => request.auth.credentials.id }))`. It runs in `onPreHandler` and adds headers during `onPreResponse`.

Nest:

```js
import { HttpException } from '@nestjs/common';
const guard = nestGuard(limiter, {
  key: request => request.user.id,
  exception: (status, body) => new HttpException(body, status),
});
app.useGlobalGuards(guard);
```

The Nest adapter receives an HTTP execution context and supports Express/Fastify response header methods. It requires your exception factory and does not import Nest into every consumer. Place authentication before the guard.

`headers: false` disables quota fields while retaining denial `Retry-After`. Retry-After uses seconds, rounded up to at least one. Legacy reset is an epoch timestamp; draft-style reset is seconds from current time. These headers are advisory and must not be treated as an authorization decision.

## 11. Metrics, errors and hooks

`stats()` returns checks, allowed, denied, errors, hookErrors, total durationMs and averageDurationMs. These counters describe checks through that limiter instance. They do not aggregate replicas or store health automatically; validation errors before execution are not counted as attempted store checks. Reset and cleanup are outside the decision counters.

`onDecision({ key, cost, algorithm, decision, durationMs })` supports application observability. `onError({ key, cost, error })` receives execution failures. Hooks may return promises, but the request does not wait for them. Synchronous throws and rejected hook promises increase hookErrors and can call onHookError. Metrics failures cannot reverse an already committed quota decision.

Use bounded labels such as algorithm, outcome and route. Do not put every user ID in Prometheus labels; that creates excessive cardinality and exposes identifiers. Aggregate instance metrics in your existing monitoring system. There is no exporter server hosted by the package author.

Errors:

| Error | Meaning |
| --- | --- |
| `ThrottlCapacityError` | Local active-key/event or dynamic-policy capacity exhausted |
| `ThrottlConfigurationError` | Existing state has different policy settings or a custom store does not support weights |
| `ThrottlStoreError` | Database/client failure or invalid store response |
| `ThrottlTimeoutError` | Caller waiting deadline expired; extends store error |
| `TypeError` / `RangeError` | Invalid key, settings or request cost |
| Abort reason | Caller signal aborted |

## 12. Circuit breaker

```js
const rawStore = redisStore({ client, namespace: 'api-v1' });
const store = circuitBreakerStore(rawStore, { failureThreshold: 5, cooldownMs: 10_000 });
const limiter = throttl({ algorithm: 'token-bucket', capacity: 100, refillRate: 100, refillIntervalMs: 60_000, store });
```

After consecutive storage failures the breaker opens and rejects checks locally. After cooldown, one probe checks whether storage recovered. A successful probe closes the circuit; a failed probe reopens it. Older in-flight successes cannot close a circuit opened after they started. Policy/capacity errors and caller aborts do not count as backend outages.

The breaker is per process. It does not create a shared fallback limit, buffer requests or automatically migrate quotas into memory. Run migrations on the raw PostgreSQL store before wrapping it.

## 13. Dynamic and hierarchical policies

```js
const plans = dynamicLimiter({
  maxPolicies: 10,
  resolve: user => ({
    id: `${user.plan}-v1`,
    key: subjectKey(user.tenantId, user.id),
    options: { limit: user.plan === 'pro' ? 1000 : 100, windowMs: 60_000, store: sharedStore },
  }),
});
await plans.check(authenticatedUser);
```

Cache policies by a small trusted plan/version ID, not a different policy ID for each request. The first resolved options construct the cached limiter; subsequent resolutions must agree on algorithm/quota values. New version IDs deliberately create new quotas, so uncontrolled version churn can bypass limits. Do not take plans or policy IDs directly from untrusted input. Ensure your resolver returns a stable store and operational settings; the cache retains the first limiter for an ID.

For hierarchical quotas:

```js
const combined = composeLimiters([
  { limiter: perUser, key: user => subjectKey(user.tenantId, user.id) },
  { limiter: perTenant, key: user => user.tenantId },
]);
const result = await combined.check(authenticatedUser);
```

It returns overall allowed, each attempted decision and a deniedIndex. Policies run sequentially and stop at the first denial. Earlier accepted policies remain consumed if a later policy denies or fails. There is no distributed transaction across independent stores. Choose rule order deliberately and account for this in business rules.

## 14. Timeouts and cancellation

`check(key, { timeoutMs, signal })` bounds waiting and rejects immediately when a signal is already aborted. A running operation may still commit if cancellation arrives after it has been sent. PostgreSQL checks the signal before starting work and after acquiring the subject lock; it also uses statement timeouts. Redis uses an adapter deadline but cannot undo a script already executing on the server.

After an ambiguous timeout, do not blindly retry the same quota check; it may consume a second charge. This release has no idempotency key or reservation/refund protocol. If the application's work can be cancelled, coordinate that separately from quota accounting.

## 15. Deployment responsibilities

You distribute code through npm. Your users provide their Node application, hosting, database/client connections, credentials, monitoring and cleanup schedule. You maintain releases, compatibility documentation and community support. No ThrottlFlow account or centralized API is involved.

For one process, memory is sufficient when restart resets are acceptable. For multiple instances, use the same Redis or PostgreSQL coordination store. For serverless, reuse clients where the platform permits and use external shared state. Size connection pools against total instances rather than giving every invocation a large private pool.

For multiple regions, one coordination store preserves a shared quota at the cost of distant network latency. Independent regional stores enforce independent regional quotas. Asynchronous replicas do not create strongly consistent global counters. This release makes no worldwide consistency promise across independent backends.

`throttlflow/core` bundles without Node built-ins for compatible browser/edge bundlers. Its database adapters are excluded. Edge deployments must supply a compatible atomic shared store; memory remains process-local. Client-side browser rate limiting is only a UX feature and cannot protect a server because users can bypass it.

Node 22+ remains the supported server baseline. CommonJS support solves module-format compatibility; it does not promise support for older end-of-life Node versions. The MIT license permits reuse, modification and redistribution under its conditions; it does not provide a hosted service or uptime SLA.

## 16. Testing and demonstrating it

From the project folder:

```sh
npm ci
npm run build
npm test
npm run test:package
npm run test:types
npm run test:embedded
```

For a live local demonstration:

```sh
node examples/express.js
```

In another PowerShell terminal:

```powershell
1..6 | ForEach-Object { curl.exe -i http://127.0.0.1:3000/api/demo }
curl.exe http://127.0.0.1:3000/metrics
```

The initial burst allows five calls and the sixth returns 429 with retry information when the requests are made together. Continuous refill means a delayed sixth call might be accepted later. Stop the demo with Ctrl+C.

Native storage tests:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/throttlflow_test'
$env:TEST_REDIS_URL = 'redis://127.0.0.1:6379'
npm run test:integration
```

Use disposable databases. Test namespaces are randomly generated and reset; no tests flush Redis or truncate an application's database. Native PostgreSQL tests exercise independent pools, row-lock timeouts, hashed subjects, changed-policy rejection and cleanup. Native Redis tests exercise independent clients and TTL expiry.

Embedded PostgreSQL tests run the real SQL engine locally with serialized transactions. They intentionally replace the migration advisory lock because the embedded test wrapper is already serial. The Lua command model runs the actual script with deterministic clocks and checks memory/Lua agreement. These tests cannot establish Redis server atomicity, PostgreSQL pool behaviour or network failure semantics; native CI tests provide that additional coverage.

Package tests validate callable require, ESM import, shared Node error-class identities, edge bundling and declaration files. CI also installs the packed tarball into a separate consumer. A release should wait for real service tests to pass, rather than count skipped tests as successful validation.

## 17. Remaining limits and deliberate trade-offs

- Exact windows require event history; constant-size algorithms solve a different accuracy/traffic problem.
- Memory cannot survive restarts or coordinate separate processes.
- Redis eviction, persistence settings and failover affect quota durability.
- A very hot subject serializes on its PostgreSQL row or Redis shard; unrelated subjects can distribute better.
- Dynamic policies retain their first limiter settings and a bounded cache; live configuration mutation needs explicit versioning.
- Composed policies are sequential and do not roll back earlier charges.
- Cancellation can stop waiting without undoing a committed check.
- There are no request idempotency keys, reservations or refunds in this release.
- There is no built-in exporter server, global dashboard, billing system or network DDoS shield.
- Portable core compatibility does not imply distributed edge storage is provided.
- PostgreSQL tables are not automatically repartitioned.
- Benchmarks depend on hardware, topology, key distribution and application work; there is no universal maximum requests-per-minute guarantee.

## 18. Useful principles to explain in an interview

Separation of concerns keeps algorithms, storage and HTTP adapters independent. Dependency injection lets applications supply clients and stores. Atomic updates and per-subject serialization solve races. Backpressure through explicit capacity errors avoids silently evicting active quotas. Bounded state makes scalar algorithms more suitable for high-volume traffic. Fail-closed defaults protect correctness during outages, with explicit availability trade-offs. Cache policy versioning prevents old and new settings from silently sharing incompatible state. Observer isolation keeps monitoring failures out of the critical path. Conditional exports widen package compatibility while a shared Node implementation avoids duplicate error classes between import and require.

An honest explanation includes both what is implemented and what infrastructure still determines: database reliability, network latency, persistence, cleanup scheduling and actual measured throughput.

## 19. References

- [Node.js conditional exports](https://nodejs.org/api/packages.html#conditional-exports)
- [Redis scripting atomic execution](https://redis.io/docs/latest/develop/programmability/eval-intro/)
- [Redis EVAL](https://redis.io/docs/latest/commands/eval/)
- [PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html)
- [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
