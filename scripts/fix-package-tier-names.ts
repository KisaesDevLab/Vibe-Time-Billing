// SPDX-License-Identifier: Elastic-2.0
//
// One-off data fix: collapse per-tier package rows into shared-name tiers.
//
// An earlier import created one packages row per tier named
// "<Package> — <TierLabel>" (e.g. "Individual Tax — Three-Tier — Foundation"),
// so the package_selector block — which groups packages rows by NAME and uses
// tier_label for the tiers — saw each tier as its own single-tier package.
//
// This renames any package whose name ends with " — <its tier_label>" by
// stripping that suffix, so all tiers of a package share one name. Pure rename
// (ids, services, price overrides, cloned_from_slug untouched). Idempotent.
//
// Run with DATABASE_URL (+ optional FIRM_ID to scope to one firm).

import { eq } from 'drizzle-orm';

import { createDb } from '@vibe/db';
import { packages } from '@vibe/db/schema';

const SEP = ' — '; // space + em dash + space, matching the seed naming

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const firmId = process.env['FIRM_ID'] ?? null;

  const { db, close } = createDb({ connectionString });
  try {
    const rows = firmId
      ? await db
          .select({ id: packages.id, name: packages.name, tierLabel: packages.tierLabel })
          .from(packages)
          .where(eq(packages.firmId, firmId))
      : await db
          .select({ id: packages.id, name: packages.name, tierLabel: packages.tierLabel })
          .from(packages);

    const changes: { id: string; from: string; to: string }[] = [];
    for (const r of rows) {
      const suffix = `${SEP}${r.tierLabel}`;
      if (!r.name.endsWith(suffix)) continue;
      const next = r.name.slice(0, r.name.length - suffix.length).trim();
      if (!next || next === r.name) continue;
      changes.push({ id: r.id, from: r.name, to: next });
    }

    for (const c of changes) {
      await db
        .update(packages)
        .set({ name: c.to, updatedAt: new Date() })
        .where(eq(packages.id, c.id));
    }

    // Report the resulting groups (name → tiers) for the affected names.
    const affectedNames = new Set(changes.map((c) => c.to));
    const after = (
      firmId
        ? await db
            .select({
              name: packages.name,
              tierLabel: packages.tierLabel,
              position: packages.position,
            })
            .from(packages)
            .where(eq(packages.firmId, firmId))
        : await db
            .select({
              name: packages.name,
              tierLabel: packages.tierLabel,
              position: packages.position,
            })
            .from(packages)
    ).filter((r) => affectedNames.has(r.name));
    const groups: Record<string, string[]> = {};
    for (const r of after.sort((a, b) => a.position - b.position)) {
      (groups[r.name] ??= []).push(r.tierLabel);
    }

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({ renamed: changes.length, groups, examples: changes.slice(0, 5) }, null, 2),
    );
  } finally {
    await close();
  }
}

void main().then(
  () => process.exit(0),
  (err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  },
);
