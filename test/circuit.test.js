import test from 'node:test';
import assert from 'node:assert/strict';
import { circuitBreakerStore } from '../src/index.js';

test('a success from an older in-flight call cannot close an opened circuit', async () => {
  let complete;
  let calls = 0;
  const store = circuitBreakerStore({ reset() { return false; }, check() {
    calls++;
    if (calls === 1) return new Promise(resolve => { complete = resolve; });
    throw new Error('offline');
  } }, { failureThreshold: 1 });
  const first = store.check('u');
  await assert.rejects(store.check('u'));
  complete({ allowed: true });
  await first;
  assert.equal(store.stats().state, 'open');
  await assert.rejects(store.check('u'), /circuit/);
});
