// Bundles the CLI and the runner packages it uses into dist/webtrax.js.
// Third-party packages stay external: they are the CLI's npm dependencies.
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
await build({
  entryPoints: [new URL('../src/bin.ts', import.meta.url).pathname],
  outfile: new URL('../dist/webtrax.js', import.meta.url).pathname,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: Object.keys(pkg.dependencies),
  banner: { js: '#!/usr/bin/env node' },
  define: { __WEBTRAX_VERSION__: JSON.stringify(pkg.version) },
  legalComments: 'none',
  logLevel: 'warning',
})
