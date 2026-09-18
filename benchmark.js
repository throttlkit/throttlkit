import os from 'node:os';
import { performance } from 'node:perf_hooks';
import throttl from './src/index.js';

const sizes = [1_000, 5_000, 10_000];
const repetitions = 3;

function percentile(sorted, fraction) {
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

async function measure(size, keyCount) {
  global.gc?.();
  const limiter = throttl({ limit: size, windowMs: 60_000 });
  const latencies = new Float64Array(size);
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();

  for (let index = 0; index < size; index += 1) {
    const callStartedAt = performance.now();
    const decision = await limiter.check(`key-${index % keyCount}`);
    latencies[index] = performance.now() - callStartedAt;
    if (!decision.allowed) throw new Error(`Unexpected denial at request ${index}`);
  }

  const elapsedMs = performance.now() - startedAt;
  const denied = keyCount === 1 ? !(await limiter.check('key-0')).allowed : null;
  const heapDeltaMiB = (process.memoryUsage().heapUsed - heapBefore) / 1_048_576;
  latencies.sort();
  return {
    elapsedMs,
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    maxMs: latencies[latencies.length - 1],
    heapDeltaMiB,
    denied,
  };
}

console.log(JSON.stringify({
  node: process.version,
  cpu: os.cpus()[0]?.model,
  cores: os.cpus().length,
  memoryGiB: Number((os.totalmem() / 1_073_741_824).toFixed(1)),
  repetitions,
}));

for (const size of sizes) {
  const runs = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    runs.push(await measure(size, 1));
  }
  const sortedTimes = runs.map((run) => run.elapsedMs).sort((a, b) => a - b);
  console.log(JSON.stringify({
    scenario: 'one-hot-key',
    requests: size,
    medianElapsedMs: Number(sortedTimes[1].toFixed(1)),
    medianP95Ms: Number(runs.map((run) => run.p95Ms).sort((a, b) => a - b)[1].toFixed(3)),
    medianP99Ms: Number(runs.map((run) => run.p99Ms).sort((a, b) => a - b)[1].toFixed(3)),
    worstSingleCallMs: Number(Math.max(...runs.map((run) => run.maxMs)).toFixed(3)),
    medianHeapDeltaMiB: Number(runs.map((run) => run.heapDeltaMiB).sort((a, b) => a - b)[1].toFixed(1)),
    deniedAfterLimit: runs.every((run) => run.denied),
  }));
}

const distributed = await measure(10_000, 1_000);
console.log(JSON.stringify({
  scenario: '1000-keys',
  requests: 10_000,
  elapsedMs: Number(distributed.elapsedMs.toFixed(1)),
  p99Ms: Number(distributed.p99Ms.toFixed(3)),
}));
