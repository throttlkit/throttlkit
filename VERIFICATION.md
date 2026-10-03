# Verification — October 3, 2026

Prepared ThrottlFlow 0.2.0 locally. No npm publication or GitHub push was performed.

- 37 algorithm, feature, middleware and circuit-breaker tests passed.
- 3 distribution tests passed: ESM/callable CommonJS, shared Node error identities, edge bundling and included declarations/migrations.
- TypeScript ESM and CommonJS consumer checks passed using Node 22 declarations.
- 4 embedded database/script tests passed: upgrade from the original SQL schema, all algorithm SQL paths, cleanup, actual Lua execution, memory/Lua agreement across expiration boundaries, high-rate GCRA precision and large weighted costs.
- 1 shared-store contract test passed for memory across all four algorithms.
- 3 native Redis/PostgreSQL integration tests were explicitly skipped because no disposable database URLs were configured. Docker Desktop failed during startup with an inaccessible ingest socket; its database engine never became available. Embedded checks do not establish native pool/network/concurrency behaviour.
- The complete `npm run check` suite returned success with those explicit native skips. Publication should wait for native CI/service tests to pass.
- `npm audit --omit=dev --audit-level=moderate` reported zero vulnerabilities.
- `npm pack --dry-run` inspected the package contents; compiled code, declarations, maps, migrations, documentation and examples were included, while tests, local credentials, source-control files and node_modules were excluded.
- The actual tarball was installed into a separate empty consumer with scripts disabled. Import, callable require, shared errors and weighted allow/deny checks passed. The install added only the library package.
- The in-process benchmark was rerun; current measurements are recorded separately from the historical 0.1 numbers in BENCHMARK.md.

CI now provisions Redis 7 and PostgreSQL 16 and tests Node 22, 24 and 26. Native tests use random test namespaces rather than flushing services or truncating application data. No native CI result is claimed until that workflow runs.

Deliberate remaining boundaries are documented in GUIDE.md: Node 22 minimum, memory scope, exact-event cost, multi-region coordination, sequential composed quota charges, cancellation ambiguity, no reservation/refund/idempotency protocol, no automatic table partitioning, and no hosted service requirement.
