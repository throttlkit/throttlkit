import { ThrottlCapacityError } from './errors.js';

function decision(allowed, limit, remaining, resetTime, retryAfterMs = 0) {
  return {
    allowed,
    limit,
    remaining,
    resetAt: new Date(Math.ceil(resetTime)),
    retryAfterMs: Math.ceil(retryAfterMs),
  };
}

// Creates a bounded, in-process store with amortized constant-time sliding-window checks.
export function memoryStore(options) {
  const state = new Map();
  let activeEvents = 0;
  let lastNow = 0;

  function now() {
    const value = options.clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError('clock must return a non-negative integer timestamp in milliseconds');
    }
    lastNow = Math.max(lastNow, value);
    return lastNow;
  }

  function prune(entry, cutoff) {
    while (entry.head < entry.events.length && entry.events[entry.head] <= cutoff) {
      entry.head += 1;
      activeEvents -= 1;
    }
    if (entry.head === entry.events.length) {
      entry.events = [];
      entry.head = 0;
    } else if (entry.head > 1_024 && entry.head * 2 >= entry.events.length) {
      entry.events = entry.events.slice(entry.head);
      entry.head = 0;
    }
  }

  function sweep(currentTime) {
    const before = state.size;
    for (const [key, entry] of state) {
      if (options.algorithm === 'sliding-window') {
        prune(entry, currentTime - options.windowMs);
        if (entry.events.length === 0) state.delete(key);
      } else {
        const refill = Math.max(0, currentTime - entry.updatedAt)
          * options.refillRate / options.refillIntervalMs;
        if (entry.tokens + refill >= options.capacity) state.delete(key);
      }
    }
    return before - state.size;
  }

  function slidingCheck(key, currentTime) {
    const entry = state.get(key) ?? { events: [], head: 0 };
    prune(entry, currentTime - options.windowMs);
    const count = entry.events.length - entry.head;
    const allowed = count < options.limit;
    if (allowed) {
      if (activeEvents >= options.maxEvents) sweep(currentTime);
      if (activeEvents >= options.maxEvents) {
        throw new ThrottlCapacityError(`Throttle maxEvents capacity (${options.maxEvents}) reached`);
      }
      entry.events.push(currentTime);
      activeEvents += 1;
    }
    state.set(key, entry);
    const resetTime = entry.events[entry.head] + options.windowMs;
    return decision(
      allowed,
      options.limit,
      Math.max(0, options.limit - count - (allowed ? 1 : 0)),
      resetTime,
      allowed ? 0 : Math.max(0, resetTime - currentTime),
    );
  }

  function tokenCheck(key, currentTime) {
    const previous = state.get(key) ?? { tokens: options.capacity, updatedAt: currentTime };
    const elapsed = Math.max(0, currentTime - previous.updatedAt);
    const tokens = Math.min(
      options.capacity,
      previous.tokens + elapsed * options.refillRate / options.refillIntervalMs,
    );
    const allowed = tokens >= 1;
    const after = allowed ? tokens - 1 : tokens;
    state.set(key, { tokens: after, updatedAt: currentTime });
    const millisecondsPerToken = options.refillIntervalMs / options.refillRate;
    const resetTime = currentTime + (options.capacity - after) * millisecondsPerToken;
    return decision(
      allowed,
      options.capacity,
      Math.floor(after),
      resetTime,
      allowed ? 0 : Math.max(0, (1 - tokens) * millisecondsPerToken),
    );
  }

  return {
    check(key) {
      const currentTime = now();
      if (!state.has(key) && state.size >= options.maxKeys) sweep(currentTime);
      if (!state.has(key) && state.size >= options.maxKeys) {
        throw new ThrottlCapacityError(`Throttle maxKeys capacity (${options.maxKeys}) reached`);
      }
      return options.algorithm === 'sliding-window'
        ? slidingCheck(key, currentTime)
        : tokenCheck(key, currentTime);
    },
    reset(key) {
      const entry = state.get(key);
      if (!entry) return false;
      if (options.algorithm === 'sliding-window') {
        activeEvents -= entry.events.length - entry.head;
      }
      state.delete(key);
      return true;
    },
    cleanup() {
      return sweep(now());
    },
  };
}
