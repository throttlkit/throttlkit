import assert from 'node:assert/strict';
import test from 'node:test';
import throttl, { memoryStore, subjectKey, dynamicLimiter, composeLimiters, circuitBreakerStore,
  ThrottlConfigurationError, ThrottlCapacityError, ThrottlStoreError, ThrottlTimeoutError, redisStore } from '../src/index.js';

test('weighted exact windows wait until enough events have expired', async () => {
  let now = 1000;
  const limiter = throttl({ limit: 5, windowMs: 1000, clock: () => now });
  await limiter.check('u', { cost: 2 });
  now = 1100;
  await limiter.check('u', { cost: 3 });
  now = 1500;
  const denied = await limiter.check('u', { cost: 4 });
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterMs, 600);
  now = 2000;
  assert.equal((await limiter.check('u', { cost: 4 })).allowed, false);
  now = 2100;
  assert.equal((await limiter.check('u', { cost: 4 })).allowed, true);
});

test('weighted token bucket permits fractional replenishment without overspending', async () => {
  let now = 0;
  const limiter = throttl({ algorithm: 'token-bucket', capacity: 10, refillRate: 2, refillIntervalMs: 1000, clock: () => now });
  assert.equal((await limiter.check('u', { cost: 8 })).remaining, 2);
  assert.equal((await limiter.check('u', { cost: 4 })).retryAfterMs, 1000);
  now = 1000;
  assert.equal((await limiter.check('u', { cost: 4 })).remaining, 0);
});

test('GCRA bounds bursts and spaces recovery using one timestamp', async () => {
  let now = 0;
  const limiter = throttl({ algorithm: 'gcra', limit: 10, windowMs: 1000, burst: 3, clock: () => now });
  assert.equal((await limiter.check('u', { cost: 3 })).remaining, 0);
  assert.equal((await limiter.check('u')).retryAfterMs, 100);
  now = 100;
  assert.equal((await limiter.check('u')).allowed, true);
  now = 90;
  assert.equal((await limiter.check('u')).allowed, false);
  now = 1000;
  assert.equal(await limiter.cleanup(), 1);
});

test('GCRA integer microseconds preserve exact burst counts at modern Unix timestamps', async () => {
  const limiter = throttl({ algorithm: 'gcra', limit: 1_000_000, windowMs: 1000, burst: 100,
    clock: () => 1_800_000_000_000 });
  const decisions = await Promise.all(Array.from({ length: 200 }, () => limiter.check('u')));
  assert.equal(decisions.filter(item => item.allowed).length, 100);
  assert.throws(() => throttl({ algorithm: 'gcra', limit: 1_000_001, windowMs: 1000 }), /microsecond/);
});

test('approximate counter carries previous bucket and calculates weighted retry', async () => {
  let now = 900;
  const limiter = throttl({ algorithm: 'sliding-window-counter', limit: 10, windowMs: 1000, clock: () => now });
  await limiter.check('u', { cost: 10 });
  now = 1000;
  assert.equal((await limiter.check('u', { cost: 5 })).retryAfterMs, 500);
  now = 1500;
  assert.equal((await limiter.check('u', { cost: 5 })).allowed, true);
  assert.equal((await limiter.check('u', { cost: 10 })).retryAfterMs, 1500);
  now = 3000;
  assert.equal((await limiter.check('u', { cost: 10 })).allowed, true);
});

test('constant-state algorithms admit only their burst under concurrent checks', async () => {
  for (const options of [
    { algorithm: 'token-bucket', capacity: 10, refillRate: 1, refillIntervalMs: 3600000 },
    { algorithm: 'gcra', limit: 10, windowMs: 3600000, burst: 10 },
    { algorithm: 'sliding-window-counter', limit: 10, windowMs: 3600000 },
  ]) {
    const limiter = throttl({ ...options, clock: () => 0 });
    const results = await Promise.all(Array.from({ length: 100 }, () => limiter.check('u', { cost: 2 })));
    assert.equal(results.filter(r => r.allowed).length, 5);
  }
});

test('capacity, costs, clocks and configurable sliding ceiling are validated', async () => {
  const limiter = throttl({ limit: 2, windowMs: 1000 });
  for (const cost of [0, -1, 0.5, NaN, Infinity, 3]) await assert.rejects(limiter.check('u', { cost }));
  assert.doesNotThrow(() => throttl({ limit: 20000, maxSlidingWindowLimit: 20000, windowMs: 1000 }));
  assert.throws(() => memoryStore({ maxKeys: 0 }), /maxKeys/);
  await assert.rejects(throttl({ limit: 1, windowMs: 1000, clock: () => NaN }).check('u'), ThrottlStoreError);
  const store = memoryStore();
  const a = throttl({ limit: 2, windowMs: 1000, store });
  await a.check('u');
  await assert.rejects(throttl({ limit: 3, windowMs: 1000, store }).check('u'), ThrottlConfigurationError);
});

test('old custom stores cannot silently ignore weighted costs', async () => {
  const store = { check() { throw new Error('must not execute'); }, reset() { return false; } };
  await assert.rejects(throttl({ limit: 10, windowMs: 1000, store }).check('u', { cost: 2 }), ThrottlConfigurationError);
});

test('abort before a check never invokes storage and timeout records an error', async () => {
  let calls = 0;
  const store = { check() { calls++; return new Promise(() => {}); }, reset() { return false; } };
  const limiter = throttl({ limit: 2, windowMs: 1000, store });
  await assert.rejects(limiter.check('u', { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(calls, 0);
  await assert.rejects(limiter.check('u', { timeoutMs: 10 }), ThrottlTimeoutError);
  assert.equal(calls, 1);
  assert.equal(limiter.stats().errors, 1);
});

test('observer failures never turn an accepted request into a failed check', async () => {
  let hookFailure;
  const limiter = throttl({ limit: 1, windowMs: 1000,
    onDecision() { throw new Error('metrics offline'); }, onHookError(error) { hookFailure = error; } });
  assert.equal((await limiter.check('u')).allowed, true);
  assert.equal((await limiter.check('u')).allowed, false);
  assert.equal(hookFailure.message, 'metrics offline');
  assert.deepEqual([limiter.stats().allowed, limiter.stats().denied, limiter.stats().hookErrors], [1, 1, 2]);
  assert.ok(limiter.stats().averageDurationMs >= 0);
});

test('subject keys cannot collide through ambiguous concatenation', () => {
  assert.notEqual(subjectKey('a:b', 'c'), subjectKey('a', 'b:c'));
  assert.throws(() => subjectKey(), /non-empty/);
});

test('dynamic plans isolate users, preserve quotas and reject unversioned changes', async () => {
  let limit = 1;
  const dynamic = dynamicLimiter({ maxPolicies: 2, resolve: user => ({ id: user.plan, key: user.id,
    options: { limit, windowMs: 60000 } }) });
  assert.equal((await dynamic.check({ plan: 'free', id: 'a' })).allowed, true);
  assert.equal((await dynamic.check({ plan: 'free', id: 'a' })).allowed, false);
  assert.equal((await dynamic.check({ plan: 'pro', id: 'a' })).allowed, true);
  await assert.rejects(dynamic.check({ plan: 'third', id: 'a' }), ThrottlCapacityError);
  limit = 2;
  await assert.rejects(dynamic.check({ plan: 'free', id: 'a' }), ThrottlConfigurationError);
  assert.equal(dynamic.stats().policies, 2);
});

test('composed user and tenant rules stop at denial and retain previous charges', async () => {
  const user = throttl({ limit: 5, windowMs: 60000 });
  const tenant = throttl({ limit: 1, windowMs: 60000 });
  const composite = composeLimiters([{ limiter: user, key: c => c.user }, { limiter: tenant, key: c => c.tenant }]);
  assert.equal((await composite.check({ user: 'a', tenant: 'org' })).allowed, true);
  const second = await composite.check({ user: 'a', tenant: 'org' });
  assert.equal(second.deniedIndex, 1);
  assert.equal(second.decisions[0].remaining, 3);
});

test('circuit breaker opens on store failure and permits one recovery probe', async () => {
  let time = 0, calls = 0, offline = true;
  const base = memoryStore();
  const breaker = circuitBreakerStore({ supportsCost: true, reset: base.reset,
    check(...args) { calls++; if (offline) throw new Error('offline'); return base.check(...args); } },
  { failureThreshold: 2, cooldownMs: 100, clock: () => time });
  const limiter = throttl({ limit: 10, windowMs: 60000, store: breaker });
  await assert.rejects(limiter.check('u')); await assert.rejects(limiter.check('u'));
  await assert.rejects(limiter.check('u'), /circuit/); assert.equal(calls, 2);
  time = 100; offline = false;
  assert.equal((await limiter.check('u')).allowed, true);
  assert.equal(breaker.stats().state, 'closed');
});

test('Redis client adapters put related keys in one cluster hash slot', async () => {
  let keys;
  const store = redisStore({ namespace: 'api', execute: async (script, input) => {
    keys = input; return [1, '10', '9', String(Date.now() + 1000), '0'];
  } });
  await throttl({ limit: 10, windowMs: 1000, store }).check('email@example.com');
  assert.equal(keys[0].match(/\{(.*?)\}/)[1], keys[1].match(/\{(.*?)\}/)[1]);
  assert.ok(keys.every(key => !key.includes('email')));
});

test('Redis only retries NOSCRIPT and never retries an ambiguous network error', async () => {
  let evaluations = 0;
  const client = { async evalSha() { throw new Error('NOSCRIPT No matching script'); },
    async eval() { evaluations++; return [1, '10', '9', String(Date.now() + 1000), '0']; } };
  const limiter = throttl({ limit: 10, windowMs: 1000, store: redisStore({ client, namespace: 'cache' }) });
  assert.equal((await limiter.check('u')).allowed, true);
  assert.equal(evaluations, 1);
  client.evalSha = async () => { throw new Error('Connection lost after sending'); };
  await assert.rejects(limiter.check('u'), ThrottlStoreError);
  assert.equal(evaluations, 1);
});
