import { ThrottlCapacityError, ThrottlConfigurationError } from './errors.js';
import { calculate, configuration, decision } from './algorithms.js';

// Creates bounded process-local storage without evicting active quotas.
export function memoryStore(defaults = {}) {
  const entries = new Map();
  let activeEvents = 0;
  let lastNow = 0;
  const maxKeys = defaults.maxKeys ?? 100_000;
  const maxEvents = defaults.maxEvents ?? 1_000_000;
  for (const [name, value] of Object.entries({ maxKeys, maxEvents })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  }
  const clock = defaults.clock ?? Date.now;
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');

  // Prevents a backward clock adjustment from restoring consumed capacity.
  function now() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('clock must return a non-negative integer timestamp');
    lastNow = Math.max(lastNow, value);
    return lastNow;
  }

  // Removes expired exact-window events and occasionally compacts their array.
  function prune(entry, cutoff) {
    while (entry.head < entry.events.length && entry.events[entry.head].at <= cutoff) {
      entry.total -= entry.events[entry.head++].cost;
      activeEvents--;
    }
    if (entry.head === entry.events.length) { entry.events = []; entry.head = 0; }
    else if (entry.head > 1024 && entry.head * 2 >= entry.events.length) {
      entry.events = entry.events.slice(entry.head); entry.head = 0;
    }
  }

  // Releases expired keys while preserving every active policy.
  function sweep(time) {
    let removed = 0;
    for (const [key, entry] of entries) {
      if (entry.options.algorithm === 'sliding-window') prune(entry, time - entry.options.windowMs);
      if (entry.expiresAt <= time) { entries.delete(key); removed++; }
    }
    return removed;
  }

  return {
    supportsCost: true,
    // Makes one weighted decision synchronously before yielding to other callers.
    check(key, options = defaults, { cost = 1 } = {}) {
      const time = now();
      let entry = entries.get(key);
      const signature = JSON.stringify(configuration(options));
      if (entry && entry.signature !== signature) throw new ThrottlConfigurationError('Memory key uses a different policy; reset it or use a new key');
      if (!entry && entries.size >= maxKeys) sweep(time);
      if (!entry && entries.size >= maxKeys) throw new ThrottlCapacityError(`Throttle maxKeys capacity (${maxKeys}) reached`);
      entry ??= { signature, options, events: [], head: 0, total: 0, state: {} };
      let result;
      if (options.algorithm === 'sliding-window') {
        prune(entry, time - options.windowMs);
        const allowed = entry.total + cost <= options.limit;
        if (allowed) {
          if (activeEvents >= maxEvents) sweep(time);
          if (activeEvents >= maxEvents) throw new ThrottlCapacityError(`Throttle maxEvents capacity (${maxEvents}) reached`);
          entry.events.push({ at: time, cost }); entry.total += cost; activeEvents++;
        }
        let retryAt = time;
        if (!allowed) {
          let freed = 0;
          for (let index = entry.head; index < entry.events.length; index++) {
            freed += entry.events[index].cost;
            if (entry.total - freed + cost <= options.limit) {
              retryAt = entry.events[index].at + options.windowMs; break;
            }
          }
        }
        entry.expiresAt = entry.events.at(-1).at + options.windowMs;
        result = decision(allowed, options.limit, options.limit - entry.total,
          entry.events[entry.head].at + options.windowMs, allowed ? 0 : retryAt - time);
      } else {
        const computed = calculate(options, entry.state, time, cost);
        entry.state = computed.state; entry.expiresAt = Math.ceil(computed.expiresAt); result = computed.result;
      }
      entries.set(key, entry);
      return result;
    },
    // Clears one subject and releases its retained events.
    reset(key) {
      const entry = entries.get(key);
      if (!entry) return false;
      activeEvents -= entry.events.length - entry.head;
      return entries.delete(key);
    },
    // Removes all currently expired entries.
    cleanup() { return sweep(now()); },
    // Reports local capacity usage without exposing subject identifiers.
    stats() { return { keys: entries.size, events: activeEvents, maxKeys, maxEvents }; },
  };
}
