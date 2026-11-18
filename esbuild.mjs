// Builds two bundles:
//   dist/extension.js       - extension host code (Node, CommonJS)
//   dist/webview/main.js    - webview UI (browser, IIFE)
import { rmSync } from 'node:fs';
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions[]} */
const configs = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: ['webview/main.ts'],
    outfile: 'dist/webview/main.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  },
];

// A production build starts from an empty dist/ so no stale files (such as
// source maps from a dev build) end up in the .vsix.
if (production) {
  rmSync('dist', { recursive: true, force: true });
}

if (watch) {
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
