// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Node ESM resolve hook for the appliance image. The TypeScript build runs
// with moduleResolution: "Bundler" which preserves extensionless relative
// imports in the compiled dist/. Pure Node ESM (Node 24) refuses to
// resolve those — so we install this hook via --import to add .js (or
// /index.js) to extensionless specifiers under file:// URLs.
//
// Wired in docker-compose.local.yml on the api + worker services. No
// runtime behavior change beyond extension resolution.

import { register } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve as pathResolve } from 'node:path';

const SOURCE = `
export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
  const isParentFile = context.parentURL && context.parentURL.startsWith('file:');
  if (!isRelative || !isParentFile) {
    return nextResolve(specifier, context);
  }
  // Already has an extension we recognise — let Node handle it.
  if (/\\.(m?[jt]s|json|node)$/.test(specifier)) {
    return nextResolve(specifier, context);
  }
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const { existsSync } = await import('node:fs');
  const { dirname, join, resolve: pathResolve } = await import('node:path');
  const parentDir = dirname(fileURLToPath(context.parentURL));
  const baseAbsolute = pathResolve(parentDir, specifier);
  // Try .ts variants FIRST so that workspace packages whose package.json
  // exports point at .ts source (the layout this repo uses for
  // @vibe/core, @vibe/db, @vibe/storage) resolve to the typed source
  // rather than a stale dist/ build. Node 24's --experimental-strip-types
  // handles the .ts/.mts files transparently.
  const candidates = [
    baseAbsolute + '.ts',
    baseAbsolute + '.mts',
    baseAbsolute + '.js',
    baseAbsolute + '.mjs',
    join(baseAbsolute, 'index.ts'),
    join(baseAbsolute, 'index.mts'),
    join(baseAbsolute, 'index.js'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      return nextResolve(pathToFileURL(c).href, context);
    }
  }
  return nextResolve(specifier, context);
}
`;

// Materialise the hook as a data: URL so we don't have to chase a second
// file path through the entrypoint.
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(SOURCE).toString('base64');
register(dataUrl, pathToFileURL('./'));

// Silence the unused-import lint by pretending to reference these.
void fileURLToPath;
void existsSync;
void dirname;
void join;
void pathResolve;
