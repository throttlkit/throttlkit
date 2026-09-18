import { createHash } from 'node:crypto';
import { ThrottlConfigurationError, ThrottlStoreError } from './errors.js';

export const postgresSchema = `
CREATE TABLE IF NOT EXISTS throttl_keys (
  namespace TEXT NOT NULL,
  key_hash CHAR(64) NOT NULL,
  config_hash CHAR(64) NOT NULL,
  algorithm TEXT NOT NULL CHECK (algorithm IN ('sliding-window', 'token-bucket')),
  available_tokens DOUBLE PRECISION,
  last_refill_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (namespace, key_hash)
);

CREATE TABLE IF NOT EXISTS throttl_window_events (
  id BIGSERIAL PRIMARY KEY,
  namespace TEXT NOT NULL,
  key_hash CHAR(64) NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (namespace, key_hash) REFERENCES throttl_keys(namespace, key_hash) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS throttl_window_events_key_time_idx
  ON throttl_window_events (namespace, key_hash, requested_at);

CREATE INDEX IF NOT EXISTS throttl_keys_expires_at_idx
  ON throttl_keys (expires_at);
`;

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function configurationHash(options) {
  const configuration = options.algorithm === 'sliding-window'
    ? [options.algorithm, options.limit, options.windowMs]
    : [options.algorithm, options.capacity, options.refillRate, options.refillIntervalMs];
  return hash(JSON.stringify(configuration));
}

function decision(allowed, limit, remaining, resetAt, retryAfterMs = 0) {
  return {
    allowed,
    limit,
    remaining,
    resetAt: new Date(Math.ceil(resetAt)),
    retryAfterMs: Math.ceil(retryAfterMs),
  };
}

async function withinTransaction(pool, timeoutMs, work) {
  let connection;
  let started = false;
  try {
    connection = await pool.connect();
    await connection.query('BEGIN');
    started = true;
    await connection.query("SELECT set_config('statement_timeout', $1, true)", [String(timeoutMs)]);
    const value = await work(connection);
    await connection.query('COMMIT');
    return value;
  } catch (error) {
    if (started) {
      try { await connection.query('ROLLBACK'); } catch { /* Preserve the first error. */ }
    }
    if (error instanceof ThrottlConfigurationError) throw error;
    throw new ThrottlStoreError('PostgreSQL rate-limit operation failed', { cause: error });
  } finally {
    connection?.release();
  }
}

async function slidingWindowCheck(connection, namespace, keyHash, options, now) {
  const cutoff = new Date(now.getTime() - options.windowMs);
  await connection.query(
    'DELETE FROM throttl_window_events WHERE namespace = $1 AND key_hash = $2 AND requested_at <= $3',
    [namespace, keyHash, cutoff],
  );
  const { rows } = await connection.query(
    `SELECT COUNT(*)::INTEGER AS count, MIN(requested_at) AS oldest
       FROM throttl_window_events WHERE namespace = $1 AND key_hash = $2`,
    [namespace, keyHash],
  );
  const count = rows[0].count;
  const allowed = count < options.limit;
  if (allowed) {
    await connection.query(
      'INSERT INTO throttl_window_events (namespace, key_hash, requested_at) VALUES ($1, $2, $3)',
      [namespace, keyHash, now],
    );
  }
  const oldest = rows[0].oldest ? new Date(rows[0].oldest) : now;
  const resetTime = oldest.getTime() + options.windowMs;
  await connection.query(
    'UPDATE throttl_keys SET expires_at = $3 WHERE namespace = $1 AND key_hash = $2',
    [namespace, keyHash, new Date(now.getTime() + options.windowMs)],
  );
  return decision(
    allowed,
    options.limit,
    Math.max(0, options.limit - count - (allowed ? 1 : 0)),
    resetTime,
    allowed ? 0 : Math.max(0, resetTime - now.getTime()),
  );
}

async function tokenBucketCheck(connection, namespace, keyHash, options, now, row) {
  const previousTokens = row.available_tokens === null ? options.capacity : Number(row.available_tokens);
  const previousTime = row.last_refill_at ? new Date(row.last_refill_at).getTime() : now.getTime();
  const elapsed = Math.max(0, now.getTime() - previousTime);
  const tokens = Math.min(
    options.capacity,
    previousTokens + elapsed * options.refillRate / options.refillIntervalMs,
  );
  const allowed = tokens >= 1;
  const after = allowed ? tokens - 1 : tokens;
  const millisecondsPerToken = options.refillIntervalMs / options.refillRate;
  const resetTime = now.getTime() + (options.capacity - after) * millisecondsPerToken;
  await connection.query(
    `UPDATE throttl_keys
        SET available_tokens = $3, last_refill_at = $4, expires_at = $5
      WHERE namespace = $1 AND key_hash = $2`,
    [namespace, keyHash, after, now, new Date(Math.ceil(resetTime))],
  );
  return decision(
    allowed,
    options.capacity,
    Math.floor(after),
    resetTime,
    allowed ? 0 : Math.max(0, (1 - tokens) * millisecondsPerToken),
  );
}

// Creates a PostgreSQL-backed store whose per-key row locks coordinate multiple processes.
export function postgresStore({ pool, namespace, timeoutMs = 5_000 }) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('postgresStore requires a pg-compatible pool');
  }
  if (typeof namespace !== 'string' || namespace.length === 0 || namespace.length > 128) {
    throw new TypeError('postgresStore namespace must be 1-128 characters');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('postgresStore timeoutMs must be an integer from 1 to 60000');
  }

  return {
    async migrate() {
      try { await pool.query(postgresSchema); }
      catch (error) { throw new ThrottlStoreError('PostgreSQL schema migration failed', { cause: error }); }
    },
    async check(key, options) {
      const keyHash = hash(key);
      const configHash = configurationHash(options);
      return withinTransaction(pool, timeoutMs, async (connection) => {
        await connection.query(
          `INSERT INTO throttl_keys (namespace, key_hash, config_hash, algorithm, expires_at)
           VALUES ($1, $2, $3, $4, clock_timestamp())
           ON CONFLICT (namespace, key_hash) DO NOTHING`,
          [namespace, keyHash, configHash, options.algorithm],
        );
        const { rows } = await connection.query(
          `SELECT config_hash, available_tokens, last_refill_at
             FROM throttl_keys WHERE namespace = $1 AND key_hash = $2 FOR UPDATE`,
          [namespace, keyHash],
        );
        if (rows.length !== 1) throw new ThrottlStoreError('Rate-limit key row was not found');
        if (rows[0].config_hash !== configHash) {
          throw new ThrottlConfigurationError(
            `Namespace "${namespace}" is already used with a different rate-limit configuration`,
          );
        }
        const timeResult = await connection.query('SELECT clock_timestamp() AS now');
        const now = new Date(timeResult.rows[0].now);
        return options.algorithm === 'sliding-window'
          ? slidingWindowCheck(connection, namespace, keyHash, options, now)
          : tokenBucketCheck(connection, namespace, keyHash, options, now, rows[0]);
      });
    },
    async reset(key) {
      try {
        const result = await pool.query(
          'DELETE FROM throttl_keys WHERE namespace = $1 AND key_hash = $2',
          [namespace, hash(key)],
        );
        return result.rowCount > 0;
      } catch (error) {
        throw new ThrottlStoreError('PostgreSQL rate-limit reset failed', { cause: error });
      }
    },
    async cleanup() {
      try {
        const result = await pool.query(
          'DELETE FROM throttl_keys WHERE namespace = $1 AND expires_at <= clock_timestamp()',
          [namespace],
        );
        return result.rowCount;
      } catch (error) {
        throw new ThrottlStoreError('PostgreSQL rate-limit cleanup failed', { cause: error });
      }
    },
  };
}
