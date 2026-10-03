import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import { createClient } from 'redis';
import throttl, { memoryStore, postgresStore, redisStore, ThrottlConfigurationError } from '../src/index.js';

const algorithms = [
  { limit: 10, windowMs: 3600000 },
  { algorithm: 'token-bucket', capacity: 10, refillRate: 1, refillIntervalMs: 3600000 },
  { algorithm: 'gcra', limit: 10, windowMs: 3600000, burst: 10 },
  { algorithm: 'sliding-window-counter', limit: 10, windowMs: 3600000 },
];

// Runs the same weighted, concurrent and reset checks against every storage implementation.
async function contract(storeA, storeB, options) {
  const subject = `contract-${randomUUID()}`;
  const a = throttl({ ...options, store: storeA });
  const b = throttl({ ...options, store: storeB });
  try {
    const results = await Promise.all(Array.from({ length: 100 }, (_, index) => (index % 2 ? a : b).check(subject, { cost: 2 })));
    assert.equal(results.filter(item => item.allowed).length, 5);
    assert.ok(results.every(item => item.remaining >= 0 && item.resetAt instanceof Date));
    assert.ok(results.filter(item => !item.allowed).every(item => item.retryAfterMs > 0));
    const conflicting = throttl({ ...options, ...(options.algorithm === 'token-bucket' ? { capacity: 9 } : { limit: 9 }), store: storeB });
    await assert.rejects(conflicting.check(subject), ThrottlConfigurationError);
    assert.equal(await a.reset(subject), true);
    assert.equal(await a.reset(subject), false);
    assert.equal((await b.check(subject)).allowed, true);
  } finally { await storeA.reset(subject); }
}

test('shared memory store follows the weighted storage contract for all algorithms', async () => {
  for (const options of algorithms) { const store = memoryStore(); await contract(store, store, options); }
});

test('Redis stores coordinate independent clients for every algorithm', { skip: !process.env.TEST_REDIS_URL }, async () => {
  const clients = [createClient({ url: process.env.TEST_REDIS_URL }), createClient({ url: process.env.TEST_REDIS_URL })];
  clients.forEach(client => client.on('error', () => {}));
  try {
    await Promise.all(clients.map(client => client.connect()));
    for (const options of algorithms) {
      const namespace = `test-${randomUUID()}`;
      await contract(redisStore({ client: clients[0], namespace }), redisStore({ client: clients[1], namespace }), options);
    }
    const store = redisStore({ client: clients[0], namespace: `ttl-${randomUUID()}` });
    const limiter = throttl({ limit: 1, windowMs: 120, store });
    await limiter.check('expires');
    assert.equal((await limiter.check('expires')).allowed, false);
    await delay(180);
    assert.equal((await limiter.check('expires')).allowed, true);
    await store.reset('expires');
  } finally { await Promise.all(clients.map(client => client.isOpen ? client.close() : undefined)); }
});

test('PostgreSQL stores coordinate independent pools for every algorithm', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const pools = [new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5, connectionTimeoutMillis: 3000 }),
    new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5, connectionTimeoutMillis: 3000 })];
  try {
    for (const options of algorithms) {
      const namespace = `test-${randomUUID()}`;
      const stores = pools.map(pool => postgresStore({ pool, namespace }));
      await stores[0].migrate();
      await contract(stores[0], stores[1], options);
    }
    const namespace = `cleanup-${randomUUID()}`;
    const store = postgresStore({ pool: pools[0], namespace, cleanupBatchSize: 1 });
    const limiter = throttl({ limit: 2, windowMs: 120, store });
    try {
      await limiter.check('expired-a'); await limiter.check('expired-b');
      await delay(180);
      assert.equal(await store.cleanup(), 1);
      assert.equal(await store.cleanup(), 1);
    } finally { await pools[0].query('DELETE FROM throttl_keys WHERE namespace = $1', [namespace]); }
  } finally { await Promise.all(pools.map(pool => pool.end())); }
});
