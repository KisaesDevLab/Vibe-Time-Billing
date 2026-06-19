// SPDX-License-Identifier: Elastic-2.0
//
// Export the seeded knowledge base to /knowledge-base/*.md (a Markdown mirror
// of the canonical content in seed-helpers/knowledge-base.ts) plus an index.
// The seed file is the source of truth; run this to refresh the mirror:
//   pnpm --filter @vibe/db exec tsx src/scripts/export-kb.ts
//
// Idempotent: it wipes and rewrites the /knowledge-base directory each run.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KB_ARTICLES, KB_CATEGORIES } from '../seed-helpers/knowledge-base';

const here = dirname(fileURLToPath(import.meta.url));
// packages/db/src/scripts -> repo root
const repoRoot = join(here, '..', '..', '..', '..');
const outDir = join(repoRoot, 'knowledge-base');

const catBySlug = new Map(KB_CATEGORIES.map((c) => [c.slug, c]));
const articles = [...KB_ARTICLES].sort(
  (a, b) =>
    (catBySlug.get(a.category)?.sortOrder ?? 999) - (catBySlug.get(b.category)?.sortOrder ?? 999) ||
    a.sortOrder - b.sortOrder ||
    a.title.localeCompare(b.title),
);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

function frontmatter(a: (typeof KB_ARTICLES)[number]): string {
  const audience = a.audience ?? 'staff';
  return [
    '---',
    `title: ${JSON.stringify(a.title)}`,
    `slug: ${a.slug}`,
    `category: ${a.category}`,
    `audience: ${audience}`,
    `tags: [${a.tags.map((t) => JSON.stringify(t)).join(', ')}]`,
    '---',
    '',
  ].join('\n');
}

let fileCount = 0;
for (const a of articles) {
  const dir = join(outDir, a.category);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${a.slug}.md`), frontmatter(a) + a.body + '\n');
  fileCount += 1;
}

// Index, grouped by category in category sortOrder.
const lines: string[] = [
  '# Knowledge Base',
  '',
  `_Generated from \`packages/db/src/seed-helpers/knowledge-base.ts\` — ${fileCount} articles across ${KB_CATEGORIES.length} categories. Do not edit these files by hand; edit the seed and re-run \`export-kb\`._`,
  '',
];
const sortedCats = [...KB_CATEGORIES].sort((a, b) => a.sortOrder - b.sortOrder);
for (const cat of sortedCats) {
  const inCat = articles
    .filter((a) => a.category === cat.slug)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title));
  if (inCat.length === 0) continue;
  lines.push(`## ${cat.title}`, '');
  lines.push(`_${cat.description}_`, '');
  for (const a of inCat) {
    const aud = a.audience && a.audience !== 'staff' ? ` _(${a.audience})_` : '';
    lines.push(`- [${a.title}](${cat.slug}/${a.slug}.md)${aud} — ${a.summary}`);
  }
  lines.push('');
}
writeFileSync(join(outDir, 'index.md'), lines.join('\n'));

// eslint-disable-next-line no-console
console.log(`Exported ${fileCount} articles to ${outDir}`);
