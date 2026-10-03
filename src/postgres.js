import { createHash } from 'node:crypto';
import { calculate, configuration, decision } from './algorithms.js';
import { ThrottlConfigurationError, ThrottlStoreError } from './errors.js';
import { initialMigration, weightedMigration } from './schema.js';

export const postgresMigrations = [
  { version: 1, name: '001-initial.sql', sql: initialMigration },
  { version: 2, name: '002-weighted-algorithms.sql', sql: weightedMigration },
];
export const postgresSchema = `${initialMigration}\n${weightedMigration}`;
const hash = value => createHash('sha256').update(value).digest('hex');

// Locks transaction statements to a deadline and always releases the checked-out connection.
async function withinTransaction(pool, timeoutMs, work) {
  let connection;
  let started = false;
  let discard;
  try {
    connection = await pool.connect();
    await connection.query('BEGIN'); started = true;
    await connection.query("SELECT set_config('statement_timeout', $1, true)", [String(timeoutMs)]);
    const result = await work(connection);
    await connection.query('COMMIT');
    return result;
  } catch (error) {
    if (started) {
      try { await connection.query('ROLLBACK'); } catch (rollbackError) { discard = rollbackError; }
    }
    if (error instanceof ThrottlConfigurationError || error instanceof ThrottlStoreError) throw error;
    throw new ThrottlStoreError('PostgreSQL rate-limit operation failed', { cause: error });
  } finally { connection?.release(discard); }
}

// Counts only live events and finds when enough weighted capacity becomes available.
async function exactCheck(connection, namespace, keyHash, options, now, cost) {
  const cutoff = new Date(now - options.windowMs);
  const { rows } = await connection.query(
    `SELECT COALESCE(SUM(cost), 0)::DOUBLE PRECISION AS count, MIN(requested_at) AS oldest
       FROM throttl_window_events WHERE namespace = $1 AND key_hash = $2 AND requested_at > $3`,
    [namespace, keyHash, cutoff]);
  const count = rows[0].count;
  const allowed = count + cost <= options.limit;
  let retryAt = now;
  if (allowed) {
    await connection.query('INSERT INTO throttl_window_events (namespace, key_hash, requested_at, cost) VALUES ($1, $2, $3, $4)',
      [namespace, keyHash, new Date(now), cost]);
  } else {
    const retry = await connection.query(
      `SELECT requested_at FROM (
         SELECT requested_at, SUM(cost) OVER (ORDER BY requested_at, id) AS freed
         FROM throttl_window_events WHERE namespace = $1 AND key_hash = $2 AND requested_at > $3
       ) live WHERE freed >= $4 ORDER BY requested_at LIMIT 1`,
      [namespace, keyHash, cutoff, count + cost - options.limit]);
    retryAt = new Date(retry.rows[0].requested_at).getTime() + options.windowMs;
  }
  const resetTime = (rows[0].oldest ? new Date(rows[0].oldest).getTime() : now) + options.windowMs;
  await connection.query(
    'UPDATE throttl_keys SET expires_at = $3, last_seen_at = $4, window_ms = $5 WHERE namespace = $1 AND key_hash = $2',
    [namespace, keyHash, new Date(now + options.windowMs), new Date(now), options.windowMs]);
  return decision(allowed, options.limit, options.limit - count - (allowed ? cost : 0), resetTime, allowed ? 0 : retryAt - now);
}

// Creates persistent per-subject quotas shared by every application using the same database.
export function postgresStore({ pool, namespace, timeoutMs = 5000, cleanupBatchSize = 1000 } = {}) {
  if (typeof pool?.connect !== 'function' || typeof pool?.query !== 'function') throw new TypeError('postgresStore requires a pg-compatible pool');
  if (typeof namespace !== 'string' || !namespace.length || namespace.length > 128) throw new TypeError('postgresStore namespace must be 1-128 characters');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError('timeoutMs must be 1-60000');
  if (!Number.isSafeInteger(cleanupBatchSize) || cleanupBatchSize < 1 || cleanupBatchSize > 10_000) throw new TypeError('cleanupBatchSize must be 1-10000');
  return {
    supportsCost: true,
    // Applies numbered migrations once under a transaction-scoped migration lock.
    async migrate() {
      return withinTransaction(pool, timeoutMs, async connection => {
        await connection.query('SELECT pg_advisory_xact_lock(745320019)');
        await connection.query('CREATE TABLE IF NOT EXISTS throttl_schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())');
        const installed = await connection.query('SELECT version FROM throttl_schema_migrations');
        const versions = new Set(installed.rows.map(row => row.version));
        for (const migration of postgresMigrations) {
          if (versions.has(migration.version)) continue;
          await connection.query(migration.sql);
          await connection.query('INSERT INTO throttl_schema_migrations (version) VALUES ($1)', [migration.version]);
        }
      });
    },
    // Locks one subject before reading and updating its weighted algorithm state.
    async check(key, options, { cost = 1, signal } = {}) {
      signal?.throwIfAborted();
      const keyHash = hash(key);
      const configHash = hash(JSON.stringify(configuration(options)));
      return withinTransaction(pool, timeoutMs, async connection => {
        await connection.query(
          `INSERT INTO throttl_keys (namespace, key_hash, config_hash, algorithm, expires_at)
           VALUES ($1, $2, $3, $4, clock_timestamp()) ON CONFLICT (namespace, key_hash) DO NOTHING`,
          [namespace, keyHash, configHash, options.algorithm]);
        const { rows } = await connection.query(
          'SELECT * FROM throttl_keys WHERE namespace = $1 AND key_hash = $2 FOR UPDATE', [namespace, keyHash]);
        const row = rows[0];
        if (!row) throw new ThrottlStoreError('Rate-limit key row was not found');
        if (row.config_hash !== configHash) throw new ThrottlConfigurationError('PostgreSQL key uses a different policy; reset it or use a new namespace');
        signal?.throwIfAborted();
        const time = await connection.query('SELECT clock_timestamp() AS now');
        const now = Math.max(new Date(time.rows[0].now).getTime(), row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0);
        if (options.algorithm === 'sliding-window') return exactCheck(connection, namespace, keyHash, options, now, cost);
        const previous = row.state && Object.keys(row.state).length ? row.state
          : row.available_tokens !== null ? { tokens: Number(row.available_tokens), updatedAt: new Date(row.last_refill_at).getTime() } : {};
        const computed = calculate(options, previous, now, cost);
        await connection.query(
          `UPDATE throttl_keys SET state = $3::jsonb, expires_at = $4, last_seen_at = $5,
             available_tokens = $6, last_refill_at = $7 WHERE namespace = $1 AND key_hash = $2`,
          [namespace, keyHash, JSON.stringify(computed.state), new Date(Math.ceil(computed.expiresAt)), new Date(now),
            computed.state.tokens ?? null, options.algorithm === 'token-bucket' ? new Date(now) : null]);
        return computed.result;
      });
    },
    // Deletes one subject with cascading deletion of its exact-window events.
    async reset(key) {
      try { return (await pool.query('DELETE FROM throttl_keys WHERE namespace = $1 AND key_hash = $2', [namespace, hash(key)])).rowCount > 0; }
      catch (error) { throw new ThrottlStoreError('PostgreSQL reset failed', { cause: error }); }
    },
    // Deletes expired keys and prunes stale events in bounded batches without waiting on active decisions.
    async cleanup() {
      return withinTransaction(pool, timeoutMs, async connection => {
        const expired = await connection.query(
          `WITH doomed AS (SELECT namespace, key_hash FROM throttl_keys
             WHERE namespace = $1 AND expires_at <= clock_timestamp()
             ORDER BY expires_at LIMIT $2 FOR UPDATE SKIP LOCKED)
           DELETE FROM throttl_keys k USING doomed d WHERE k.namespace = d.namespace AND k.key_hash = d.key_hash`,
          [namespace, cleanupBatchSize]);
        const active = await connection.query(
          `SELECT k.key_hash, k.window_ms FROM throttl_keys k
           WHERE k.namespace = $1 AND k.algorithm = 'sliding-window' AND k.window_ms IS NOT NULL
             AND EXISTS (SELECT 1 FROM throttl_window_events e WHERE e.namespace = k.namespace AND e.key_hash = k.key_hash
               AND e.requested_at <= clock_timestamp() - k.window_ms * interval '1 millisecond')
           LIMIT $2 FOR UPDATE OF k SKIP LOCKED`, [namespace, cleanupBatchSize]);
        for (const row of active.rows) {
          await connection.query(
            `DELETE FROM throttl_window_events WHERE namespace = $1 AND key_hash = $2
               AND requested_at <= clock_timestamp() - $3 * interval '1 millisecond'`,
            [namespace, row.key_hash, row.window_ms]);
        }
        return expired.rowCount;
      });
    },
  };
}
