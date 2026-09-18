import { ThrottlCapacityError, ThrottlConfigurationError, ThrottlStoreError } from './errors.js';
import { memoryStore } from './memory.js';

const DEFAULT_MAX_KEYS = 100_000;
const DEFAULT_MAX_EVENTS = 1_000_000;
const MAX_SLIDING_WINDOW_LIMIT = 10_000;
const MAX_DURATION_MS = 365 * 24 * 60 * 60 * 1_000;

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function positiveNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return value;
}

function duration(value, name) {
  const result = positiveInteger(value, name);
  if (result > MAX_DURATION_MS) {
    throw new RangeError(`${name} must not exceed one year`);
  }
  return result;
}

function normalizeOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Throttl options must be an object');
  }
  const algorithm = options.algorithm ?? 'sliding-window';
  if (algorithm !== 'sliding-window' && algorithm !== 'token-bucket') {
    throw new TypeError('algorithm must be sliding-window or token-bucket');
  }
  const maxKeys = positiveInteger(options.maxKeys ?? DEFAULT_MAX_KEYS, 'maxKeys');
  const maxEvents = positiveInteger(options.maxEvents ?? DEFAULT_MAX_EVENTS, 'maxEvents');
  const clock = options.clock ?? Date.now;
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  if (options.store && (typeof options.store.check !== 'function'
    || typeof options.store.reset !== 'function')) {
    throw new TypeError('store must expose check(key, options) and reset(key)');
  }

  if (algorithm === 'sliding-window') {
    const limit = positiveInteger(options.limit, 'limit');
    if (limit > MAX_SLIDING_WINDOW_LIMIT) {
      throw new RangeError(`limit must not exceed ${MAX_SLIDING_WINDOW_LIMIT} for sliding-window`);
    }
    return {
      algorithm,
      limit,
      windowMs: duration(options.windowMs, 'windowMs'),
      maxKeys,
      maxEvents,
      clock,
      store: options.store,
    };
  }

  const capacity = positiveInteger(options.capacity, 'capacity');
  const refillRate = positiveNumber(options.refillRate, 'refillRate');
  const refillIntervalMs = duration(options.refillIntervalMs, 'refillIntervalMs');
  if (capacity * refillIntervalMs / refillRate > MAX_DURATION_MS) {
    throw new RangeError('A full token-bucket refill must not take more than one year');
  }
  return {
    algorithm,
    capacity,
    refillRate,
    refillIntervalMs,
    maxKeys,
    maxEvents,
    clock,
    store: options.store,
  };
}

function validateKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 512) {
    throw new TypeError('Rate-limit key must be a non-empty string of at most 512 characters');
  }
  return key;
}

function setHeaders(response, decision) {
  response.setHeader('X-RateLimit-Limit', String(decision.limit));
  response.setHeader('X-RateLimit-Remaining', String(decision.remaining));
  response.setHeader('X-RateLimit-Reset', String(Math.ceil(decision.resetAt.getTime() / 1_000)));
  if (!decision.allowed) {
    response.setHeader('Retry-After', String(Math.max(1, Math.ceil(decision.retryAfterMs / 1_000))));
  }
}

// Creates a limiter whose decisions come from memory or a supplied shared store.
export default function throttl(rawOptions) {
  const options = normalizeOptions(rawOptions);
  const store = options.store ?? memoryStore(options);

  async function check(key) {
    validateKey(key);
    try {
      return await store.check(key, options);
    } catch (error) {
      if (error instanceof ThrottlCapacityError
        || error instanceof ThrottlConfigurationError
        || error instanceof ThrottlStoreError) throw error;
      throw new ThrottlStoreError('Rate-limit store failed', { cause: error });
    }
  }

  async function reset(key) {
    validateKey(key);
    return store.reset(key);
  }

  async function cleanup() {
    return typeof store.cleanup === 'function' ? store.cleanup() : 0;
  }

  function middleware({ key } = {}) {
    if (typeof key !== 'function') {
      throw new TypeError('middleware requires a key(request) function');
    }
    return async (request, response, next) => {
      let subject;
      try { subject = key(request); }
      catch (error) { next(error); return; }

      try {
        const result = await check(subject);
        setHeaders(response, result);
        if (result.allowed) next();
        else response.status(429).json({ error: 'RATE_LIMITED', retryAfterMs: result.retryAfterMs });
      } catch (error) {
        if (error instanceof ThrottlCapacityError || error instanceof ThrottlStoreError) {
          response.status(503).json({ error: 'RATE_LIMIT_UNAVAILABLE' });
        } else {
          next(error);
        }
      }
    };
  }

  return { check, reset, cleanup, middleware };
}
