import { ThrottlCapacityError, ThrottlStoreError } from './errors.js';

// Converts a decision to legacy and optional draft-style RateLimit response headers.
export function rateLimitHeaders(result, mode = 'both') {
  if (!['both', 'legacy', 'ratelimit', false].includes(mode)) throw new TypeError('Invalid headers mode');
  const headers = {};
  const reset = Math.max(0, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000));
  if (mode === 'legacy' || mode === 'both') {
    headers['X-RateLimit-Limit'] = String(result.limit);
    headers['X-RateLimit-Remaining'] = String(result.remaining);
    headers['X-RateLimit-Reset'] = String(Math.ceil(result.resetAt.getTime() / 1000));
  }
  if (mode === 'ratelimit' || mode === 'both') {
    headers['RateLimit-Limit'] = String(result.limit);
    headers['RateLimit-Remaining'] = String(result.remaining);
    headers['RateLimit-Reset'] = String(reset);
  }
  if (!result.allowed) headers['Retry-After'] = String(Math.max(1, Math.ceil(result.retryAfterMs / 1000)));
  return headers;
}

// Resolves identity and request cost before applying a configured storage-failure policy.
function evaluator(limiter, options) {
  if (!options || typeof options.key !== 'function') throw new TypeError('middleware requires a key(request) function');
  const failure = options.onStoreError ?? 'deny';
  if (failure !== 'deny' && failure !== 'allow' && typeof failure !== 'function') throw new TypeError('Invalid onStoreError policy');
  rateLimitHeaders({ allowed: true, limit: 1, remaining: 1, resetAt: new Date(), retryAfterMs: 0 }, options.headers ?? 'both');
  return async request => {
    const key = await options.key(request);
    const cost = typeof options.cost === 'function' ? await options.cost(request) : options.cost ?? 1;
    try {
      const result = await limiter.check(key, { cost, signal: options.signal?.(request) });
      return { status: result.allowed ? 200 : 429, headers: rateLimitHeaders(result, options.headers ?? 'both'),
        body: result.allowed ? undefined : { error: 'RATE_LIMITED', retryAfterMs: result.retryAfterMs } };
    } catch (error) {
      if (!(error instanceof ThrottlCapacityError || error instanceof ThrottlStoreError)) throw error;
      const action = typeof failure === 'function' ? await failure(error, request) : failure;
      if (action !== 'allow' && action !== 'deny') throw new TypeError('onStoreError callback must return allow or deny');
      return { status: action === 'allow' ? 200 : 503, headers: {},
        body: action === 'allow' ? undefined : { error: 'RATE_LIMIT_UNAVAILABLE' } };
    }
  };
}

// Protects an Express route while forwarding programming errors to its error handler.
export function expressMiddleware(limiter, options) {
  const evaluate = evaluator(limiter, options);
  return async (request, response, next) => {
    try {
      const result = await evaluate(request);
      for (const [name, value] of Object.entries(result.headers)) response.setHeader(name, value);
      if (result.status === 200) next();
      else response.status(result.status).json(result.body);
    } catch (error) { next(error); }
  };
}

// Creates an async Fastify onRequest hook.
export function fastifyHook(limiter, options) {
  const evaluate = evaluator(limiter, options);
  return async (request, reply) => {
    const result = await evaluate(request);
    for (const [name, value] of Object.entries(result.headers)) reply.header(name, value);
    if (result.status !== 200) return reply.code(result.status).send(result.body);
  };
}

// Creates Koa middleware whose key function receives the Koa context.
export function koaMiddleware(limiter, options) {
  const evaluate = evaluator(limiter, options);
  return async (context, next) => {
    const result = await evaluate(context);
    for (const [name, value] of Object.entries(result.headers)) context.set(name, value);
    if (result.status === 200) await next();
    else { context.status = result.status; context.body = result.body; }
  };
}

// Wraps a Fetch or Next.js route handler using standard Request and Response objects.
export function fetchHandler(limiter, options, handler) {
  if (typeof handler !== 'function') throw new TypeError('fetchHandler requires a handler');
  const evaluate = evaluator(limiter, options);
  return async (request, ...context) => {
    const result = await evaluate(request);
    if (result.status !== 200) return Response.json(result.body, { status: result.status, headers: result.headers });
    const response = await handler(request, ...context);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(result.headers)) headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}

// Creates a Hapi pre-handler that adds decision headers to both allowed and denied responses.
export function hapiPlugin(limiter, options) {
  const evaluate = evaluator(limiter, options);
  const decisions = new WeakMap();
  return { name: 'throttlflow', version: '0.2.0', register(server) {
    server.ext('onPreHandler', async (request, h) => {
      const result = await evaluate(request);
      decisions.set(request, result);
      if (result.status === 200) return h.continue;
      const response = h.response(result.body).code(result.status);
      for (const [name, value] of Object.entries(result.headers)) response.header(name, value);
      return response.takeover();
    });
    server.ext('onPreResponse', (request, h) => {
      const result = decisions.get(request);
      if (result && !request.response.isBoom) {
        for (const [name, value] of Object.entries(result.headers)) request.response.header(name, value);
      }
      return h.continue;
    });
  } };
}

// Creates a Nest-compatible guard using an application-supplied HTTP exception factory.
export function nestGuard(limiter, options) {
  if (typeof options?.exception !== 'function') throw new TypeError('nestGuard requires exception(status, body)');
  const evaluate = evaluator(limiter, options);
  return { async canActivate(context) {
    const http = context.switchToHttp();
    const result = await evaluate(http.getRequest());
    const response = http.getResponse();
    for (const [name, value] of Object.entries(result.headers)) {
      if (typeof response.header === 'function') response.header(name, value);
      else response.setHeader(name, value);
    }
    if (result.status !== 200) throw options.exception(result.status, result.body);
    return true;
  } };
}
