// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The approvals queue stores only {entityType, entityId}, so its Entity
// column used to render a bare uuid stub. /pending now resolves one human
// label per kind.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { sql } from 'drizzle-orm';

import { approvalRequests } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createApprovalRouter } from '../approvals/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
    };
    next();
  });
  app.use(
    '/api/staff/approvals',
    createApprovalRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['admin']]]),
    }),
  );
  return app;
}

async function insertId(query: ReturnType<typeof sql>): Promise<string> {
  const res = await harness.db.execute(query);
  return (res as unknown as { rows: { id: string }[] }).rows[0]!.id;
}

interface PendingRow {
  entityType: string;
  entityId: string;
  entityLabel: string | null;
}

describe('approvals queue entity labels', () => {
  it('labels an adjustment with its client and amount', async () => {
    const batchId = await insertId(
      sql`INSERT INTO billing_batch (engagement_id, period_start, period_end, created_by_id)
          VALUES (${seed.engagementId}, '2026-01-01', '2026-01-31', ${seed.appUserId})
          RETURNING id`,
    );
    const reasonCodeId = await insertId(
      sql`INSERT INTO reason_code (firm_id, category, label)
          VALUES (${seed.firmId}, 'WRITE_DOWN', 'Client goodwill') RETURNING id`,
    );
    const adjustmentId = await insertId(
      sql`INSERT INTO adjustment (billing_batch_id, method, allocation_method, total_amount_cents,
                                  reason_code_id, created_by_id)
          VALUES (${batchId}, 'FEE', 'PRO_RATA_BY_VALUE', -25000, ${reasonCodeId}, ${seed.appUserId})
          RETURNING id`,
    );
    await harness.db.insert(approvalRequests).values({
      entityType: 'ADJUSTMENT',
      entityId: adjustmentId,
      requesterId: seed.appUserId,
      status: 'PENDING',
    });

    const res = await request(buildApp()).get('/api/staff/approvals/pending');
    expect(res.status).toBe(200);
    const [row] = res.body.items as PendingRow[];
    expect(row!.entityId).toBe(adjustmentId); // full uuid still returned
    expect(row!.entityLabel).toBe('Test Client Co · $-250.00');
  });

  it('labels an invoice approval with the invoice number', async () => {
    const invoiceId = await insertId(
      sql`INSERT INTO invoice (firm_id, client_id, primary_engagement_id, invoice_number,
                               issue_date, due_date, subtotal_cents, total_cents, status)
          VALUES (${seed.firmId}, ${seed.clientId}, ${seed.engagementId}, 'INV-1001',
                  '2026-02-01', '2026-03-01', 100000, 100000, 'DRAFT')
          RETURNING id`,
    );
    await harness.db.insert(approvalRequests).values({
      entityType: 'INVOICE',
      entityId: invoiceId,
      requesterId: seed.appUserId,
      status: 'PENDING',
    });

    const res = await request(buildApp()).get('/api/staff/approvals/pending');
    const [row] = res.body.items as PendingRow[];
    expect(row!.entityLabel).toBe('INV-1001');
  });

  it('leaves entityLabel null for a kind with nothing to resolve', async () => {
    await harness.db.insert(approvalRequests).values({
      entityType: 'RATE_CHANGE',
      entityId: '00000000-0000-4000-8000-000000000000',
      requesterId: seed.appUserId,
      status: 'PENDING',
    });

    const res = await request(buildApp()).get('/api/staff/approvals/pending');
    const [row] = res.body.items as PendingRow[];
    // Null, not a throw — the UI falls back to the short-id stub.
    expect(row!.entityLabel).toBeNull();
  });
});
