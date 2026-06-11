// SPDX-License-Identifier: Elastic-2.0
//
// P30 — Migrations-on-boot guard.
//
// On startup we compare the list of .sql files in
// packages/db/migrations against the schema_migrations table. If any
// file is unapplied, the appliance refuses to come up: cleaner to
// halt than to limp along with a stale schema and corrupt audit
// trails.
//
// Returns null when everything is current, or the list of missing
// filenames when not. Callers print and process.exit(1).

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import type { Database } from '@vibe/db';

export interface MigrationGuardOpts {
  // Override migrations dir (test seam). Production reads from the
  // packages/db/migrations location relative to this file.
  migrationsDir?: string;
}

const DEFAULT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'packages',
  'db',
  'migrations',
);

export async function checkPendingMigrations(
  db: Database,
  opts: MigrationGuardOpts = {},
): Promise<string[] | null> {
  const dir = opts.migrationsDir ?? DEFAULT_DIR;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  } catch {
    // Dir missing → assume nothing to apply (probably a fresh install
    // before migrations are bundled into the image). Don't block boot.
    return null;
  }
  files.sort();
  // schema_migrations may not exist yet on a brand-new database, in
  // which case every file is "pending". migrate.ts creates the table
  // itself, so the right behavior here is to surface the entire list.
  let applied = new Set<string>();
  try {
    const rows = await db.execute(sql`SELECT filename FROM schema_migrations`);
    const r = rows as unknown as { rows: { filename: string }[] };
    applied = new Set(r.rows.map((x) => x.filename));
  } catch {
    // Table missing — treat as no migrations applied.
  }
  const pending = files.filter((f) => !applied.has(f));
  return pending.length === 0 ? null : pending;
}
