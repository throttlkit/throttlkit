import express from 'express';
import throttl from 'throttlflow';

const app = express();
const limiter = throttl({ algorithm: 'token-bucket', capacity: 5, refillRate: 5, refillIntervalMs: 60_000 });
app.use('/api', limiter.middleware({ key: () => 'local-demo-user' }));
app.get('/api/demo', (request, response) => response.json({ ok: true, message: 'Request accepted' }));
app.get('/metrics', (request, response) => response.json(limiter.stats()));
app.listen(3000, '127.0.0.1', () => console.log('Local demo: http://127.0.0.1:3000/api/demo'));
