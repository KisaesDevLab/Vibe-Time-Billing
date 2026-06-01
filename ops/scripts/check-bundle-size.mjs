#!/usr/bin/env node
// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Bundle size budget guard. CI runs this after `pnpm build`. Fails the
// build if any app's gzipped main bundle crosses the budget. Per
// CLAUDE.md performance targets: portal FCP <1.5s on 4G means the
// portal payload must stay tight.
//
// Budgets are intentionally generous for now — they catch regressions,
// not micro-optimization.

import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const BUDGETS_KB = {
  // Staff app keeps absorbing new modules: file-manager v2, proposals
  // + e-sign, retainer dashboards, MRR roll-ups, tax-return board,
  // request expansion (templates + items + portal flow), multi-engagement
  // billing, service-line filtering, password + passkey auth, Cloudflare
  // Tunnel admin, etc. Current main bundle is ~245 KB gzipped on a
  // clean build. Budget set to catch regressions, not micro-fluctuations.
  // A real fix is route-level dynamic imports (Vite manualChunks + a
  // React Router lazy boundary on the admin tree) — defer until the
  // app's growth slows.
  web: 270,
  // Portal stays tight — clients on 4G need fast FCP per CLAUDE.md.
  portal: 90,
};

let failed = false;

for (const app of Object.keys(BUDGETS_KB)) {
  const distDir = join('apps', app, 'dist', 'assets');
  let entries;
  try {
    entries = readdirSync(distDir);
  } catch {
    console.error(`size: ${app} dist not found (run pnpm build first)`);
    failed = true;
    continue;
  }
  const mainJs = entries.find((f) => f.startsWith('index-') && f.endsWith('.js'));
  if (!mainJs) {
    console.error(`size: ${app} no main bundle found in ${distDir}`);
    failed = true;
    continue;
  }
  const raw = readFileSync(join(distDir, mainJs));
  const gzipped = gzipSync(raw);
  const gzippedKb = Math.round((gzipped.length / 1024) * 10) / 10;
  const budget = BUDGETS_KB[app];
  const status = gzippedKb <= budget ? 'ok' : 'OVER';
  console.log(
    `size: ${app}/${mainJs} -> ${gzippedKb} KB gzipped (budget ${budget} KB) [${status}]`,
  );
  if (gzippedKb > budget) failed = true;
}

if (failed) {
  console.error('size: budget exceeded, failing.');
  process.exit(1);
}
console.log('size: all apps within budget.');
