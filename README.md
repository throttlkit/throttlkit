# ThrottlFlow

A rate limiter that runs inside your application. Choose memory, Redis or PostgreSQL storage and exact sliding windows, approximate sliding counters, token buckets or GCRA. Includes weighted costs, TypeScript declarations, Express/Fastify/Koa/Fetch/Hapi/Nest adapters and operational hooks.

This repository prepares version **0.2.0**. Publishing it to npm is a separate release step; the code here does not change the currently published version automatically.

## Install

```sh
npm install throttlflow
```

Node.js 22+ is supported. Both import styles work:

```js
import throttl from 'throttlflow';
```

```js
const throttl = require('throttlflow');
```

## Start with an exact rolling limit

```js
const limiter = throttl({ limit: 10, windowMs: 60_000 });
const result = await limiter.check('authenticated-user-123');
// { allowed, limit, remaining, resetAt: Date, retryAfterMs }
```

Every accepted check uses one quota unit. Denied checks do not consume capacity. `reset(key)` clears one subject, `cleanup()` runs expiration maintenance, and `stats()` returns local counters. Reset is an administrative action; never expose it to untrusted users.

## Weighted operations

```js
const limiter = throttl({
  algorithm: 'token-bucket',
  capacity: 100,
  refillRate: 100,
  refillIntervalMs: 60_000,
});
await limiter.check('user-123', { cost: 10 });
```

Costs are positive integers and cannot exceed the policy capacity. A costly operation can consume ten units while a small operation consumes one. Costs count attempts, including operations whose application work later fails; this release does not implement reservations or refunds.

## Algorithm choices

| Algorithm | State per subject | Best fit | Behaviour |
| --- | --- | --- | --- |
| `sliding-window` | One event per accepted check | Login and verification protection | Exact rolling count |
| `sliding-window-counter` | Two counters | Approximate quotas with bounded state | Weights the previous fixed bucket; can over/under estimate real rolling traffic |
| `token-bucket` | Balance and refill timestamp | APIs and expensive operations | Allows a burst then refills continuously |
| `gcra` | One virtual timestamp | Smooth pacing with a controlled burst | Enforces average spacing with configurable burst capacity |

```js
const smooth = throttl({ algorithm: 'gcra', limit: 60, windowMs: 60_000, burst: 5 });
const approximate = throttl({ algorithm: 'sliding-window-counter', limit: 100, windowMs: 60_000 });
```

The original default remains exact sliding window. Its default configuration ceiling is 10,000 units per window; raise `maxSlidingWindowLimit` explicitly after sizing your store. The ceiling is not a throughput promise. Token bucket, GCRA and sliding counter do not use that ceiling.

## Shared Redis limits

```sh
npm install redis
```

```js
import { createClient } from 'redis';
import throttl, { redisStore } from 'throttlflow';

const client = createClient({ url: process.env.REDIS_URL, disableOfflineQueue: true });
client.on('error', error => console.error(error.message));
await client.connect();
const store = redisStore({ client, namespace: 'public-api-v1', timeoutMs: 2_000 });
const limiter = throttl({ algorithm: 'token-bucket', capacity: 100,
  refillRate: 100, refillIntervalMs: 60_000, store });
```

The adapter runs read/decide/write atomically in Lua using Redis time. Related keys share one Redis Cluster hash slot. Keys are SHA-256 hashed, inactive state expires automatically, and cached scripts use `EVALSHA` with a safe `NOSCRIPT` fallback. Ambiguous network failures are never automatically retried. For ioredis, pass `clientType: 'ioredis'`. A compatible custom `execute(script, keys, args)` function is also supported.

Use a shared Redis endpoint for a shared quota. Configure persistence when state must survive Redis restarts, use a no-eviction policy for strict quotas, and close the client during application shutdown. The package does not own the connection or host Redis.

## Persistent PostgreSQL limits

```sh
npm install pg
```

```js
import pg from 'pg';
import throttl, { postgresStore } from 'throttlflow';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL,
  max: 10, connectionTimeoutMillis: 3_000 });
const store = postgresStore({ pool, namespace: 'login-v1', timeoutMs: 5_000, cleanupBatchSize: 1_000 });
await store.migrate(); // Deployment/setup step.
const limiter = throttl({ limit: 5, windowMs: 60_000, store });
```

Numbered migrations upgrade the original 0.1 schema. Every decision locks one subject row with `FOR UPDATE`, reads the database clock, computes the quota, updates it and commits. Run `store.cleanup()` from a scheduled job: expired subjects are deleted in batches and stale events belonging to active exact windows are pruned under the same row locks. Exact checks query only live events and do not delete old events on every request.

Use a stable, separate namespace for each policy. Changing configuration requires a new namespace/version or an intentional state reset. Run migrations before upgraded instances start, and avoid mixed 0.1/0.2 writers for new algorithms or weighted costs. The application owns the pool and calls `pool.end()` during shutdown.

## Express

```js
app.use('/api', limiter.middleware({
  key: request => request.user.id,
  cost: request => request.path === '/generate' ? 10 : 1,
  onStoreError: 'deny',
  headers: 'both',
}));
```

Run authentication first. Identity functions may be asynchronous. A rejected quota returns `429 RATE_LIMITED` and `Retry-After`. Store outages and memory capacity failures return `503 RATE_LIMIT_UNAVAILABLE` by default. `onStoreError: 'allow'` is an explicit availability trade-off; a callback can choose `'allow'` or `'deny'` per request. Programming and configuration errors go to framework error handling.

Header modes are `legacy`, `ratelimit`, `both` (default) or `false`. Legacy `X-RateLimit-*` headers remain compatible; the optional `RateLimit-Limit/Remaining/Reset` fields follow a draft-style convention and are not claimed as a universally finalized standard. `Retry-After` is still returned on denial when other quota headers are disabled.

## Other frameworks

```js
import { fastifyHook, koaMiddleware, fetchHandler } from 'throttlflow';

fastify.addHook('onRequest', fastifyHook(limiter, { key: request => request.user.id }));
koa.use(koaMiddleware(limiter, { key: context => context.state.user.id }));

export const GET = fetchHandler(limiter, {
  key: async request => (await authenticate(request)).userId,
  signal: request => request.signal,
}, async request => Response.json({ ok: true }));
```

The Fetch wrapper also supports Next.js route context. `hapiPlugin()` registers Hapi lifecycle hooks. `nestGuard()` accepts an application-supplied HTTP exception factory so it works without importing Nest into the package. Full examples and requirements are in [GUIDE.md](GUIDE.md).

## Metrics and bounded waiting

```js
const limiter = throttl({ limit: 100, windowMs: 60_000, timeoutMs: 2_000,
  onDecision: ({ decision, durationMs }) => recordDecision(decision.allowed, durationMs),
  onError: ({ error }) => recordStoreError(error),
});
await limiter.check('user-123', { signal: abortController.signal });
console.log(limiter.stats());
```

Hooks can feed your existing Prometheus/OpenTelemetry setup; no monitoring service is bundled. Observer failures do not change decisions. `onHookError` can report them. Metrics are local to each limiter instance, and hooks receive subject identifiers: keep sensitive data out of metric labels.

A signal aborted before execution consumes nothing. Once work is sent, a timeout or abort can stop waiting while the store still completes and consumes capacity. Do not automatically retry an ambiguous operation.

## Policies and circuit breaking

`dynamicLimiter()` resolves trusted free/pro plan settings through a bounded cache. Use stable policy IDs, such as `free-v1`, and new IDs for configuration changes. `composeLimiters()` applies user, tenant and global policies in sequence; earlier successful checks remain charged if a later rule denies. It is not a cross-policy transaction.

`circuitBreakerStore()` pauses repeated calls to unavailable storage and allows one recovery probe after cooldown. It is local to the application process and does not create a fallback quota store. `subjectKey(tenantId, userId)` builds an unambiguous scoped identifier.

## Memory, serverless and edge

Default memory storage is per limiter instance and per process. Restarting wipes it. It cannot enforce a global quota across serverless invocations or multiple servers. Defaults are 100,000 active keys and 1,000,000 retained exact-window events; active entries are never evicted to admit new clients. Inspect `limiter.store.stats()` when using the memory store.

`throttlflow/core` is a portable entry point that bundles without Node built-ins. It includes memory, algorithms, policies and HTTP adapters, but excludes the Node PostgreSQL/Redis adapters. Edge deployments need their own compatible shared store for global quotas; a portable entry point alone does not provide distributed persistence.

Multiple regions share a quota only if they use one consistent coordination store. Independent stores have independent limits. A shared distant store adds network latency; asynchronous replication and failover can lose recent state. The package cannot eliminate that trade-off or guarantee unlimited throughput.

## Development and release

```sh
npm ci
npm run check
npm pack --dry-run
```

Set `TEST_DATABASE_URL` and `TEST_REDIS_URL` to disposable services for native integration tests; otherwise those tests are explicitly skipped. Embedded PostgreSQL/Lua tests validate SQL and script behaviour locally but do not replace native database/Redis concurrency tests. CI runs both services on Node 22, 24 and 26.

Run `npm run build` before local examples. Try `node examples/express.js`, then request `/api/demo` six times to see `429`. See [RELEASING.md](RELEASING.md) before publishing. Historical benchmark results are clearly identified in [BENCHMARK.md](BENCHMARK.md).

Read [GUIDE.md](GUIDE.md) for architecture, full APIs, operations and limitations, or [aboutme.txt](aboutme.txt) for a plain-text project explanation. MIT licensed.
