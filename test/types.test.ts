import { Pool } from 'pg';
import type { Request, Response, NextFunction } from 'express';
import throttl, { postgresStore, redisStore, memoryStore, dynamicLimiter, composeLimiters, fastifyHook,
  fetchHandler, type ThrottlDecision } from 'throttlflow';
import { createClient } from 'redis';
import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';

const local = throttl({ limit: 10, windowMs: 60_000 });
const localDecision: Promise<ThrottlDecision> = local.check('customer-1');
void localDecision;

const bucket = throttl({
  algorithm: 'token-bucket',
  capacity: 10,
  refillRate: 2,
  refillIntervalMs: 1_000,
});
void bucket.reset('customer-1');

const pool = new Pool();
const shared = postgresStore({ pool, namespace: 'login-v1' });
const distributed = throttl({ limit: 5, windowMs: 60_000, store: shared });
void distributed.check('customer-1');
void shared.migrate();
void redisStore({ client: createClient(), namespace: 'api' });
void local.check('u', { cost: 2, signal: new AbortController().signal, timeoutMs: 1000 });
void throttl({ algorithm: 'gcra', limit: 100, windowMs: 60000, burst: 10, store: memoryStore() });
void throttl({ algorithm: 'sliding-window-counter', limit: 100, windowMs: 60000 });
void dynamicLimiter<{ id: string }>({ resolve: user => ({ id: 'free-v1', key: user.id, options: { limit: 10, windowMs: 1000 } }) });
void composeLimiters([{ limiter: local, key: (context: { id: string }) => context.id }]);
const fastify = Fastify();
fastify.addHook('onRequest', fastifyHook<FastifyRequest>(local, { key: request => request.ip }));
void fetchHandler(local, { key: request => request.url }, (request, context: { id: string }) => Response.json(context));

const middleware = local.middleware<{ user: { id: string } }>({
  key: (request) => request.user.id,
});
void middleware;

const expressMiddleware = local.middleware<Request>({
  key: (request) => {
    if (!request.ip) throw new Error('Request IP is unavailable');
    return request.ip;
  },
});
declare const request: Request;
declare const response: Response;
declare const next: NextFunction;
void expressMiddleware(request, response, next);

// @ts-expect-error Sliding windows require a limit.
throttl({ windowMs: 60_000 });

// @ts-expect-error Token buckets require a refill rate.
throttl({ algorithm: 'token-bucket', capacity: 10, refillIntervalMs: 1_000 });
