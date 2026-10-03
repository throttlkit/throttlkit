import { ThrottlCapacityError, ThrottlConfigurationError, ThrottlStoreError } from './errors.js';
import { memoryStore } from './memory.js';
import { controlled } from './control.js';
import { expressMiddleware } from './adapters.js';

// Validates bounded numeric settings before a limiter can consume any capacity.
function positive(value, name, integer = true) {
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) {
    throw new TypeError(`${name} must be a positive ${integer ? 'integer' : 'finite number'}`);
  }
  return value;
}

// Restricts intervals to one year so expiration and retry timestamps remain usable.
function duration(value, name) {
  positive(value, name);
  if (value > 31_536_000_000) throw new RangeError(`${name} must not exceed one year`);
  return value;
}

// Normalizes algorithm options while preserving the original sliding-window default.
export function normalizeOptions(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Throttl options must be an object');
  const algorithm = raw.algorithm ?? 'sliding-window';
  if (!['sliding-window', 'sliding-window-counter', 'token-bucket', 'gcra'].includes(algorithm)) throw new TypeError('Invalid algorithm');
  const options = { ...raw, algorithm,
    maxKeys: positive(raw.maxKeys ?? 100_000, 'maxKeys'),
    maxEvents: positive(raw.maxEvents ?? 1_000_000, 'maxEvents'), clock: raw.clock ?? Date.now };
  if (typeof options.clock !== 'function') throw new TypeError('clock must be a function');
  if (raw.store && (typeof raw.store.check !== 'function' || typeof raw.store.reset !== 'function')) throw new TypeError('store must expose check and reset');
  for (const name of ['onDecision', 'onError', 'onHookError']) {
    if (raw[name] !== undefined && typeof raw[name] !== 'function') throw new TypeError(`${name} must be a function`);
  }
  if (raw.timeoutMs !== undefined) duration(raw.timeoutMs, 'timeoutMs');
  if (algorithm === 'token-bucket') {
    positive(raw.capacity, 'capacity'); positive(raw.refillRate, 'refillRate', false);
    duration(raw.refillIntervalMs, 'refillIntervalMs');
    if (raw.capacity * raw.refillIntervalMs / raw.refillRate > 31_536_000_000) throw new RangeError('A full refill must not exceed one year');
  } else {
    positive(raw.limit, 'limit'); duration(raw.windowMs, 'windowMs');
    if (algorithm === 'sliding-window') {
      options.maxSlidingWindowLimit = positive(raw.maxSlidingWindowLimit ?? 10_000, 'maxSlidingWindowLimit');
      if (raw.limit > options.maxSlidingWindowLimit) throw new RangeError(`limit must not exceed ${options.maxSlidingWindowLimit} for sliding-window`);
    }
    if (algorithm === 'gcra') {
      options.burst = positive(raw.burst ?? 1, 'burst');
      if (options.burst * raw.windowMs / raw.limit > 31_536_000_000) throw new RangeError('Burst recovery must not exceed one year');
      if (raw.limit > raw.windowMs * 1000) throw new RangeError('GCRA supports at most one configured unit per microsecond');
      if (!Number.isSafeInteger(options.burst * Math.ceil(raw.windowMs * 1000 / raw.limit))) throw new RangeError('GCRA burst schedule exceeds safe integer precision');
    }
  }
  return Object.freeze(options);
}

// Rejects empty or unbounded identifiers before they reach a store.
export function validateKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 512) throw new TypeError('Rate-limit key must be a non-empty string of at most 512 characters');
  return key;
}

// Creates a weighted limiter with bounded waiting and lightweight local metrics.
export default function throttl(rawOptions) {
  const options = normalizeOptions(rawOptions);
  const store = options.store ?? memoryStore(options);
  const metrics = { checks: 0, allowed: 0, denied: 0, errors: 0, hookErrors: 0, durationMs: 0 };

  // Observes activity without making an observer failure change a completed decision.
  function notify(name, event) {
    if (!options[name]) return;
    const failed = error => {
      metrics.hookErrors++;
      if (name !== 'onHookError' && options.onHookError) {
        try { Promise.resolve(options.onHookError(error)).catch(() => {}); } catch {}
      }
    };
    try { Promise.resolve(options[name](event)).catch(failed); } catch (error) { failed(error); }
  }

  // Consumes a configurable number of quota units for one subject.
  async function check(key, checkOptions = {}) {
    validateKey(key);
    const cost = positive(checkOptions.cost ?? 1, 'cost');
    const capacity = options.algorithm === 'token-bucket' ? options.capacity
      : options.algorithm === 'gcra' ? options.burst : options.limit;
    if (cost > capacity) throw new RangeError('cost must not exceed the policy capacity');
    if (cost > 1 && store.supportsCost !== true) throw new ThrottlConfigurationError('Custom store must declare supportsCost: true for weighted checks');
    const timeoutMs = checkOptions.timeoutMs ?? options.timeoutMs;
    if (timeoutMs !== undefined) duration(timeoutMs, 'timeoutMs');
    checkOptions.signal?.throwIfAborted();
    const start = performance.now();
    metrics.checks++;
    try {
      const result = await controlled(() => store.check(key, options, { ...checkOptions, cost }), { signal: checkOptions.signal, timeoutMs });
      if (!result || typeof result.allowed !== 'boolean' || !Number.isFinite(result.remaining)
        || result.remaining < 0 || !Number.isFinite(result.limit) || result.limit < 1
        || !(result.resetAt instanceof Date) || !Number.isFinite(result.resetAt.getTime())
        || !Number.isFinite(result.retryAfterMs) || result.retryAfterMs < 0) throw new ThrottlStoreError('Store returned an invalid decision');
      const durationMs = performance.now() - start;
      metrics[result.allowed ? 'allowed' : 'denied']++; metrics.durationMs += durationMs;
      notify('onDecision', { key, cost, algorithm: options.algorithm, decision: result, durationMs });
      return result;
    } catch (error) {
      metrics.errors++; metrics.durationMs += performance.now() - start;
      const failure = error instanceof ThrottlCapacityError || error instanceof ThrottlConfigurationError
        || error instanceof ThrottlStoreError || checkOptions.signal?.aborted ? error
        : new ThrottlStoreError('Rate-limit store failed', { cause: error });
      notify('onError', { key, cost, error: failure });
      throw failure;
    }
  }

  // Clears one subject without affecting other quotas.
  async function reset(key) { return store.reset(validateKey(key)); }
  // Runs store-specific expiration maintenance.
  async function cleanup() { return typeof store.cleanup === 'function' ? store.cleanup() : 0; }
  // Reports per-instance counters for application metrics collection.
  function stats() { return { ...metrics, averageDurationMs: metrics.checks ? metrics.durationMs / metrics.checks : 0 }; }
  const limiter = { check, reset, cleanup, stats, store };
  // Creates Express middleware with a trusted identity extractor.
  limiter.middleware = adapterOptions => expressMiddleware(limiter, adapterOptions);
  return limiter;
}
