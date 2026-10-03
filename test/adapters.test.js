import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import Fastify from 'fastify';
import Koa from 'koa';
import request from 'supertest';
import throttl, { fastifyHook, koaMiddleware, fetchHandler, hapiPlugin, nestGuard } from '../src/index.js';

test('Express handles async identities, weighted costs and fail-open opt-in', async () => {
  const app = express();
  const limiter = throttl({ limit: 3, windowMs: 60000 });
  app.use(limiter.middleware({ key: async () => 'u', cost: () => 2 }));
  app.get('/', (req, res) => res.json({ ok: true }));
  await request(app).get('/').expect(200);
  const denied = await request(app).get('/').expect(429);
  assert.equal(denied.headers['ratelimit-remaining'], '1');
  const openApp = express();
  const offline = throttl({ limit: 1, windowMs: 1000, store: { check() { throw new Error('offline'); }, reset() { return false; } } });
  openApp.use(offline.middleware({ key: () => 'u', onStoreError: 'allow' }));
  openApp.get('/', (req, res) => res.send('ok'));
  await request(openApp).get('/').expect(200);
});

test('Fastify hook denies requests before route execution', async () => {
  const app = Fastify();
  const limiter = throttl({ limit: 1, windowMs: 60000 });
  let routes = 0;
  app.addHook('onRequest', fastifyHook(limiter, { key: () => 'u' }));
  app.get('/', () => { routes++; return { ok: true }; });
  try {
    assert.equal((await app.inject('/')).statusCode, 200);
    assert.equal((await app.inject('/')).statusCode, 429);
    assert.equal(routes, 1);
  } finally { await app.close(); }
});

test('Koa middleware sets headers and skips downstream on denial', async () => {
  const app = new Koa();
  const limiter = throttl({ limit: 1, windowMs: 60000 });
  app.use(koaMiddleware(limiter, { key: ctx => ctx.path }));
  app.use(ctx => { ctx.body = { ok: true }; });
  await request(app.callback()).get('/').expect(200);
  const denied = await request(app.callback()).get('/').expect(429);
  assert.equal(denied.body.error, 'RATE_LIMITED');
});

test('Fetch wrapper preserves responses and Next.js-style route context', async () => {
  const limiter = throttl({ limit: 1, windowMs: 60000 });
  const handler = fetchHandler(limiter, { key: () => 'u' }, async (req, context) => {
    return Response.json({ param: context.id }, { status: 201, headers: { 'X-App': 'yes' } });
  });
  const allowed = await handler(new Request('https://example.test/'), { id: '42' });
  assert.equal(allowed.status, 201);
  assert.equal(allowed.headers.get('X-App'), 'yes');
  assert.equal((await allowed.json()).param, '42');
  assert.equal((await handler(new Request('https://example.test/'), { id: '42' })).status, 429);
});

test('Hapi plugin registers lifecycle handlers and stops denied requests', async () => {
  const hooks = {};
  hapiPlugin(throttl({ limit: 1, windowMs: 60000 }), { key: () => 'u' }).register({ ext(name, handler) { hooks[name] = handler; } });
  const make = () => ({ headers: {}, code(status) { this.status = status; return this; },
    header(name, value) { this.headers[name] = value; return this; }, takeover() { return this; } });
  const h = { continue: Symbol('continue'), response: make };
  const first = { response: make() };
  assert.equal(await hooks.onPreHandler(first, h), h.continue);
  hooks.onPreResponse(first, h);
  assert.equal(first.response.headers['X-RateLimit-Remaining'], '0');
  assert.equal((await hooks.onPreHandler({ response: make() }, h)).status, 429);
});

test('Nest guard delegates HTTP exceptions and supports Fastify response headers', async () => {
  const response = { header() {} };
  const context = { switchToHttp: () => ({ getRequest: () => ({}), getResponse: () => response }) };
  const guard = nestGuard(throttl({ limit: 1, windowMs: 60000 }), { key: () => 'u', exception: status => new Error(String(status)) });
  assert.equal(await guard.canActivate(context), true);
  await assert.rejects(guard.canActivate(context), /429/);
});
