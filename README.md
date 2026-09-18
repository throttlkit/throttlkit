# ThrottlFlow

ThrottlFlow is a Node.js rate limiter with exact sliding-window and token-bucket algorithms. It runs inside your application. Use the default bounded memory store for one process, or supply the PostgreSQL store when multiple processes must share limits. Node.js 22 or newer and ES modules are supported.

## Install and use

```sh
npm install throttlflow
```

```js
import throttl from 'throttlflow';

const limiter = throttl({ limit: 10, windowMs: 60_000 });
const result = await limiter.check('user-123');

if (!result.allowed) {
  console.log(`Try again in ${result.retryAfterMs} ms`);
}
```

`check(key)` always resolves to `{ allowed, limit, remaining, resetAt, retryAfterMs }` for an ordinary allow or deny decision. Store failures reject; they are not mistaken for a denial. `reset(key)` clears one subject and `cleanup()` removes expired keys. All three methods are asynchronous in both store modes.

The default sliding window permits at most `limit` checks for each key in any rolling `windowMs` period. Denied checks do not consume capacity. For a one-minute window, the highest supported `limit` is 10,000 per key. This is a configuration ceiling, not a whole-server throughput guarantee. Shorter windows can permit more than 10,000 requests over a full minute.

## Express middleware

```js
import express from 'express';
import throttl from 'throttlflow';

const app = express();
const limiter = throttl({ limit: 5, windowMs: 60_000 });

app.use('/api', limiter.middleware({
  key: (request) => {
    const subject = request.user?.id ?? request.ip;
    if (!subject) throw new Error('Request identity is unavailable');
    return subject;
  },
}));
```

Supply a trusted subject key, ideally from authenticated user or tenant identity. If using IP addresses behind a reverse proxy, configure Express `trust proxy` only for proxies you control; a client-supplied forwarded IP can otherwise evade a limit. Middleware sends `429` with `Retry-After` on denial. If storage or its configured capacity fails, it **fails closed** with `503 RATE_LIMIT_UNAVAILABLE`; it does not silently allow the request. Key-extraction or configuration errors pass to Express error handling.

## Token bucket

```js
const limiter = throttl({
  algorithm: 'token-bucket',
  capacity: 20,
  refillRate: 5,
  refillIntervalMs: 1_000,
});
```

The bucket starts full, allows bursts up to `capacity`, and replenishes proportionally over time. One accepted check consumes one token. `resetAt` estimates when the bucket will be full; on denial, `retryAfterMs` is the wait until the next token. Token-bucket settings do not share the sliding-window 10,000 limit.

## Shared limits with PostgreSQL

Install `pg` in your application and provide a pool:

```js
import pg from 'pg';
import throttl, { postgresStore } from 'throttlflow';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 3_000,
  max: 10,
});
const store = postgresStore({ pool, namespace: 'login-v1', timeoutMs: 5_000 });

// Run during deployment/setup, not on each request.
await store.migrate();

const limiter = throttl({ limit: 5, windowMs: 60_000, store });
const result = await limiter.check('user-123');
```

Give each policy a unique, stable `namespace`. If you change its algorithm or values, use a new namespace (for example, `login-v2`) or reset old state before using the new configuration. ThrottlFlow rejects a changed configuration for an existing namespace/key instead of silently mixing state. Store the pool in your application and close it during shutdown; ThrottlFlow does not own it. Configure the pool's connection timeout; the store applies a transaction-local statement timeout (5 seconds by default) so a blocked SQL statement fails closed rather than waiting indefinitely.

The store hashes subject keys with SHA-256 before writing them. A PostgreSQL transaction creates or locates that subject's row, locks it with `FOR UPDATE`, uses the database clock, updates algorithm state, and commits. Separate application instances therefore share one decision history for each namespace/key. Unrelated keys can proceed concurrently. Exact sliding windows write one event row per accepted check, so very hot keys are more expensive than token buckets; benchmark your own database before setting high limits.

Call `await store.cleanup()` from a scheduled job to delete expired state and its event rows. In-memory state is cleaned automatically at capacity and can also be cleaned with `await limiter.cleanup()`. `migrate()` creates the package tables; for controlled production changes, run it as a migration/deployment step with appropriate database permissions. Runtime database users need read/write access to those tables, while migration credentials need schema-creation rights.

## Memory and failure limits

Without `store`, state belongs to one limiter instance in one Node.js process. A restart resets it, and separate processes do **not** share quotas. Do not use this mode for a global multi-instance limit.

The memory store defaults to `maxKeys: 100_000` and `maxEvents: 1_000_000`. It removes expired entries when needed and throws `ThrottlCapacityError` if accepting a new key/event would exceed those caps. It never evicts an active key merely to make room, which would let that key bypass its limit. Keys must be nonempty strings of at most 512 characters; keep their cardinality bounded. PostgreSQL mode has no in-process `maxKeys`/`maxEvents` cap and relies on database sizing and scheduled cleanup.

Configuration mismatches throw `ThrottlConfigurationError`; store failures throw `ThrottlStoreError`. Programmatic callers should decide whether to fail closed or allow traffic based on their application risk. Express middleware fails closed by default.

## Testing and release

From the repository root, run `npm test`, `npm run test:types`, and `npm pack --dry-run`. Set `TEST_DATABASE_URL` to a disposable PostgreSQL database and run `npm run test:integration` for real database concurrency tests. The test suite never truncates your database; it cleans up only its own random test namespaces.

`npm run benchmark` measures in-process checks on your machine. See [BENCHMARK.md](BENCHMARK.md) in the repository for methodology. That benchmark is not a server or PostgreSQL throughput guarantee.

ThrottlFlow is licensed under [MIT](LICENSE).
