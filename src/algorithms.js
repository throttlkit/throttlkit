// Builds a consistent decision for every algorithm and store.
export function decision(allowed, limit, remaining, resetTime, retryAfterMs = 0) {
  return { allowed, limit, remaining: Math.max(0, Math.floor(remaining + 1e-9)),
    resetAt: new Date(Math.ceil(resetTime)), retryAfterMs: Math.max(0, Math.ceil(retryAfterMs)) };
}

// Computes constant-size algorithm state without accessing external storage.
export function calculate(options, previous = {}, now, cost = 1) {
  if (options.algorithm === 'token-bucket') {
    const unit = options.refillIntervalMs / options.refillRate;
    const tokens = Math.min(options.capacity,
      (previous.tokens ?? options.capacity) + Math.max(0, now - (previous.updatedAt ?? now)) / unit);
    const allowed = tokens + 1e-9 >= cost;
    const after = Math.max(0, allowed ? tokens - cost : tokens);
    const expiresAt = now + (options.capacity - after) * unit;
    return { state: { tokens: after, updatedAt: now }, expiresAt,
      result: decision(allowed, options.capacity, after, expiresAt, allowed ? 0 : (cost - tokens) * unit) };
  }
  if (options.algorithm === 'gcra') {
    const unit = Math.ceil(options.windowMs * 1000 / options.limit);
    const current = now * 1000;
    const tat = Math.max(current, previous.tatMicros ?? current);
    if (!Number.isSafeInteger(current) || !Number.isSafeInteger(tat + cost * unit)
      || !Number.isSafeInteger(current + options.burst * unit)) throw new RangeError('GCRA timestamp exceeds safe integer precision');
    const retry = tat + cost * unit - options.burst * unit - current;
    const allowed = retry <= 0;
    const after = allowed ? tat + cost * unit : tat;
    return { state: { tatMicros: after }, expiresAt: after / 1000,
      result: decision(allowed, options.burst, (current + options.burst * unit - after) / unit,
        after / 1000, allowed ? 0 : retry / 1000) };
  }
  const window = options.windowMs;
  const bucket = Math.floor(now / window);
  const elapsed = now - bucket * window;
  let count = previous.bucket === bucket ? previous.count : 0;
  const prior = previous.bucket === bucket ? previous.prior
    : previous.bucket === bucket - 1 ? previous.count : 0;
  const estimate = count + prior * (1 - elapsed / window);
  const allowed = estimate + cost <= options.limit + 1e-9;
  let retry = 0;
  if (allowed) count += cost;
  else {
    const threshold = options.limit - cost;
    const within = prior > 0 ? (estimate - threshold) * window / prior : Infinity;
    retry = within <= window - elapsed ? within
      : window - elapsed + (count > threshold ? window * (1 - threshold / count) : 0);
  }
  return { state: { bucket, count, prior }, expiresAt: (bucket + 2) * window,
    result: decision(allowed, options.limit, options.limit - estimate - (allowed ? cost : 0),
      (bucket + 1) * window, retry) };
}

// Returns only policy settings that must agree between distributed callers.
export function configuration(options) {
  if (options.algorithm === 'token-bucket') {
    return [options.algorithm, options.capacity, options.refillRate, options.refillIntervalMs];
  }
  return options.algorithm === 'gcra'
    ? [options.algorithm, options.limit, options.windowMs, options.burst]
    : [options.algorithm, options.limit, options.windowMs];
}
