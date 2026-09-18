import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import request from 'supertest';
import throttl from '../src/index.js';

test('Express integration allows, denies, and sends rate-limit headers', async () => {
  const app = express();
  const limiter = throttl({ limit: 2, windowMs: 60_000 });
  app.use(limiter.middleware({ key: (incoming) => incoming.get('X-Test-User') }));
  app.get('/', (incoming, response) => response.json({ ok: true }));

  await request(app).get('/').set('X-Test-User', 'alice').expect(200);
  await request(app).get('/').set('X-Test-User', 'alice').expect(200);
  const denied = await request(app).get('/').set('X-Test-User', 'alice').expect(429);
  assert.equal(denied.body.error, 'RATE_LIMITED');
  assert.equal(denied.headers['x-ratelimit-remaining'], '0');
  assert.ok(Number(denied.headers['retry-after']) >= 1);
  await request(app).get('/').set('X-Test-User', 'bob').expect(200);
});

test('Express integration fails closed when storage fails', async () => {
  const app = express();
  const limiter = throttl({
    limit: 1,
    windowMs: 60_000,
    store: { async check() { throw new Error('offline'); }, async reset() { return false; } },
  });
  app.use(limiter.middleware({ key: () => 'alice' }));
  app.get('/', (incoming, response) => response.json({ ok: true }));
  const failed = await request(app).get('/').expect(503);
  assert.equal(failed.body.error, 'RATE_LIMIT_UNAVAILABLE');
});
