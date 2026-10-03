# In-process sliding-window benchmark

The table below describes version 0.1.0. Version 0.2.0 adds weighted event objects, validation, metrics and additional algorithms; these historical numbers must not be advertised as its throughput. Rerun `npm run benchmark` for the upgraded package. Run `npm run benchmark:stores` with `BENCHMARK_DATABASE_URL` and/or `BENCHMARK_REDIS_URL` pointing to disposable databases to measure native store latency, including hot-key and many-key workloads.

Measured on September 18, 2026 with Node.js 24.13.0 on an AMD Ryzen 5 5600H host with 5.9 GiB reported RAM. The script runs three repetitions per size using a fresh limiter and one hot key, requesting garbage collection before each run. All checks arrive as a burst within a 60-second window. Every configured request is accepted and the next is denied. Results below are medians of the three runs after the bounded memory-store optimization.

| Limit per minute | Burst elapsed | Per-check p99 | Heap allocation delta |
| ---: | ---: | ---: | ---: |
| 1,000 | 2.8 ms | 0.010 ms | 0.2 MiB |
| 5,000 | 7.8 ms | 0.004 ms | 0.8 MiB |
| 10,000 | 11.8 ms | 0.003 ms | 1.2 MiB |

A 10,000-request burst spread across 1,000 keys completed in 12.8 ms. These are only local, in-process `check()` measurements, including its Promise overhead. They exclude HTTP, Express, PostgreSQL, application work, and multi-process contention. A scheduled workload, different CPU, or many active keys can produce different results. The 10,000 sliding-window configuration ceiling is conservative; it is not a throughput SLA.

Reproduce with `npm run benchmark` from the repository root. Always run a separate application-level load test in your own deployment before advertising throughput.

## Version 0.2.0 local measurements

Measured October 3, 2026 on the same reported Node.js 24.13.0 / Ryzen 5 5600H / 5.9 GiB environment, with three repetitions, a fresh limiter and requested garbage collection. The upgraded check includes weighted event storage, validation and metrics.

| Configured units/window | Burst elapsed median | Per-check p99 median | Heap allocation delta median |
| ---: | ---: | ---: | ---: |
| 1,000 | 4.0 ms | 0.014 ms | 0.3 MiB |
| 5,000 | 19.9 ms | 0.011 ms | 1.1 MiB |
| 10,000 | 28.9 ms | 0.007 ms | 1.6 MiB |

The 10,000-check many-key scenario completed in 37.3 ms with p99 0.014 ms. Every hot-key run denied the first check beyond its configured limit. These remain local memory/check measurements, not HTTP throughput, Redis/PostgreSQL results or a service-level guarantee. Native store benchmarks were not run because Docker Desktop could not start its database engine on this machine.
