import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import test from 'node:test';

test('published entry points support import and callable require with shared errors', async () => {
  const esm = await import('throttlflow');
  const require = createRequire(import.meta.url);
  const cjs = require('throttlflow');
  assert.equal(typeof cjs, 'function');
  assert.equal(cjs, esm.default);
  assert.equal(cjs.ThrottlStoreError, esm.ThrottlStoreError);
  const limiter = cjs({ limit: 1, windowMs: 60000 });
  assert.equal((await limiter.check('u')).allowed, true);
  assert.equal((await limiter.check('u')).allowed, false);
  const core = await import('throttlflow/core');
  assert.equal(core.ThrottlStoreError, esm.ThrottlStoreError);
  assert.equal(require('throttlflow/core').ThrottlStoreError, esm.ThrottlStoreError);
});

test('portable core bundles for browser or edge without Node built-ins', async () => {
  const bundled = await build({ stdin: { contents: "import throttle from 'throttlflow/core'; export default throttle;", resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'browser', format: 'esm', metafile: true });
  assert.ok(Object.keys(bundled.metafile.inputs).some(file => file.includes('portable-shared')));
  assert.ok(!bundled.outputFiles[0].text.includes('node:crypto'));
});

test('declarations and migration files are present in the build inputs', async () => {
  for (const file of ['dist/index.d.ts', 'dist/index.d.cts', 'dist/core.d.ts', 'dist/core.d.cts',
    'migrations/001-initial.sql', 'migrations/002-weighted-algorithms.sql']) {
    assert.ok((await readFile(file, 'utf8')).length > 10);
  }
});
