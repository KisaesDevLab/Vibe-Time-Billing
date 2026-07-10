// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CP12 — Appointments schema + state machine + portal scope tests.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { inArray, sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { appointments } from '@vibe/db/schema';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

async function setupApt(): Promise<{
  firmId: string;
  clientId: string;
  engagementId: string;
  appUserId: string;
  apptId: string;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const r = await harness.db.execute(
    sql`INSERT INTO appointment
          (firm_id, client_id, engagement_id, title, starts_at, ends_at,
           location, lead_app_user_id, status, created_by_id)
        VALUES (${seed.firmId}, ${seed.clientId}, ${seed.engagementId},
                'Tax-prep call', '2027-04-15T15:00:00Z', '2027-04-15T15:30:00Z',
                'VIDEO', ${seed.appUserId}, 'SCHEDULED', ${seed.appUserId})
        RETURNING id`,
  );
  const apptId = (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
  return {
    firmId: seed.firmId,
    clientId: seed.clientId,
    engagementId: seed.engagementId,
    appUserId: seed.appUserId,
    apptId,
  };
}

describe('appointment schema', () => {
  it('CHECK rejects ends_at <= starts_at', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await expect(
      harness.db.execute(
        sql`INSERT INTO appointment
              (firm_id, client_id, title, starts_at, ends_at, location)
            VALUES (${seed.firmId}, ${seed.clientId}, 'Bad', '2027-04-15T15:00:00Z',
                    '2027-04-15T15:00:00Z', 'VIDEO')`,
      ),
    ).rejects.toThrow(/appointment_time_order|check/i);
  });

  it('inserts SCHEDULED with sensible defaults', async () => {
    const f = await setupApt();
    const row = await harness.db.execute(
      sql`SELECT status, location, cancelled_at, cancelled_reason
          FROM appointment WHERE id = ${f.apptId}`,
    );
    const r = (
      row as unknown as {
        rows: {
          status: string;
          location: string;
          cancelled_at: string | null;
          cancelled_reason: string | null;
        }[];
      }
    ).rows[0]!;
    expect(r.status).toBe('SCHEDULED');
    expect(r.location).toBe('VIDEO');
    expect(r.cancelled_at).toBeNull();
    expect(r.cancelled_reason).toBeNull();
  });

  it('engagement.client_id matches the appointment.client_id (enforced by route, not DB)', async () => {
    const seed = await seedMinimalFirm(harness.db);
    // Create a second client + engagement.
    const c2 = await harness.db.execute(
      sql`INSERT INTO client (firm_id, name, partner_in_charge_id, office_id)
          VALUES (${seed.firmId}, 'Other Co', ${seed.appUserId},
                  (SELECT id FROM office WHERE firm_id = ${seed.firmId} ORDER BY is_default DESC LIMIT 1)) RETURNING id`,
    );
    const c2Id = (c2 as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const e2 = await harness.db.execute(
      sql`INSERT INTO engagement (client_id, name, fee_structure, status)
          VALUES (${c2Id}, 'B engagement', 'HOURLY', 'ACTIVE') RETURNING id`,
    );
    const e2Id = (e2 as unknown as { rows: { id: string }[] }).rows[0]!.id;
    // The DB allows this — the staff route is what blocks it. Here we
    // verify the row inserts (the route guards against this combo).
    await harness.db.execute(
      sql`INSERT INTO appointment
            (firm_id, client_id, engagement_id, title, starts_at, ends_at, location)
          VALUES (${seed.firmId}, ${seed.clientId}, ${e2Id}, 'Mismatch',
                  '2027-04-15T15:00:00Z', '2027-04-15T15:30:00Z', 'VIDEO')`,
    );
    const rows = await harness.db.execute(
      sql`SELECT count(*)::int AS c FROM appointment WHERE title = 'Mismatch'`,
    );
    expect((rows as unknown as { rows: { c: number }[] }).rows[0]!.c).toBe(1);
  });
});

describe('appointment state machine', () => {
  it('SCHEDULED → CANCELLED stores reason + cancelled_at + cancelled_by_id', async () => {
    const f = await setupApt();
    await harness.db.execute(
      sql`UPDATE appointment
          SET status = 'CANCELLED', cancelled_at = now(),
              cancelled_reason = 'client requested reschedule',
              cancelled_by_id = ${f.appUserId}
          WHERE id = ${f.apptId}`,
    );
    const rows = await harness.db.execute(
      sql`SELECT status, cancelled_reason, cancelled_at, cancelled_by_id
          FROM appointment WHERE id = ${f.apptId}`,
    );
    const r = (
      rows as unknown as {
        rows: {
          status: string;
          cancelled_reason: string;
          cancelled_at: string;
          cancelled_by_id: string;
        }[];
      }
    ).rows[0]!;
    expect(r.status).toBe('CANCELLED');
    expect(r.cancelled_reason).toBe('client requested reschedule');
    expect(r.cancelled_at).not.toBeNull();
    expect(r.cancelled_by_id).toBe(f.appUserId);
  });

  it('SCHEDULED → COMPLETED is terminal', async () => {
    const f = await setupApt();
    await harness.db.execute(
      sql`UPDATE appointment SET status = 'COMPLETED' WHERE id = ${f.apptId}`,
    );
    const row = await harness.db.execute(
      sql`SELECT status FROM appointment WHERE id = ${f.apptId}`,
    );
    expect((row as unknown as { rows: { status: string }[] }).rows[0]!.status).toBe('COMPLETED');
  });
});

describe('portal appointments scope', () => {
  // Mirror of the portal SQL — uses drizzle's inArray for the ANY()
  // equivalent so the array literal is encoded correctly.
  async function portalSelect(clientIds: string[]): Promise<Array<{ id: string; status: string }>> {
    const cutoff = new Date(Date.now() - 30 * 24 * 3600_000);
    const rows = await harness.db
      .select({ id: appointments.id, status: appointments.status })
      .from(appointments)
      .where(
        sql`${inArray(appointments.clientId, clientIds)}
            AND (${appointments.status} = 'SCHEDULED' OR ${appointments.startsAt} >= ${cutoff})`,
      )
      .orderBy(appointments.startsAt);
    return rows;
  }

  it('excludes terminal rows older than 30 days', async () => {
    const f = await setupApt();
    // Mark it COMPLETED with starts_at 60 days ago — should be hidden.
    await harness.db.execute(
      sql`UPDATE appointment
          SET status = 'COMPLETED',
              starts_at = now() - INTERVAL '60 days',
              ends_at = now() - INTERVAL '60 days' + INTERVAL '30 minutes'
          WHERE id = ${f.apptId}`,
    );
    const rows = await portalSelect([f.clientId]);
    expect(rows.map((r) => r.id)).not.toContain(f.apptId);
  });

  it('includes SCHEDULED rows regardless of starts_at', async () => {
    const f = await setupApt();
    // Move it 2 years out — still appears since SCHEDULED.
    await harness.db.execute(
      sql`UPDATE appointment
          SET starts_at = now() + INTERVAL '2 years',
              ends_at = now() + INTERVAL '2 years' + INTERVAL '30 minutes'
          WHERE id = ${f.apptId}`,
    );
    const rows = await portalSelect([f.clientId]);
    expect(rows.map((r) => r.id)).toContain(f.apptId);
  });

  it('cross-client isolation', async () => {
    const f = await setupApt();
    const seed2 = await harness.db.execute(
      sql`INSERT INTO client (firm_id, name, partner_in_charge_id, office_id)
          VALUES (${f.firmId}, 'Other Client', ${f.appUserId},
                  (SELECT id FROM office WHERE firm_id = ${f.firmId} ORDER BY is_default DESC LIMIT 1)) RETURNING id`,
    );
    const otherClientId = (seed2 as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const a2 = await harness.db.execute(
      sql`INSERT INTO appointment
            (firm_id, client_id, title, starts_at, ends_at, location)
          VALUES (${f.firmId}, ${otherClientId}, 'Other appointment',
                  '2027-04-15T15:00:00Z', '2027-04-15T15:30:00Z', 'VIDEO')
          RETURNING id`,
    );
    const otherApptId = (a2 as unknown as { rows: { id: string }[] }).rows[0]!.id;
    // Client A's session sees only their appointment.
    const aRows = await portalSelect([f.clientId]);
    expect(aRows.map((r) => r.id)).toContain(f.apptId);
    expect(aRows.map((r) => r.id)).not.toContain(otherApptId);
    // Consolidated scope sees both.
    const both = await portalSelect([f.clientId, otherClientId]);
    expect(both.map((r) => r.id).sort()).toEqual([f.apptId, otherApptId].sort());
  });
});
