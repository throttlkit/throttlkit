import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import throttl, { postgresStore, ThrottlConfigurationError, ThrottlStoreError } from '../src/index.js';

test('PostgreSQL shares atomic limits across independent pools', {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const firstPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10 });
  const secondPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10 });
  const namespace = `throttl-test-${randomUUID()}`;
  const bucketNamespace = `throttl-test-${randomUUID()}`;
  const stores = [
    postgresStore({ pool: firstPool, namespace }),
    postgresStore({ pool: secondPool, namespace }),
  ];

  try {
    await stores[0].migrate();
    await stores[1].migrate();
    const limiters = stores.map((store) => throttl({ limit: 10, windowMs: 60_000, store }));
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, index) => limiters[index % 2].check('alice@example.com')),
    );
    assert.equal(results.filter((item) => item.allowed).length, 10);
    assert.equal(results.filter((item) => !item.allowed).length, 90);
    assert.ok(results.every((item) => item.remaining >= 0));

    const stored = await firstPool.query(
      'SELECT key_hash FROM throttl_keys WHERE namespace = $1',
      [namespace],
    );
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0].key_hash.length, 64);
    assert.notEqual(stored.rows[0].key_hash, 'alice@example.com');

    const changed = throttl({ limit: 9, windowMs: 60_000, store: stores[0] });
    await assert.rejects(changed.check('alice@example.com'), ThrottlConfigurationError);

    assert.equal(await limiters[0].reset('alice@example.com'), true);
    assert.equal((await limiters[1].check('alice@example.com')).allowed, true);

    const blocker = await firstPool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT key_hash FROM throttl_keys WHERE namespace = $1 FOR UPDATE',
        [namespace],
      );
      const timedStore = postgresStore({ pool: secondPool, namespace, timeoutMs: 100 });
      const timedLimiter = throttl({ limit: 10, windowMs: 60_000, store: timedStore });
      await assert.rejects(timedLimiter.check('alice@example.com'), ThrottlStoreError);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    assert.equal((await limiters[1].check('alice@example.com')).allowed, true);

    const bucketStore = postgresStore({ pool: firstPool, namespace: bucketNamespace });
    const bucket = throttl({
      algorithm: 'token-bucket',
      capacity: 1,
      refillRate: 1,
      refillIntervalMs: 3_600_000,
      store: bucketStore,
    });
    assert.equal((await bucket.check('bob')).allowed, true);
    assert.equal((await bucket.check('bob')).allowed, false);

    const bucketOnSecondPool = throttl({
      algorithm: 'token-bucket',
      capacity: 1,
      refillRate: 1,
      refillIntervalMs: 3_600_000,
      store: postgresStore({ pool: secondPool, namespace: bucketNamespace }),
    });
    const bucketResults = await Promise.all(
      Array.from({ length: 50 }, (_, index) => (index % 2 === 0 ? bucket : bucketOnSecondPool).check('charlie')),
    );
    assert.equal(bucketResults.filter((item) => item.allowed).length, 1);
    assert.equal(bucketResults.filter((item) => !item.allowed).length, 49);

    await firstPool.query(
      `UPDATE throttl_keys SET expires_at = clock_timestamp() - interval '1 second'
       WHERE namespace = $1`,
      [bucketNamespace],
    );
    assert.equal(await bucket.cleanup(), 2);
  } finally {
    await firstPool.query(
      'DELETE FROM throttl_keys WHERE namespace = ANY($1::text[])',
      [[namespace, bucketNamespace]],
    ).catch(() => {});
    await Promise.all([firstPool.end(), secondPool.end()]);
  }
});
