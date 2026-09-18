# In-process sliding-window benchmark

Measured on September 18, 2026 with Node.js 24.13.0 on an AMD Ryzen 5 5600H host with 5.9 GiB reported RAM. The script runs three repetitions per size using a fresh limiter and one hot key, requesting garbage collection before each run. All checks arrive as a burst within a 60-second window. Every configured request is accepted and the next is denied. Results below are medians of the three runs after the bounded memory-store optimization.

| Limit per minute | Burst elapsed | Per-check p99 | Heap allocation delta |
| ---: | ---: | ---: | ---: |
| 1,000 | 2.8 ms | 0.010 ms | 0.2 MiB |
| 5,000 | 7.8 ms | 0.004 ms | 0.8 MiB |
| 10,000 | 11.8 ms | 0.003 ms | 1.2 MiB |

A 10,000-request burst spread across 1,000 keys completed in 12.8 ms. These are only local, in-process `check()` measurements, including its Promise overhead. They exclude HTTP, Express, PostgreSQL, application work, and multi-process contention. A scheduled workload, different CPU, or many active keys can produce different results. The 10,000 sliding-window configuration ceiling is conservative; it is not a throughput SLA.

Reproduce with `npm run benchmark` from the repository root. Always run a separate application-level load test in your own deployment before advertising throughput.
