import { createHash } from 'node:crypto';
import { configuration, decision } from './algorithms.js';
import { controlled } from './control.js';
import { ThrottlConfigurationError, ThrottlStoreError } from './errors.js';

export const redisScript = `
local meta, events = KEYS[1], KEYS[2]
local signature, algorithm = ARGV[1], ARGV[2]
local limit, window, rate, interval, burst, cost = tonumber(ARGV[3]) + 0.0, tonumber(ARGV[4]) + 0.0, tonumber(ARGV[5]) + 0.0, tonumber(ARGV[6]) + 0.0, tonumber(ARGV[7]) + 0.0, tonumber(ARGV[8]) + 0.0
local stored = redis.call('HGET', meta, 'config')
if stored and stored ~= signature then return redis.error_reply('THROTTLFLOW_CONFIG_MISMATCH') end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000.0 + math.floor(tonumber(time[2]) / 1000)
now = math.max(now, tonumber(redis.call('HGET', meta, 'last') or now))
local allowed, remaining, reset, retry, expires = false, 0, now, 0, now
if algorithm == 'sliding-window' then
  local total = tonumber(redis.call('HGET', meta, 'total') or '0')
  local expired = redis.call('ZRANGEBYSCORE', events, '-inf', now - window)
  for _, member in ipairs(expired) do total = total - tonumber(string.match(member, ':(%d+)$')) end
  redis.call('ZREMRANGEBYSCORE', events, '-inf', now - window)
  allowed = total + cost <= limit
  if allowed then
    local sequence = redis.call('HINCRBY', meta, 'sequence', 1)
    redis.call('ZADD', events, now, string.format('%.0f', sequence) .. ':' .. string.format('%.0f', cost))
    total = total + cost
  else
    local live = redis.call('ZRANGE', events, 0, -1, 'WITHSCORES')
    local freed = 0
    for i = 1, #live, 2 do
      freed = freed + tonumber(string.match(live[i], ':(%d+)$'))
      if total - freed + cost <= limit then retry = tonumber(live[i + 1]) + window - now; break end
    end
  end
  local first = redis.call('ZRANGE', events, 0, 0, 'WITHSCORES')
  local last = redis.call('ZRANGE', events, -1, -1, 'WITHSCORES')
  remaining = limit - total
  reset = tonumber(first[2]) + window
  expires = tonumber(last[2]) + window
  redis.call('HSET', meta, 'total', string.format('%.0f', total))
elseif algorithm == 'token-bucket' then
  local unit = interval / rate
  local tokens = math.min(limit, tonumber(redis.call('HGET', meta, 'tokens') or limit) + math.max(0, now - tonumber(redis.call('HGET', meta, 'updated') or now)) / unit)
  allowed = tokens + 0.000000001 >= cost
  if allowed then tokens = math.max(0, tokens - cost) else retry = (cost - tokens) * unit end
  remaining = math.floor(tokens + 0.000000001)
  reset = now + (limit - tokens) * unit
  expires = reset
  redis.call('HSET', meta, 'tokens', string.format('%.17g', tokens), 'updated', string.format('%.0f', now))
elseif algorithm == 'gcra' then
  local unit = math.ceil(window * 1000 / limit)
  local current = now * 1000
  local tat = math.max(current, tonumber(redis.call('HGET', meta, 'tatMicros') or current))
  if current > 9007199254740991 or tat + cost * unit > 9007199254740991 or current + burst * unit > 9007199254740991 then return redis.error_reply('THROTTLFLOW_GCRA_PRECISION') end
  retry = tat + cost * unit - burst * unit - current
  allowed = retry <= 0
  if allowed then tat = tat + cost * unit; retry = 0 end
  remaining = math.max(0, math.floor((current + burst * unit - tat) / unit))
  reset, expires, limit = tat / 1000, tat / 1000, burst
  retry = retry / 1000
  redis.call('HSET', meta, 'tatMicros', string.format('%.0f', tat))
else
  local bucket = math.floor(now / window)
  local elapsed = now - bucket * window
  local previousBucket = tonumber(redis.call('HGET', meta, 'bucket') or '-1')
  local count, prior = 0, 0
  if previousBucket == bucket then
    count = tonumber(redis.call('HGET', meta, 'count') or '0')
    prior = tonumber(redis.call('HGET', meta, 'prior') or '0')
  elseif previousBucket == bucket - 1 then prior = tonumber(redis.call('HGET', meta, 'count') or '0') end
  local estimate = count + prior * (1 - elapsed / window)
  allowed = estimate + cost <= limit + 0.000000001
  if allowed then count = count + cost else
    local threshold = limit - cost
    local within = math.huge
    if prior > 0 then within = (estimate - threshold) * window / prior end
    if within <= window - elapsed then retry = within else
      retry = window - elapsed
      if count > threshold then retry = retry + window * (1 - threshold / count) end
    end
  end
  remaining = math.max(0, math.floor(limit - estimate - (allowed and cost or 0) + 0.000000001))
  reset, expires = (bucket + 1) * window, (bucket + 2) * window
  redis.call('HSET', meta, 'bucket', string.format('%.0f', bucket), 'count', string.format('%.0f', count), 'prior', string.format('%.0f', prior))
end
redis.call('HSET', meta, 'config', signature, 'last', string.format('%.0f', now))
local ttl = math.max(1, math.ceil(expires - now))
redis.call('PEXPIRE', meta, ttl)
if algorithm == 'sliding-window' then redis.call('PEXPIRE', events, ttl) end
return {allowed and 1 or 0, string.format('%.0f', limit), string.format('%.0f', remaining), string.format('%.0f', math.ceil(reset)), string.format('%.0f', math.ceil(math.max(0, retry)))}
`;

// Creates atomic Redis decisions through node-redis, ioredis or a compatible executor.
export function redisStore({ client, namespace, clientType = 'node-redis', execute, timeoutMs = 5000 } = {}) {
  if (typeof namespace !== 'string' || !namespace.length || namespace.length > 128) throw new TypeError('redisStore namespace must be 1-128 characters');
  if (!['node-redis', 'ioredis'].includes(clientType)) throw new TypeError('Invalid Redis clientType');
  if (!execute && typeof client?.eval !== 'function') throw new TypeError('redisStore requires client.eval or execute');
  if (execute !== undefined && typeof execute !== 'function') throw new TypeError('execute must be a function');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError('timeoutMs must be 1-60000');
  const digest = value => createHash('sha256').update(value).digest('hex');
  const prefix = `throttlflow:${digest(namespace).slice(0, 24)}`;
  const keysFor = key => {
    const tag = digest(JSON.stringify([namespace, key]));
    return [`${prefix}:{${tag}}:state`, `${prefix}:{${tag}}:events`];
  };
  const evaluate = execute ?? (async (script, keys, args) => {
    const sha = createHash('sha1').update(script).digest('hex');
    const cached = clientType === 'ioredis' ? client.evalsha : client.evalSha;
    if (typeof cached === 'function') {
      try {
        return clientType === 'ioredis' ? await cached.call(client, sha, keys.length, ...keys, ...args)
          : await cached.call(client, sha, { keys, arguments: args });
      } catch (error) {
        if (!String(error?.message).startsWith('NOSCRIPT')) throw error;
      }
    }
    return clientType === 'ioredis' ? client.eval(script, keys.length, ...keys, ...args)
      : client.eval(script, { keys, arguments: args });
  });

  // Wraps Redis errors while preserving deliberate configuration mismatch failures.
  async function run(script, keys, args, signal) {
    try { return await controlled(() => evaluate(script, keys, args), { timeoutMs, signal }); }
    catch (error) {
      if (String(error?.message).includes('THROTTLFLOW_CONFIG_MISMATCH')) throw new ThrottlConfigurationError('Redis key uses a different policy; reset it or use a new namespace');
      if (signal?.aborted || error instanceof ThrottlStoreError) throw error;
      throw new ThrottlStoreError('Redis rate-limit operation failed', { cause: error });
    }
  }

  return {
    supportsCost: true,
    // Executes read, expiration, decision and update inside one server-side script.
    async check(key, options, { cost = 1, signal } = {}) {
      const args = [digest(JSON.stringify(configuration(options))), options.algorithm,
        options.algorithm === 'token-bucket' ? options.capacity : options.limit,
        options.windowMs ?? 0, options.refillRate ?? 0, options.refillIntervalMs ?? 0,
        options.burst ?? 0, cost].map(String);
      const result = await run(redisScript, keysFor(key), args, signal);
      return decision(Number(result[0]) === 1, Number(result[1]), Number(result[2]), Number(result[3]), Number(result[4]));
    },
    // Deletes both Redis structures for one subject in the same cluster slot.
    async reset(key) { return Number(await run('return redis.call("DEL", KEYS[1], KEYS[2])', keysFor(key), [])) > 0; },
    // Redis expires idle state automatically through per-subject TTLs.
    async cleanup() { return 0; },
  };
}
