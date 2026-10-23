import fs from 'node:fs/promises';
import { build } from 'esbuild';

await fs.rm('desktop-dist', { recursive: true, force: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  external: ['electron', 'bufferutil', 'utf-8-validate']
};

await build({
  ...common,
  entryPoints: ['desktop/main.ts'],
  outfile: 'desktop-dist/main.mjs',
  format: 'esm',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
  }
});

await build({
  ...common,
  entryPoints: ['desktop/preload.ts'],
  outfile: 'desktop-dist/preload.cjs',
  format: 'cjs'
});

console.log('desktop main and preload built');
