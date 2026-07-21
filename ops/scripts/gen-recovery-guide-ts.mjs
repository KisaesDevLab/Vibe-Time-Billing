// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Regenerate apps/api/src/backup/recovery-guide.ts from the canonical
// ops/docs/DISASTER-RECOVERY.md so the admin "Download Recovery Packet"
// endpoint embeds the current guide. Run after editing the guide:
//   node ops/scripts/gen-recovery-guide-ts.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const md = readFileSync(resolve(root, 'ops/docs/DISASTER-RECOVERY.md'), 'utf8');
const ts =
  `// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0\n` +
  `//\n` +
  `// AUTO-GENERATED from ops/docs/DISASTER-RECOVERY.md — do not edit by hand.\n` +
  `// Regenerate after editing the guide:\n` +
  `//   node ops/scripts/gen-recovery-guide-ts.mjs\n` +
  `// The recovery-packet endpoint embeds this so the printed packet always\n` +
  `// carries the current recovery guide.\n\n` +
  `export const RECOVERY_GUIDE_MD = ${JSON.stringify(md)};\n`;
writeFileSync(resolve(root, 'apps/api/src/backup/recovery-guide.ts'), ts);
console.log('recovery-guide.ts regenerated (%d bytes md)', md.length);
