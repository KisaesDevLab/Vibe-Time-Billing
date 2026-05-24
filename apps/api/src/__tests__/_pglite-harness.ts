// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// In-process Postgres (PGlite) + Drizzle harness for DB-backed
// integration tests in apps/api. The runtime API is identical to
// postgres-js; only the driver bindings differ, so we cast to
// `Database` (the postgres-js Drizzle type) for the helper functions
// that consume it. This is the standard pglite-test pattern.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';

import * as schema from '@vibe/db/schema';
import type { Database } from '@vibe/db';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', '..', 'packages', 'db', 'migrations');

export interface PgliteHarness {
  pglite: PGlite;
  db: Database;
  close(): Promise<void>;
}

/**
 * Spin up a fresh pglite instance, run every migration in order, and
 * return a Drizzle instance bound to it. Each call is fully isolated.
 */
export async function buildPgliteHarness(): Promise<PgliteHarness> {
  const pglite = new PGlite();
  await applyAllMigrations(pglite);
  // drizzle-orm/pglite's database type isn't structurally identical to
  // postgres-js's; the runtime is the same, so cast for helper-fn
  // compatibility. The schema import is the source of truth.
  const db = drizzle(pglite, { schema }) as unknown as Database;
  return {
    pglite,
    db,
    async close() {
      await pglite.close();
    },
  };
}

async function applyAllMigrations(pglite: PGlite): Promise<void> {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    const raw = readFileSync(join(migrationsDir, f), 'utf8');
    // pglite is single-user — strip role/grant DDL that targets the
    // production app role.
    const cleaned = raw
      .replace(/DO \$\$\s*BEGIN\s*IF NOT EXISTS[\s\S]*?END\s*\$\$;?/g, '-- skipped role bootstrap')
      .replace(/^(REVOKE|GRANT) .*$/gim, '-- skipped grant/revoke');
    await pglite.exec(cleaned);
  }
}

/**
 * Insert a minimal firm + user + client + engagement chain so router
 * helpers that read these tables have something to find. Returns the
 * ids for chaining.
 */
export async function seedMinimalFirm(db: Database): Promise<{
  firmId: string;
  appUserId: string;
  clientId: string;
  engagementId: string;
  workCodeId: string;
  serviceLineId: string;
  rateCodeId: string;
}> {
  const firm = await db.execute(sql`INSERT INTO firm (name) VALUES ('Test Firm') RETURNING id`);
  const firmId = (firm as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const user = await db.execute(
    sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
        VALUES (${firmId}, 'sarah@test.example', 'Sarah Chen', 'Sarah', 'Chen') RETURNING id`,
  );
  const appUserId = (user as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const client = await db.execute(
    sql`INSERT INTO client (firm_id, name, partner_in_charge_id)
        VALUES (${firmId}, 'Test Client Co', ${appUserId}) RETURNING id`,
  );
  const clientId = (client as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const eng = await db.execute(
    sql`INSERT INTO engagement (client_id, name, fee_structure)
        VALUES (${clientId}, 'Test Engagement', 'HOURLY') RETURNING id`,
  );
  const engagementId = (eng as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const sl = await db.execute(
    sql`INSERT INTO service_line (firm_id, name, category)
        VALUES (${firmId}, 'Tax', 'tax') RETURNING id`,
  );
  const serviceLineId = (sl as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const wc = await db.execute(
    sql`INSERT INTO work_code (firm_id, key, name, service_line_id)
        VALUES (${firmId}, 'tax_prep', 'Tax Preparation', ${serviceLineId}) RETURNING id`,
  );
  const workCodeId = (wc as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const rc = await db.execute(
    sql`INSERT INTO rate_code (firm_id, code, description, is_system)
        VALUES (${firmId}, 'StandardRate', 'Standard billable rate', true) RETURNING id`,
  );
  const rateCodeId = (rc as unknown as { rows: { id: string }[] }).rows[0]!.id;
  return { firmId, appUserId, clientId, engagementId, workCodeId, serviceLineId, rateCodeId };
}

/**
 * Resolve the appliance lock state for crypto-aware tests. The
 * shipped `getApplianceLockState()` reads module-level state set at
 * boot — tests can short-circuit by stubbing the manager.
 */
export function fakeUnlockedState(firmId: string): {
  kind: 'unlocked';
  firmId: string;
} {
  return { kind: 'unlocked', firmId };
}
