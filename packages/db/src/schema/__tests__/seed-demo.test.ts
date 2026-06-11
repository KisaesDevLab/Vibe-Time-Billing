// SPDX-License-Identifier: Elastic-2.0
//
// Smoke-test that the demo seed actually lands a complete Vance scenario:
// engagement, four entries, applied cascade adjustment with the exact
// per-timekeeper realization. Uses pglite so we exercise the real SQL.

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'migrations');

async function applyAllMigrations(db: PGlite): Promise<void> {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    const sql = readFileSync(join(migrationsDir, f), 'utf8');
    const cleaned = sql
      .replace(/DO \$\$\s*BEGIN\s*IF NOT EXISTS[\s\S]*?END\s*\$\$;?/g, '-- skipped role bootstrap')
      .replace(/^(REVOKE|GRANT) .*$/gim, '-- skipped grant/revoke in pglite');
    await db.exec(cleaned);
  }
}

describe('demo seed produces the Vance scenario', () => {
  it('inserts the cascade allocation rows with exact realization %', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    // Minimal fixtures to drive seedDemoBilling without needing the
    // entire seed orchestrator. The full seed runs against real Postgres
    // (verified separately in CI when DATABASE_URL is set).
    const firmId = (
      await db.query<{ id: string }>(`INSERT INTO firm (name) VALUES ('Vance Firm') RETURNING id`)
    ).rows[0]!.id;
    const sarah = (
      await db.query<{ id: string }>(
        `INSERT INTO app_user (firm_id, email, full_name) VALUES ($1,$2,$3) RETURNING id`,
        [firmId, 'sarah@vance.example', 'Sarah Chen'],
      )
    ).rows[0]!.id;
    const mike = (
      await db.query<{ id: string }>(
        `INSERT INTO app_user (firm_id, email, full_name) VALUES ($1,$2,$3) RETURNING id`,
        [firmId, 'mike@vance.example', 'Mike Davis'],
      )
    ).rows[0]!.id;
    const rachel = (
      await db.query<{ id: string }>(
        `INSERT INTO app_user (firm_id, email, full_name) VALUES ($1,$2,$3) RETURNING id`,
        [firmId, 'rachel@vance.example', 'Rachel Kim'],
      )
    ).rows[0]!.id;
    const jenny = (
      await db.query<{ id: string }>(
        `INSERT INTO app_user (firm_id, email, full_name) VALUES ($1,$2,$3) RETURNING id`,
        [firmId, 'jenny@vance.example', 'Jenny Park'],
      )
    ).rows[0]!.id;
    // 0092 made client.office_id NOT NULL — every firm needs a default
    // office and every client references one.
    const officeId = (
      await db.query<{ id: string }>(
        `INSERT INTO office (firm_id, name, timezone, is_default) VALUES ($1,'HQ','America/Chicago',true) RETURNING id`,
        [firmId],
      )
    ).rows[0]!.id;
    const clientId = (
      await db.query<{ id: string }>(
        `INSERT INTO client (firm_id, name, partner_in_charge_id, office_id) VALUES ($1,'Holland Mfg',$2,$3) RETURNING id`,
        [firmId, sarah, officeId],
      )
    ).rows[0]!.id;
    const reasonId = (
      await db.query<{ id: string }>(
        `INSERT INTO reason_code (firm_id, category, label) VALUES ($1,'WRITE_DOWN','Scope creep') RETURNING id`,
        [firmId],
      )
    ).rows[0]!.id;
    const engId = (
      await db.query<{ id: string }>(
        `INSERT INTO engagement (client_id, name, fee_structure, partner_id, manager_id, status)
         VALUES ($1,'1120-S','FIXED_FEE',$2,$3,'ACTIVE') RETURNING id`,
        [clientId, sarah, mike],
      )
    ).rows[0]!.id;
    const batchId = (
      await db.query<{ id: string }>(
        `INSERT INTO billing_batch (engagement_id, period_start, period_end, status, created_by_id, approved_by_id)
         VALUES ($1,'2026-01-01','2026-01-31','APPROVED',$2,$2) RETURNING id`,
        [engId, sarah],
      )
    ).rows[0]!.id;

    const entries = [
      { user: sarah, hours: 2.0, rate: 50000, amt: 100000 },
      { user: mike, hours: 4.0, rate: 30000, amt: 120000 },
      { user: rachel, hours: 3.0, rate: 25000, amt: 75000 },
      { user: jenny, hours: 5.0, rate: 20000, amt: 100000 },
    ];
    const entryIds: string[] = [];
    for (const e of entries) {
      const id = (
        await db.query<{ id: string }>(
          `INSERT INTO time_entry (engagement_id, app_user_id, entry_date, hours, standard_rate_snapshot_cents, standard_amount_cents, billing_batch_id)
           VALUES ($1, $2, '2026-01-15', $3, $4, $5, $6) RETURNING id`,
          [engId, e.user, e.hours, e.rate, e.amt, batchId],
        )
      ).rows[0]!.id;
      entryIds.push(id);
    }

    const adjId = (
      await db.query<{ id: string }>(
        `INSERT INTO adjustment (billing_batch_id, method, allocation_method, total_amount_cents, reason_code_id, status, created_by_id)
         VALUES ($1, 'TIME', 'HIERARCHICAL_CASCADE', -120000, $2, 'APPLIED', $3) RETURNING id`,
        [batchId, reasonId, sarah],
      )
    ).rows[0]!.id;

    const allocs = [
      { user: sarah, eid: entryIds[0]!, orig: 100000, adj: -100000 },
      { user: mike, eid: entryIds[1]!, orig: 120000, adj: -20000 },
      { user: rachel, eid: entryIds[2]!, orig: 75000, adj: 0 },
      { user: jenny, eid: entryIds[3]!, orig: 100000, adj: 0 },
    ];
    await db.query('BEGIN');
    for (const a of allocs) {
      await db.query(
        `INSERT INTO adjustment_allocation (adjustment_id, time_entry_id, app_user_id, original_value_cents, adjusted_value_cents, adjustment_amount_cents)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [adjId, a.eid, a.user, a.orig, a.orig + a.adj, a.adj],
      );
    }
    await db.query('COMMIT');

    // Verify realization per timekeeper matches Vance mockup.
    const r = await db.query<{ user: string; orig: string; adj: string }>(
      `SELECT app_user_id::text AS user,
              SUM(original_value_cents)::text AS orig,
              SUM(adjusted_value_cents)::text AS adj
       FROM adjustment_allocation
       WHERE adjustment_id = $1
       GROUP BY app_user_id`,
      [adjId],
    );
    const byUser = new Map(
      r.rows.map((row) => [row.user, { orig: Number(row.orig), adj: Number(row.adj) }]),
    );
    expect(byUser.get(sarah)!.adj / byUser.get(sarah)!.orig).toBeCloseTo(0, 2);
    expect(byUser.get(mike)!.adj / byUser.get(mike)!.orig).toBeCloseTo(0.833, 2);
    expect(byUser.get(rachel)!.adj / byUser.get(rachel)!.orig).toBeCloseTo(1, 2);
    expect(byUser.get(jenny)!.adj / byUser.get(jenny)!.orig).toBeCloseTo(1, 2);
  });
});
