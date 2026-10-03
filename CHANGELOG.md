# Changelog

## 0.2.0 — unreleased

- Added callable CommonJS builds, ESM builds, matching TypeScript declarations and an edge-bundleable core entry point.
- Added optional Redis storage with atomic scripts, server time, hashed keys, cluster hash tags and automatic expiration.
- Added GCRA and approximate sliding-window counters alongside exact sliding windows and token buckets.
- Added weighted costs, abort signals, caller timeouts, local metrics and isolated observer hooks.
- Added configurable fail-open/fail-closed middleware, a storage circuit breaker and configurable response headers.
- Added Fastify, Koa, Fetch/Next.js, Hapi and Nest guard adapters.
- Added bounded dynamic policy selection, sequential composed limits and scoped key helpers.
- Added versioned PostgreSQL migrations, weighted event costs, batched expiration and scheduled stale-event cleanup.
- Added a configurable exact-window ceiling, package-consumer tests, embedded SQL/Lua tests and Redis/PostgreSQL CI services.
- Preserved the original default algorithm, original API methods, legacy headers and default fail-closed behaviour.
- Custom stores must explicitly advertise `supportsCost: true` before accepting weighted checks.

## 0.1.0

- Initial memory and PostgreSQL rate limiter with exact sliding-window and token-bucket algorithms.
