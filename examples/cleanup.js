import pg from 'pg';
import { postgresStore } from 'throttlflow';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000 });
try {
  const store = postgresStore({ pool, namespace: process.env.THROTTLFLOW_NAMESPACE ?? 'login-v1', cleanupBatchSize: 1000 });
  let total = 0;
  let removed;
  do { removed = await store.cleanup(); total += removed; } while (removed === 1000);
  console.log('Removed expired subjects:', total);
} finally { await pool.end(); }
