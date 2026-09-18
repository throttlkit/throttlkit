# Releasing Throttl

The repository root is the `throttlkit` npm package. The old API service and dashboard are not part of this repository or the published tarball.

1. Review `git diff`, commit the intended files, and ensure the GitHub Actions `Throttl package` workflow is green on Node.js 22 and 24. The workflow runs unit, Express, PostgreSQL, TypeScript, audit, pack, and separate-consumer checks.
2. Use a disposable PostgreSQL database for a local integration run by setting `TEST_DATABASE_URL`. Never point the test at a production database. It creates package tables and removes only its random test namespaces, but does not drop the tables.
3. From the repository root, run:

   ```sh
   npm ci
   npm test
   npm run test:types
   npm run test:integration
   npm audit --omit=dev --audit-level=moderate
   npm pack --dry-run
   ```

4. Inspect the dry-run tarball file list for credentials, local database files, or unrelated application files. The package should contain only its source, declarations, license, README, and benchmark files.
5. Verify that the unscoped npm name `throttlkit` is still available and permitted by npm. A registry `404` does not reserve the name; npm makes the final naming decision when publishing. If rejected, choose a distinct name or a scope before publishing.
6. Sign in to npm with an account configured for two-factor authentication. From the repository root, run `npm publish`. Publishing is an explicit manual action; no CI workflow publishes automatically.
7. Verify the published version with `npm view throttlkit version`, then install it in an unrelated test project and run the README example. Do not reuse the same package version for the next release.

Throttl's default store is process-local. Recommend PostgreSQL mode for deployments with multiple workers or instances. Neither the in-process benchmark nor the 10,000 configured sliding-window ceiling is an end-to-end throughput guarantee.
