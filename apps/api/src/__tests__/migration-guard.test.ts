// SPDX-License-Identifier: Elastic-2.0
//
// P30 — migrations-on-boot guard tests.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';

import { buildPgliteHarness, type PgliteHarness } from './_pglite-harness';
import { checkPendingMigrations } from '../health/migration-guard';

let harness: PgliteHarness;
let tmpDir: string;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  tmpDir = mkdtempSync(join(tmpdir(), 'vibe-mig-'));
});

afterEach(async () => {
  await harness.close();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('P30 — checkPendingMigrations', () => {
  it('returns null when all files are applied', async () => {
    writeFileSync(join(tmpDir, '0001_a.sql'), '-- noop');
    writeFileSync(join(tmpDir, '0002_b.sql'), '-- noop');
    await harness.db.execute(
      sql`CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    await harness.db.execute(
      sql`INSERT INTO schema_migrations (filename) VALUES ('0001_a.sql'), ('0002_b.sql')`,
    );
    const result = await checkPendingMigrations(harness.db, { migrationsDir: tmpDir });
    expect(result).toBeNull();
  });

  it('returns the pending list when files are unapplied', async () => {
    writeFileSync(join(tmpDir, '0001_a.sql'), '-- noop');
    writeFileSync(join(tmpDir, '0002_b.sql'), '-- noop');
    writeFileSync(join(tmpDir, '0003_c.sql'), '-- noop');
    await harness.db.execute(
      sql`CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    await harness.db.execute(sql`INSERT INTO schema_migrations (filename) VALUES ('0001_a.sql')`);
    const result = await checkPendingMigrations(harness.db, { migrationsDir: tmpDir });
    expect(result).toEqual(['0002_b.sql', '0003_c.sql']);
  });

  it('treats absent schema_migrations table as nothing-applied', async () => {
    writeFileSync(join(tmpDir, '0001_a.sql'), '-- noop');
    // No schema_migrations table — fresh DB
    const result = await checkPendingMigrations(harness.db, { migrationsDir: tmpDir });
    expect(result).toEqual(['0001_a.sql']);
  });

  it('returns null when migrations dir does not exist', async () => {
    const result = await checkPendingMigrations(harness.db, {
      migrationsDir: join(tmpDir, 'does-not-exist'),
    });
    expect(result).toBeNull();
  });
});
