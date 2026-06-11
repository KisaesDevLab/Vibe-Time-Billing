// SPDX-License-Identifier: Elastic-2.0
//
// Run all hand-written + Drizzle-generated migrations against an
// in-process WASM postgres (pglite) and assert the resulting schema
// matches expectations. This is the closest we can get to "pnpm
// db:migrate applies cleanly" without a real Docker postgres.

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'migrations');

async function applyAllMigrations(db: PGlite): Promise<string[]> {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    const sql = readFileSync(join(migrationsDir, f), 'utf8');
    // pglite doesn't support CREATE ROLE — strip the role bootstrap from
    // 0001 since we're running as superuser. The trigger-based protection
    // is what actually enforces immutability and still applies.
    const cleaned = sql
      .replace(/DO \$\$\s*BEGIN\s*IF NOT EXISTS[\s\S]*?END\s*\$\$;?/g, '-- skipped role bootstrap')
      .replace(/^(REVOKE|GRANT) .*$/gim, '-- skipped grant/revoke in pglite');
    await db.exec(cleaned);
  }
  return files;
}

describe('migrations apply on a fresh db', () => {
  it('init schema + audit immutability + adjustment-sum trigger all apply', async () => {
    const db = new PGlite();
    const applied = await applyAllMigrations(db);
    expect(applied.length).toBeGreaterThanOrEqual(3);

    // Sanity-check a couple of tables exist. Migration 0057 moves them
    // from `public` to `vibetb`, so the assertion targets the new home.
    const tableRows = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'vibetb' ORDER BY table_name`,
    );
    const names = tableRows.rows.map((r) => r.table_name);
    expect(names).toContain('firm');
    expect(names).toContain('app_user');
    expect(names).toContain('portal_identity');
    expect(names).toContain('time_entry');
    expect(names).toContain('adjustment');
    expect(names).toContain('adjustment_allocation');
    expect(names).toContain('audit_log');
  });

  it('time_entry.standard_rate_snapshot_cents is NOT NULL', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);
    const r = await db.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'time_entry' AND column_name = 'standard_rate_snapshot_cents'`,
    );
    expect(r.rows[0]?.is_nullable).toBe('NO');
  });

  it('audit_log triggers prevent UPDATE/DELETE', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);
    // Seed one firm + audit row.
    const firmId = (
      await db.query<{ id: string }>(`INSERT INTO firm (name) VALUES ('Test Firm') RETURNING id`)
    ).rows[0]!.id;
    const userId = (
      await db.query<{ id: string }>(
        `INSERT INTO app_user (firm_id, email, full_name) VALUES ($1, $2, $3) RETURNING id`,
        [firmId, 'test@example.com', 'Test'],
      )
    ).rows[0]!.id;
    await db.query(
      `INSERT INTO audit_log (actor_app_user_id, action, entity_type)
       VALUES ($1, 'LOGIN', 'app_user')`,
      [userId],
    );
    await expect(db.query(`UPDATE audit_log SET action = 'LOGOUT'`)).rejects.toThrow(/immutable/i);
    await expect(db.query(`DELETE FROM audit_log`)).rejects.toThrow(/immutable/i);
  });

  it('adjustment_allocation sum trigger rejects mismatched sums at commit', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);
    const firmId = (
      await db.query<{ id: string }>(`INSERT INTO firm (name) VALUES ('F') RETURNING id`)
    ).rows[0]!.id;
    const partnerId = (
      await db.query<{ id: string }>(
        `INSERT INTO app_user (firm_id, email, full_name) VALUES ($1, $2, $3) RETURNING id`,
        [firmId, 'p@example.com', 'P'],
      )
    ).rows[0]!.id;
    // 0092 made client.office_id NOT NULL.
    const officeId = (
      await db.query<{ id: string }>(
        `INSERT INTO office (firm_id, name, timezone, is_default) VALUES ($1, 'HQ', 'America/Chicago', true) RETURNING id`,
        [firmId],
      )
    ).rows[0]!.id;
    const clientId = (
      await db.query<{ id: string }>(
        `INSERT INTO client (firm_id, name, partner_in_charge_id, office_id) VALUES ($1, 'C', $2, $3) RETURNING id`,
        [firmId, partnerId, officeId],
      )
    ).rows[0]!.id;
    const engId = (
      await db.query<{ id: string }>(
        `INSERT INTO engagement (client_id, name, fee_structure) VALUES ($1, 'E', 'HOURLY') RETURNING id`,
        [clientId],
      )
    ).rows[0]!.id;
    const reasonId = (
      await db.query<{ id: string }>(
        `INSERT INTO reason_code (firm_id, category, label) VALUES ($1, 'WRITE_DOWN', 'Test') RETURNING id`,
        [firmId],
      )
    ).rows[0]!.id;
    const batchId = (
      await db.query<{ id: string }>(
        `INSERT INTO billing_batch (engagement_id, period_start, period_end) VALUES ($1, '2026-01-01', '2026-01-31') RETURNING id`,
        [engId],
      )
    ).rows[0]!.id;
    const entryId = (
      await db.query<{ id: string }>(
        `INSERT INTO time_entry (engagement_id, app_user_id, entry_date, hours, standard_rate_snapshot_cents, standard_amount_cents)
         VALUES ($1, $2, '2026-01-15', 2.0, 50000, 100000) RETURNING id`,
        [engId, partnerId],
      )
    ).rows[0]!.id;

    // Try: adjustment total -1000, but allocate -2000 — should fail at commit.
    await expect(
      (async () => {
        await db.query('BEGIN');
        const adjId = (
          await db.query<{ id: string }>(
            `INSERT INTO adjustment (billing_batch_id, method, allocation_method, total_amount_cents, reason_code_id, created_by_id)
             VALUES ($1, 'TIME', 'SPECIFIC_ENTRIES', -1000, $2, $3) RETURNING id`,
            [batchId, reasonId, partnerId],
          )
        ).rows[0]!.id;
        await db.query(
          `INSERT INTO adjustment_allocation (adjustment_id, time_entry_id, app_user_id, original_value_cents, adjusted_value_cents, adjustment_amount_cents)
           VALUES ($1, $2, $3, 100000, 98000, -2000)`,
          [adjId, entryId, partnerId],
        );
        await db.query('COMMIT');
      })(),
    ).rejects.toThrow(/sum/i);
  });
});
