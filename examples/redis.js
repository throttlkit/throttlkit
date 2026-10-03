import { createClient } from 'redis';
import throttl, { redisStore } from 'throttlflow';

const client = createClient({ url: process.env.REDIS_URL, disableOfflineQueue: true });
client.on('error', error => console.error('Redis connection error:', error.message));
await client.connect();
try {
  const limiter = throttl({ algorithm: 'gcra', limit: 60, windowMs: 60_000, burst: 5,
    store: redisStore({ client, namespace: 'example-gcra-v1' }) });
  for (let index = 0; index < 6; index++) console.log(await limiter.check('example-user'));
} finally { await client.close(); }
