import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { initialMigration, weightedMigration } from '../src/schema.js';

await mkdir('dist', { recursive: true });
for (const [file, embedded] of [['001-initial.sql', initialMigration], ['002-weighted-algorithms.sql', weightedMigration]]) {
  if ((await readFile(`migrations/${file}`, 'utf8')).trim() !== embedded.trim()) throw new Error(`Embedded migration differs: ${file}`);
}
const names = ['memoryStore', 'subjectKey', 'dynamicLimiter', 'composeLimiters', 'circuitBreakerStore',
  'expressMiddleware', 'fastifyHook', 'koaMiddleware', 'fetchHandler', 'hapiPlugin', 'nestGuard', 'rateLimitHeaders',
  'ThrottlCapacityError', 'ThrottlConfigurationError', 'ThrottlStoreError', 'ThrottlTimeoutError'];
await writeFile('dist/core-node.js', `import api from './index-shared.cjs';\nexport default api.default;\n${names.map(name => `export const ${name} = api.${name};`).join('\n')}\n`);
await writeFile('dist/core-node.cjs', `const api = require('./index-shared.cjs');\nconst fn = (...args) => api.default(...args);\nmodule.exports = Object.assign(fn, { ${names.map(name => `${name}: api.${name}`).join(', ')}, default: api.default });\n`);
for (const entry of ['index', 'core']) {
  const main = entry === 'index';
  const filename = main ? 'index' : 'portable';
  const shared = `${filename}-shared.cjs`;
  await build({ entryPoints: [`src/${entry}.js`], outfile: `dist/${shared}`, bundle: true,
    format: 'cjs', platform: main ? 'node' : 'neutral', target: 'es2022', sourcemap: true });
  const exports = main ? [...names, 'postgresStore', 'postgresSchema', 'postgresMigrations', 'redisStore'] : names;
  await writeFile(`dist/${filename}.js`, `import api from './${shared}';\nexport default api.default;\n${exports.map(name => `export const ${name} = api.${name};`).join('\n')}\n`);
  await writeFile(`dist/${filename}.cjs`, `const api = require('./${shared}');\nmodule.exports = Object.assign(api.default, api);\n`);
}
await copyFile('src/index.d.ts', 'dist/index.d.ts');
const declarations = await readFile('src/index.d.ts', 'utf8');
const namespaceDeclarations = declarations.replace('export default function throttl(options: ThrottlOptions): ThrottlInstance;', '');
await writeFile('dist/index.d.cts', `declare function throttl(options: throttl.ThrottlOptions): throttl.ThrottlInstance;\ndeclare namespace throttl {\n${namespaceDeclarations}\n}\nexport = throttl;\n`);
await writeFile('dist/core.d.ts', `export { default, ${names.join(', ')} } from './index.js';\nexport type * from './index.js';\n`);
const portableDeclarations = namespaceDeclarations.replace(/^export function (postgresStore|redisStore).*$/gm, '')
  .replace(/^export const postgres(Schema|Migrations).*$/gm, '');
await writeFile('dist/core.d.cts', `declare function throttl(options: throttl.ThrottlOptions): throttl.ThrottlInstance;\ndeclare namespace throttl {\n${portableDeclarations}\n}\nexport = throttl;\n`);
console.log('Built callable CommonJS and ESM packages, portable core, source maps and declarations.');
