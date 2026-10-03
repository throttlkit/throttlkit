import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createClient } from 'redis';
import throttl, { postgresStore, redisStore } from '../src/index.js';

const resources = [];
const stores = [];
if (process.env.BENCHMARK_DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: process.env.BENCHMARK_DATABASE_URL, max: 10, connectionTimeoutMillis: 3000 });
  const store = postgresStore({ pool, namespace: `benchmark-${randomUUID()}` });
  await store.migrate(); stores.push({ name: 'postgres', store }); resources.push(() => pool.end());
}
if (process.env.BENCHMARK_REDIS_URL) {
  const client = createClient({ url: process.env.BENCHMARK_REDIS_URL, disableOfflineQueue: true });
  client.on('error', () => {});
  await client.connect();
  stores.push({ name: 'redis', store: redisStore({ client, namespace: `benchmark-${randomUUID()}` }) });
  resources.push(() => client.close());
}
if (!stores.length) throw new Error('Set BENCHMARK_DATABASE_URL or BENCHMARK_REDIS_URL to disposable databases');
try {
  for (const { name, store } of stores) {
    for (const algorithm of ['sliding-window', 'token-bucket']) {
      const limiter = throttl({ ...(algorithm === 'sliding-window' ? { limit: 1000, windowMs: 60000 }
        : { algorithm, capacity: 1000, refillRate: 1, refillIntervalMs: 3600000 }), store });
      for (const hot of [true, false]) {
        const keys = new Set();
        const latency = [];
        const started = performance.now();
        try {
          for (let batch = 0; batch < 100; batch++) {
            await Promise.all(Array.from({ length: 10 }, async (_, index) => {
              const key = `${algorithm}-${hot ? 'hot' : batch * 10 + index}`;
              keys.add(key);
              const before = performance.now();
              const result = await limiter.check(key);
              latency.push(performance.now() - before);
              if (!result.allowed) throw new Error('Unexpected benchmark denial');
            }));
          }
          latency.sort((a, b) => a - b);
          const elapsedMs = performance.now() - started;
          console.log(JSON.stringify({ store: name, algorithm, scenario: hot ? 'hot-key' : 'many-keys',
            checks: latency.length, concurrency: 10, elapsedMs, checksPerSecond: latency.length * 1000 / elapsedMs,
            p95Ms: latency[Math.ceil(latency.length * 0.95) - 1], p99Ms: latency[Math.ceil(latency.length * 0.99) - 1] }));
        } finally { for (const key of keys) await store.reset(key); }
      }
    }
  }
} finally { await Promise.all(resources.map(close => close())); }
