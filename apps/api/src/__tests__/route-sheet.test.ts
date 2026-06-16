// SPDX-License-Identifier: Elastic-2.0
//
// 0155 — Route Sheet printing: uncompleted-engagement listing, print
// (commit workflow-state changes + record), faithful reprint from
// snapshot, permission gates, and the HTML template.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { and, eq, sql } from 'drizzle-orm';

import { auditLog, engagements, routeSheetPrintItems, routeSheetPrints } from '@vibe/db/schema';
import type { RoleSlug } from '@vibe/core/rbac';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createRouteSheetRouter } from '../route-sheets/routes';
import { renderRouteSheetHtml } from '../pdf-templates/route-sheet';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let lastHtml = '';

const fakeRender = async (html: string): Promise<Buffer> => {
  lastHtml = html;
  return Buffer.from('%PDF-1.4 fake');
};

function app(roles: RoleSlug[] = ['admin']): express.Express {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
    };
    next();
  });
  a.use(
    '/api/staff/route-sheets',
    createRouteSheetRouter({
      db: harness.db,
      fakeUserRoles: new Map<string, RoleSlug[]>([[seed.appUserId, roles]]),
      renderPdf: fakeRender,
    }),
  );
  return a;
}

async function addStatus(ws: string, label: string, sort: number): Promise<void> {
  await harness.db.execute(
    sql`INSERT INTO engagement_status_config (firm_id, workflow_state, label, sort_order)
        VALUES (${seed.firmId}, ${ws}, ${label}, ${sort})`,
  );
}

async function newEngagement(
  name: string,
  workflowState: string,
  status = 'ACTIVE',
): Promise<string> {
  const [row] = await harness.db
    .insert(engagements)
    .values({
      clientId: seed.clientId,
      name,
      feeStructure: 'HOURLY',
      workflowState,
      status: status as 'ACTIVE',
    })
    .returning({ id: engagements.id });
  return row!.id;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  lastHtml = '';
  await addStatus('NO_STATUS', 'No status', 90);
  await addStatus('NOT_STARTED', 'Not started', 10);
  await addStatus('READY', 'Ready', 20);
  await addStatus('COMPLETED', 'Completed', 70);
  // The seed already made one engagement (NO_STATUS / ACTIVE).
});
afterEach(async () => {
  await harness.close();
});

describe('GET uncompleted engagements', () => {
  it('includes NO_STATUS / NOT_STARTED, excludes COMPLETED + CLOSED', async () => {
    const ready = await newEngagement('Ready job', 'READY');
    await newEngagement('Done job', 'COMPLETED');
    await newEngagement('Closed job', 'NOT_STARTED', 'CLOSED');
    const notStarted = await newEngagement('Fresh job', 'NOT_STARTED');

    const r = await request(app()).get(
      `/api/staff/route-sheets/client/${seed.clientId}/engagements`,
    );
    expect(r.status).toBe(200);
    const ids = (r.body.items as { id: string }[]).map((e) => e.id);
    expect(ids).toContain(ready);
    expect(ids).toContain(notStarted);
    expect(ids).toContain(seed.engagementId); // seeded NO_STATUS
    // Completed + closed excluded.
    const names = (r.body.items as { name: string }[]).map((e) => e.name);
    expect(names).not.toContain('Done job');
    expect(names).not.toContain('Closed job');
    // Status options returned.
    expect((r.body.statusOptions as unknown[]).length).toBeGreaterThanOrEqual(4);
  });
});

describe('POST /print', () => {
  it('commits changed status, records print + items + audit, returns printId', async () => {
    const engA = await newEngagement('Engagement A', 'NOT_STARTED');
    const engB = await newEngagement('Engagement B', 'READY');

    const res = await request(app())
      .post('/api/staff/route-sheets/print')
      .send({
        clientId: seed.clientId,
        note: 'Call before pickup',
        items: [
          { engagementId: engA, workflowState: 'READY' }, // changed
          { engagementId: engB, workflowState: 'READY' }, // unchanged
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.pages).toBe(2);
    const printId = res.body.printId as string;

    // A's workflow_state actually changed.
    const [a] = await harness.db
      .select({ ws: engagements.workflowState })
      .from(engagements)
      .where(eq(engagements.id, engA));
    expect(a!.ws).toBe('READY');

    // Parent + two items persisted with before/after + snapshot.
    const [print] = await harness.db
      .select()
      .from(routeSheetPrints)
      .where(eq(routeSheetPrints.id, printId));
    expect(print!.note).toBe('Call before pickup');
    expect(print!.createdByAppUserId).toBe(seed.appUserId);
    const items = await harness.db
      .select()
      .from(routeSheetPrintItems)
      .where(eq(routeSheetPrintItems.routeSheetPrintId, printId));
    expect(items).toHaveLength(2);
    const aItem = items.find((i) => i.engagementId === engA)!;
    expect(aItem.workflowStateBefore).toBe('NOT_STARTED');
    expect(aItem.workflowStateAfter).toBe('READY');
    expect(aItem.snapshotJson?.note).toBe('Call before pickup');
    const bItem = items.find((i) => i.engagementId === engB)!;
    expect(bItem.workflowStateBefore).toBe('READY');
    expect(bItem.workflowStateAfter).toBe('READY'); // unchanged

    // Audit row for the print.
    const audits = await harness.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'route_sheet_print'), eq(auditLog.entityId, printId)));
    expect(audits).toHaveLength(1);
  });

  it('prints a blank sheet (no engagements) — one client-only item, no status changes', async () => {
    const res = await request(app())
      .post('/api/staff/route-sheets/print')
      .send({ clientId: seed.clientId, note: 'Walk-in drop-off', items: [] });
    expect(res.status).toBe(201);
    expect(res.body.pages).toBe(1);
    const printId = res.body.printId as string;

    const items = await harness.db
      .select()
      .from(routeSheetPrintItems)
      .where(eq(routeSheetPrintItems.routeSheetPrintId, printId));
    expect(items).toHaveLength(1);
    expect(items[0]!.engagementId).toBeNull();
    expect(items[0]!.workflowStateAfter).toBeNull();
    expect(items[0]!.snapshotJson?.engagementName).toBe('');
    expect(items[0]!.snapshotJson?.client.name).toBe('Test Client Co');
    expect(items[0]!.snapshotJson?.note).toBe('Walk-in drop-off');

    // History counts zero real engagements for a blank sheet.
    const hist = await request(app()).get(
      `/api/staff/route-sheets/client/${seed.clientId}/history`,
    );
    const entry = (hist.body.items as { id: string; engagementCount: number }[]).find(
      (e) => e.id === printId,
    )!;
    expect(entry.engagementCount).toBe(0);

    // Reprint renders the client-only sheet.
    lastHtml = '';
    const pdf = await request(app()).get(`/api/staff/route-sheets/${printId}/pdf`);
    expect(pdf.status).toBe(200);
    expect(lastHtml).toContain('FILE ROUTING SHEET');
    expect(lastHtml).toContain('Test Client Co');
    expect(lastHtml).toContain('Walk-in drop-off');
  });

  it('rejects an engagement that is not on the client', async () => {
    const other = await seedMinimalFirm(harness.db); // different client/engagement
    const res = await request(app())
      .post('/api/staff/route-sheets/print')
      .send({
        clientId: seed.clientId,
        items: [{ engagementId: other.engagementId, workflowState: 'READY' }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('engagement_not_on_client');
  });

  it('rejects an unknown workflow state', async () => {
    const eng = await newEngagement('Engagement X', 'NOT_STARTED');
    const res = await request(app())
      .post('/api/staff/route-sheets/print')
      .send({ clientId: seed.clientId, items: [{ engagementId: eng, workflowState: 'BOGUS' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_workflow_state');
  });

  it('403s without engagement:write', async () => {
    const eng = await newEngagement('Engagement Y', 'NOT_STARTED');
    const res = await request(app(['senior']))
      .post('/api/staff/route-sheets/print')
      .send({ clientId: seed.clientId, items: [{ engagementId: eng, workflowState: 'READY' }] });
    expect(res.status).toBe(403);
  });
});

describe('GET /:printId/pdf (reprint from snapshot)', () => {
  it('renders the stored snapshot inline; payload carries client/engagement/status/note', async () => {
    const eng = await newEngagement('Repeatable Job', 'NOT_STARTED');
    const created = await request(app())
      .post('/api/staff/route-sheets/print')
      .send({
        clientId: seed.clientId,
        note: 'Snapshot note here',
        items: [{ engagementId: eng, workflowState: 'READY' }],
      });
    const printId = created.body.printId as string;

    lastHtml = '';
    const r = await request(app()).get(`/api/staff/route-sheets/${printId}/pdf`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.headers['content-disposition']).toContain('inline');
    // The fake renderer captured the HTML built from the snapshot.
    expect(lastHtml).toContain('Repeatable Job');
    expect(lastHtml).toContain('Ready'); // status label, not the key
    expect(lastHtml).toContain('Snapshot note here');
  });
});

describe('renderRouteSheetHtml template', () => {
  it('emits one page per engagement and includes the key fields', () => {
    const html = renderRouteSheetHtml([
      {
        engagementId: 'e1',
        engagementName: 'Form 1040',
        workflowStateLabel: 'Ready',
        periodLabel: '2025',
        dueDate: '2026-04-15',
        partnerName: 'Pat Partner',
        managerName: 'Mary Manager',
        assignees: ['Sam Staff'],
        client: {
          name: 'Allen, David',
          address: '1 Main St',
          contacts: [{ name: 'David Allen', email: 'd@x.com', home: null, mobile: '555' }],
        },
        note: 'Handle with care',
      },
      {
        engagementId: 'e2',
        engagementName: 'Form 1120-S',
        workflowStateLabel: 'Not started',
        periodLabel: null,
        dueDate: null,
        partnerName: null,
        managerName: null,
        assignees: [],
        client: { name: 'Allen, David', address: null, contacts: [] },
        note: '',
      },
    ]);
    expect(html).toContain('FILE ROUTING SHEET');
    expect(html).toContain('Form 1040');
    expect(html).toContain('Form 1120-S');
    expect(html).toContain('Handle with care');
    expect(html).toContain('Pat Partner');
    // One page-break per sheet (last one auto via :last-child).
    expect((html.match(/class="sheet"/g) ?? []).length).toBe(2);
  });
});
