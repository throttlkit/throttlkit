import throttl, { normalizeOptions, validateKey } from './factory.js';
import { configuration } from './algorithms.js';
import { ThrottlCapacityError, ThrottlConfigurationError, ThrottlStoreError } from './errors.js';

// Creates an unambiguous scoped identifier from trusted identity components.
export function subjectKey(...parts) {
  if (!parts.length || parts.some(part => typeof part !== 'string' || !part.length)) throw new TypeError('subjectKey requires non-empty strings');
  return validateKey(JSON.stringify(parts));
}

// Selects bounded, stable policies such as free and pro plans at request time.
export function dynamicLimiter({ resolve, maxPolicies = 100 } = {}) {
  if (typeof resolve !== 'function') throw new TypeError('dynamicLimiter requires resolve(context)');
  if (!Number.isSafeInteger(maxPolicies) || maxPolicies < 1) throw new TypeError('maxPolicies must be a positive integer');
  const policies = new Map();
  return {
    // Resolves a policy and consumes its namespaced subject quota.
    async check(context, checkOptions) {
      const policy = await resolve(context);
      validateKey(policy?.id); validateKey(policy?.key);
      const options = normalizeOptions(policy.options);
      const signature = JSON.stringify(configuration(options));
      let entry = policies.get(policy.id);
      if (entry && entry.signature !== signature) throw new ThrottlConfigurationError('Dynamic policy changed; use a new policy version ID');
      if (!entry) {
        if (policies.size >= maxPolicies) throw new ThrottlCapacityError('Dynamic policy cache capacity reached');
        entry = { signature, limiter: throttl(policy.options) }; policies.set(policy.id, entry);
      }
      return entry.limiter.check(subjectKey(policy.id, policy.key), checkOptions);
    },
    // Cleans expired state in every cached policy without evicting active quotas.
    async cleanup() { return (await Promise.all([...policies.values()].map(entry => entry.limiter.cleanup()))).reduce((a, b) => a + b, 0); },
    // Reports policy-level metrics without returning subject keys.
    stats() { return { policies: policies.size, maxPolicies, entries: [...policies].map(([id, entry]) => ({ id, ...entry.limiter.stats() })) }; },
  };
}

// Applies multiple policies in sequence while retaining charges from earlier successful checks.
export function composeLimiters(rules) {
  if (!Array.isArray(rules) || !rules.length || rules.some(rule => typeof rule.limiter?.check !== 'function' || typeof rule.key !== 'function')) {
    throw new TypeError('composeLimiters requires limiter and key for every rule');
  }
  return { async check(context, checkOptions = {}) {
    const decisions = [];
    for (let index = 0; index < rules.length; index++) {
      const rule = rules[index];
      const cost = typeof rule.cost === 'function' ? await rule.cost(context) : rule.cost ?? checkOptions.cost ?? 1;
      const result = await rule.limiter.check(await rule.key(context), { ...checkOptions, cost });
      decisions.push(result);
      if (!result.allowed) return { allowed: false, decisions, deniedIndex: index };
    }
    return { allowed: true, decisions, deniedIndex: null };
  } };
}

// Stops repeated calls to a failing store and permits one recovery probe after cooldown.
export function circuitBreakerStore(store, { failureThreshold = 5, cooldownMs = 10_000, clock = Date.now } = {}) {
  if (typeof store?.check !== 'function' || typeof store?.reset !== 'function') throw new TypeError('Invalid store');
  if (!Number.isSafeInteger(failureThreshold) || failureThreshold < 1 || !Number.isSafeInteger(cooldownMs) || cooldownMs < 1) throw new TypeError('Invalid circuit breaker settings');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  let failures = 0;
  let openedAt = null;
  let probing = false;
  let generation = 0;
  return {
    supportsCost: store.supportsCost === true,
    // Rejects traffic while open and closes the circuit after a successful recovery probe.
    async check(...args) {
      if (openedAt !== null && (clock() - openedAt < cooldownMs || probing)) throw new ThrottlStoreError('Rate-limit storage circuit is open');
      const probe = openedAt !== null;
      const startedGeneration = generation;
      if (probe) probing = true;
      try {
        const result = await store.check(...args);
        if (generation === startedGeneration) { failures = 0; openedAt = null; }
        return result;
      } catch (error) {
        if (error instanceof ThrottlConfigurationError || error instanceof ThrottlCapacityError || args[2]?.signal?.aborted) throw error;
        if (generation === startedGeneration) {
          failures++;
          if (probe || failures >= failureThreshold) { openedAt = clock(); generation++; }
        }
        throw error;
      } finally { if (probe) probing = false; }
    },
    // Forwards subject resets to the wrapped store.
    reset(...args) { return store.reset(...args); },
    // Forwards expiration maintenance to the wrapped store.
    cleanup() { return store.cleanup?.() ?? 0; },
    // Reports this process's circuit state.
    stats() { return { state: openedAt === null ? 'closed' : probing ? 'half-open' : 'open', failures, openedAt }; },
  };
}
