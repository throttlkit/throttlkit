# Release checklist

1. Review the version, changelog and repository URLs in `package.json`.
2. Run `npm ci` and `npm run check` with both disposable database URLs configured. Native tests must not be skipped for a release.
3. Check the GitHub Actions results on Node.js 22, 24 and 26.
4. Run `npm audit --omit=dev --audit-level=moderate`.
5. Run `npm pack --dry-run` and inspect the included files. The package ships compiled code, declarations, maps, SQL migrations, documentation and the license. It excludes tests, source-control data, local credentials and development dependencies.
6. Install the actual `.tgz` into a separate empty consumer and verify both `import` and `require`.
7. Upgrade an existing 0.1 schema in a disposable database and run migrations before upgrading application instances. Do not operate mixed 0.1 and 0.2 writers when using weighted costs or new algorithms.
8. Run `npm whoami` and `npm view throttlflow version` to check account ownership and published versions. Choose an unused version; package versions cannot be overwritten.
9. Publish only when ready using `npm publish --access public`. This repository does not automatically publish to npm.

Changing the default store, default algorithm, existing decision semantics or default failure policy requires a deliberate compatibility plan. The 0.2 release adds features while preserving the original defaults.
