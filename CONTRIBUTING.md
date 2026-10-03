# Contributing

Use Node.js 22 or newer. Install dependencies with `npm ci`, then run `npm run check`.

Native integration tests require disposable PostgreSQL and Redis databases through `TEST_DATABASE_URL` and `TEST_REDIS_URL`. Without those variables, native tests are explicitly skipped. Embedded SQL/Lua checks run without external services but do not replace native server concurrency tests.

Add behaviour tests for changes to quota decisions, expiration, concurrency, failure handling or adapters. Update both SQL migration assets and `src/schema.js`; the build rejects differences. Add a new numbered migration when altering a published schema.

Keep changes backward compatible when possible. Document algorithm approximation and distributed consistency trade-offs. Never add automatic retries to a quota-consuming operation after an ambiguous timeout.

Open an issue or pull request in the GitHub repository. Include the behaviour being changed and the checks you ran. Security reports belong in the repository's private vulnerability reporting channel when available.
