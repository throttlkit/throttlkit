import assert from 'node:assert/strict';
import test from 'node:test';
import throttl, { ThrottlCapacityError } from '../src/index.js';

test('sliding window allows exactly the configured count', async () => {
  let now = 1_000;
  const limiter = throttl({ limit: 2, windowMs: 1_000, clock: () => now });
  assert.deepEqual([(await limiter.check('alice')).allowed, (await limiter.check('alice')).allowed], [true, true]);
  const denied = await limiter.check('alice');
  assert.equal(denied.allowed, false);
  assert.equal(denied.remaining, 0);
  assert.equal(denied.retryAfterMs, 1_000);
  assert.equal((await limiter.check('bob')).allowed, true);
  now = 2_000;
  assert.equal((await limiter.check('alice')).allowed, true);
});

test('sliding window does not count denied requests', async () => {
  let now = 1_000;
  const limiter = throttl({ limit: 1, windowMs: 1_000, clock: () => now });
  await limiter.check('alice');
  now = 1_500;
  assert.equal((await limiter.check('alice')).retryAfterMs, 500);
  now = 2_000;
  assert.equal((await limiter.check('alice')).allowed, true);
});

test('token bucket refills fractional tokens over time', async () => {
  let now = 1_000;
  const limiter = throttl({
    algorithm: 'token-bucket',
    capacity: 2,
    refillRate: 1,
    refillIntervalMs: 1_000,
    clock: () => now,
  });
  assert.equal((await limiter.check('alice')).remaining, 1);
  assert.equal((await limiter.check('alice')).remaining, 0);
  assert.equal((await limiter.check('alice')).allowed, false);
  now = 1_500;
  assert.equal((await limiter.check('alice')).retryAfterMs, 500);
  now = 2_000;
  assert.equal((await limiter.check('alice')).allowed, true);
});

test('reset removes one key and releases its events', async () => {
  const limiter = throttl({ limit: 1, windowMs: 1_000, maxEvents: 2 });
  await limiter.check('alice');
  await limiter.check('bob');
  assert.equal(await limiter.reset('alice'), true);
  assert.equal((await limiter.check('alice')).allowed, true);
  assert.equal((await limiter.check('bob')).allowed, false);
});

test('maxKeys rejects new active keys but cleans up expired keys', async () => {
  let now = 1_000;
  const limiter = throttl({ limit: 1, windowMs: 1_000, maxKeys: 1, clock: () => now });
  await limiter.check('alice');
  await assert.rejects(limiter.check('bob'), ThrottlCapacityError);
  now = 2_000;
  assert.equal((await limiter.check('bob')).allowed, true);
});

test('maxEvents prevents unbounded sliding-window storage', async () => {
  let now = 1_000;
  const limiter = throttl({ limit: 2, windowMs: 1_000, maxEvents: 2, clock: () => now });
  await limiter.check('alice');
  await limiter.check('bob');
  await assert.rejects(limiter.check('carol'), ThrottlCapacityError);
  now = 2_000;
  assert.equal((await limiter.check('carol')).allowed, true);
});

test('concurrent in-process checks admit exactly the configured limit', async () => {
  const limiter = throttl({ limit: 100, windowMs: 60_000 });
  const results = await Promise.all(Array.from({ length: 500 }, () => limiter.check('same-user')));
  assert.equal(results.filter((item) => item.allowed).length, 100);
  assert.equal(results.filter((item) => !item.allowed).length, 400);
});

test('clock moving backward cannot reopen a window', async () => {
  let now = 1_000;
  const limiter = throttl({ limit: 1, windowMs: 1_000, clock: () => now });
  await limiter.check('alice');
  now = 900;
  assert.equal((await limiter.check('alice')).allowed, false);
  now = 2_000;
  assert.equal((await limiter.check('alice')).allowed, true);
});

test('cleanup removes idle keys', async () => {
  let now = 1_000;
  const limiter = throttl({ limit: 1, windowMs: 1_000, clock: () => now });
  await limiter.check('alice');
  await limiter.check('bob');
  now = 2_000;
  assert.equal(await limiter.cleanup(), 2);
});

test('middleware sends 429 and headers after the limit', async () => {
  const limiter = throttl({ limit: 1, windowMs: 1_000 });
  const middleware = limiter.middleware({ key: (request) => request.userId });
  const headers = {};
  let statusCode;
  let body;
  const response = {
    setHeader(name, value) { headers[name] = value; },
    status(code) { statusCode = code; return this; },
    json(value) { body = value; },
  };
  let nextCalls = 0;
  await middleware({ userId: 'alice' }, response, () => { nextCalls += 1; });
  await middleware({ userId: 'alice' }, response, () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);
  assert.equal(statusCode, 429);
  assert.equal(headers['X-RateLimit-Remaining'], '0');
  assert.equal(body.error, 'RATE_LIMITED');
});

test('middleware fails closed with 503 when the store is unavailable', async () => {
  const limiter = throttl({
    limit: 1,
    windowMs: 1_000,
    store: { check() { throw new Error('database offline'); }, reset() { return false; } },
  });
  let statusCode;
  let body;
  let nextCalls = 0;
  const response = {
    setHeader() {},
    status(code) { statusCode = code; return this; },
    json(value) { body = value; },
  };
  await limiter.middleware({ key: () => 'alice' })({}, response, () => { nextCalls += 1; });
  assert.equal(statusCode, 503);
  assert.deepEqual(body, { error: 'RATE_LIMIT_UNAVAILABLE' });
  assert.equal(nextCalls, 0);
});

test('invalid configuration and keys fail clearly', async () => {
  assert.throws(() => throttl({ limit: 0, windowMs: 1_000 }), /limit/);
  assert.throws(() => throttl({ limit: 10_001, windowMs: 60_000 }), /10,?000/);
  assert.doesNotThrow(() => throttl({ limit: 10_000, windowMs: 60_000 }));
  assert.throws(() => throttl({ algorithm: 'unknown' }), /algorithm/);
  const limiter = throttl({ limit: 1, windowMs: 1_000 });
  await assert.rejects(limiter.check(''), /key/);
  await assert.rejects(limiter.check('x'.repeat(513)), /512/);
  assert.throws(() => limiter.middleware(), /key\(request\)/);
});
