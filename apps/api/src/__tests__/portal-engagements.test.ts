// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CP4 — Portal engagement status board tests.
//
// Two surfaces:
//   1. pillFor — pure status-derivation function. Tests pin all six
//      pill values across the engagement_status × workflow_state ×
//      open_request_count matrix.
//   2. Portal SQL — pglite tests assert cross-client scope + that
//      milestone progress + open-request counts compute correctly.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { pillFor } from '../portal/engagements';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

describe('pillFor — status derivation', () => {
  it('PAUSED engagement → paused (regardless of workflow)', () => {
    expect(
      pillFor({ engagementStatus: 'PAUSED', workflowState: 'IN_PROGRESS', openRequestCount: 5 }),
    ).toBe('paused');
  });

  it('CLOSED engagement → filed', () => {
    expect(
      pillFor({ engagementStatus: 'CLOSED', workflowState: 'NO_STATUS', openRequestCount: 0 }),
    ).toBe('filed');
  });

  it('PROPOSED engagement → scheduled', () => {
    expect(
      pillFor({ engagementStatus: 'PROPOSED', workflowState: 'NO_STATUS', openRequestCount: 0 }),
    ).toBe('scheduled');
  });

  it('ACTIVE + BLOCKED workflow → blocked (overrides request count)', () => {
    expect(
      pillFor({ engagementStatus: 'ACTIVE', workflowState: 'BLOCKED', openRequestCount: 0 }),
    ).toBe('blocked');
  });

  it('ACTIVE + open requests → awaiting_client', () => {
    expect(
      pillFor({ engagementStatus: 'ACTIVE', workflowState: 'IN_PROGRESS', openRequestCount: 2 }),
    ).toBe('awaiting_client');
  });

  it('ACTIVE + NOT_STARTED workflow → scheduled', () => {
    expect(
      pillFor({ engagementStatus: 'ACTIVE', workflowState: 'NOT_STARTED', openRequestCount: 0 }),
    ).toBe('scheduled');
  });

  it('ACTIVE + IN_PROGRESS + no requests → in_progress', () => {
    expect(
      pillFor({ engagementStatus: 'ACTIVE', workflowState: 'IN_PROGRESS', openRequestCount: 0 }),
    ).toBe('in_progress');
  });
});

describe('portal /engagements/active SQL', () => {
  // Mirror of the SQL fragment in apps/api/src/portal/engagements.ts so
  // tests run without booting Express. The Express + portal-auth surface
  // is covered by cross-realm tests.
  async function portalActive(clientId: string): Promise<Array<Record<string, unknown>>> {
    const exec = await harness.db.execute(
      sql`SELECT
            e.id,
            e.name,
            e.status                          AS engagement_status,
            e.workflow_state                  AS workflow_state,
            partner.full_name                 AS partner_name,
            (
              SELECT COUNT(*)::int FROM client_request cr
              WHERE cr.engagement_id = e.id AND cr.status = 'OPEN'
            )                                 AS open_request_count,
            (
              SELECT COUNT(*)::int FROM milestone m
              JOIN milestone_plan mp ON mp.id = m.plan_id
              WHERE mp.engagement_id = e.id
            )                                 AS total_milestones,
            (
              SELECT COUNT(*)::int FROM milestone m
              JOIN milestone_plan mp ON mp.id = m.plan_id
              WHERE mp.engagement_id = e.id AND m.status IN ('TRIGGERED', 'INVOICED')
            )                                 AS completed_milestones
          FROM engagement e
          LEFT JOIN app_user partner ON partner.id = e.partner_id
          WHERE e.client_id = ${clientId}
            AND e.status IN ('ACTIVE', 'PAUSED')
          ORDER BY e.created_at DESC`,
    );
    return (exec as unknown as { rows: Array<Record<string, unknown>> }).rows ?? [];
  }

  it('counts open client requests per engagement', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await harness.db.execute(
      sql`UPDATE engagement SET status = 'ACTIVE' WHERE id = ${seed.engagementId}`,
    );
    // Two open requests + one dismissed (which doesn't need fulfilled-actor cols).
    await harness.db.execute(
      sql`INSERT INTO client_request (firm_id, engagement_id, title, status)
          VALUES (${seed.firmId}, ${seed.engagementId}, 'Need W2', 'OPEN'),
                 (${seed.firmId}, ${seed.engagementId}, 'Need 1099', 'OPEN'),
                 (${seed.firmId}, ${seed.engagementId}, 'Need ID', 'DISMISSED')`,
    );
    const rows = await portalActive(seed.clientId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['open_request_count']).toBe(2);
  });

  it('counts triggered/invoiced milestones for progress denominator', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await harness.db.execute(
      sql`UPDATE engagement SET status = 'ACTIVE' WHERE id = ${seed.engagementId}`,
    );
    const planRes = await harness.db.execute(
      sql`INSERT INTO milestone_plan (engagement_id, total_fee_cents)
          VALUES (${seed.engagementId}, 100000) RETURNING id`,
    );
    const planId = (planRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
    await harness.db.execute(
      sql`INSERT INTO milestone (plan_id, name, amount_cents, sequence, trigger_type, status)
          VALUES (${planId}, 'Kickoff', 25000, 1, 'DATE', 'TRIGGERED'),
                 (${planId}, 'Mid',     25000, 2, 'DATE', 'INVOICED'),
                 (${planId}, 'Final',   25000, 3, 'DATE', 'PENDING')`,
    );
    const rows = await portalActive(seed.clientId);
    expect(rows[0]!['total_milestones']).toBe(3);
    expect(rows[0]!['completed_milestones']).toBe(2);
  });

  it('cross-client isolation: client A never sees client B engagements', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await harness.db.execute(
      sql`UPDATE engagement SET status = 'ACTIVE' WHERE id = ${seed.engagementId}`,
    );
    // Second client + engagement in the same firm.
    const c2 = await harness.db.execute(
      sql`INSERT INTO client (firm_id, name, partner_in_charge_id, office_id)
          VALUES (${seed.firmId}, 'Other Co', ${seed.appUserId},
                  (SELECT id FROM office WHERE firm_id = ${seed.firmId} ORDER BY is_default DESC LIMIT 1)) RETURNING id`,
    );
    const c2Id = (c2 as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const e2 = await harness.db.execute(
      sql`INSERT INTO engagement (client_id, name, fee_structure, status)
          VALUES (${c2Id}, 'Other engagement', 'HOURLY', 'ACTIVE')
          RETURNING id`,
    );
    const e2Id = (e2 as unknown as { rows: { id: string }[] }).rows[0]!.id;

    const aRows = await portalActive(seed.clientId);
    const bRows = await portalActive(c2Id);
    expect(aRows.map((r) => r['id'])).not.toContain(e2Id);
    expect(bRows.map((r) => r['id'])).toContain(e2Id);
    expect(bRows.map((r) => r['id'])).not.toContain(seed.engagementId);
  });

  it('CLOSED + PROPOSED engagements are excluded', async () => {
    const seed = await seedMinimalFirm(harness.db);
    // Default seed engagement status is HOURLY but engagement.status
    // defaults to 'PROPOSED' — should NOT appear in active view.
    const rows = await portalActive(seed.clientId);
    expect(rows).toHaveLength(0);
  });
});
