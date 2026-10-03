import pg from 'pg';
import throttl, { postgresStore } from 'throttlflow';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 3000 });
try {
  const store = postgresStore({ pool, namespace: 'example-login-v1' });
  await store.migrate();
  const limiter = throttl({ limit: 5, windowMs: 60_000, store });
  for (let index = 0; index < 6; index++) console.log(await limiter.check('example-user'));
  console.log('Removed expired keys:', await limiter.cleanup());
} finally { await pool.end(); }
