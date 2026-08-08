// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// A8 — runtime app version. `npm_package_version` only exists when the
// process is started through a pnpm script; production starts Node
// directly (`node .../dist/apps/api/src/server.js`), so anything relying
// on it stamps 'unknown'.
//
// Resolution order: VIBE_VERSION env override (ops can pin it at deploy
// time) → nearest ancestor package.json with a version (apps/api's own,
// both in dev and in the image where /app/apps/api/package.json ships
// above the nested dist) → 'dev'.
//
// Deliberately a runtime fs walk-up, NOT a tsc `import '../package.json'`:
// importing a file outside include:["src/**/*"] re-roots tsc's auto-risen
// rootDir and shifts the whole dist layout, which the hard-coded
// entrypoint path in ops/docker/entrypoint-api.sh depends on.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | null = null;

export function appVersion(): string {
  if (cached !== null) return cached;
  const override = process.env['VIBE_VERSION'];
  if (override) {
    cached = override;
    return cached;
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    try {
      const raw = readFileSync(join(dir, 'package.json'), 'utf8');
      const pkg = JSON.parse(raw) as { version?: unknown };
      if (typeof pkg.version === 'string' && pkg.version) {
        cached = pkg.version;
        return cached;
      }
    } catch {
      // no package.json at this level — keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cached = 'dev';
  return cached;
}

/** Test seam. */
export function _resetAppVersionCacheForTests(): void {
  cached = null;
}
