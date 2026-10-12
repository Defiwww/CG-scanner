// Bundles the server and workspace packages into dist/server.js.
// Third-party dependencies stay external and are resolved from apps/server/node_modules
// at runtime, so every third-party runtime dependency of a bundled workspace package
// must also be a direct dependency of the server (checked below).
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const readPkg = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const pkg = readPkg('./package.json');
const serverDeps = Object.keys(pkg.dependencies ?? {});
const workspaceDeps = serverDeps.filter((d) => d.startsWith('@volumechecker/'));

const missing = [];
for (const ws of workspaceDeps) {
  const wsPkg = readPkg(`../../packages/${ws.split('/')[1]}/package.json`);
  for (const dep of Object.keys(wsPkg.dependencies ?? {})) {
    if (!dep.startsWith('@volumechecker/') && !serverDeps.includes(dep)) missing.push(`${dep} (from ${ws})`);
  }
}
if (missing.length > 0) {
  console.error(`Server build: add these runtime dependencies to apps/server/package.json:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

await build({
  entryPoints: ['src/server.ts','src/start.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  external: serverDeps.filter((d) => !d.startsWith('@volumechecker/')),
  logLevel: 'info',
});
