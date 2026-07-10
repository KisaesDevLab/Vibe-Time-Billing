// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0155 — Route Sheet printing. Staff print a "File Routing Sheet" for a
// client from the client list:
//
//   GET  /client/:clientId/engagements   uncompleted engagements + status options
//   POST /print                          commit status changes + record a print
//   GET  /:printId/pdf                    (re)render the stored snapshot → inline PDF
//   GET  /client/:clientId/history        recent prints for the history list
//
// Printing commits each changed engagement workflow_state via the same
// canonical path the engagement UI uses (audit + staged client
// notification), records who/when/note + per-engagement before/after and
// a render snapshot, and returns a printId. The PDF is (re)rendered from
// the snapshot so a reprint is faithful. Print gated on engagement:write;
// reads on engagement:read.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray, notInArray } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appUsers,
  clientContacts,
  clients,
  engagementAssignments,
  engagementStatusConfig,
  engagementStatusServiceLine,
  engagementTypes,
  engagements,
  persons,
  routeSheetPrintItems,
  routeSheetPrints,
  type RouteSheetItemSnapshot,
} from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';
import { stageStatusNotification } from '../notifications/staged/pipeline';
import { renderHtmlToPdf } from '../pdf/render';
import { renderRouteSheetHtml } from '../pdf-templates/route-sheet';
import { sendToPrinter } from '../print-gateway/send';

// Terminal states excluded from the "uncompleted" list. Shared with the
// payments CSV import, which must not bill a completed/cancelled engagement.
export const TERMINAL_WORKFLOW = ['COMPLETED', 'CANCELED'];
const TERMINAL_LIFECYCLE: Array<'CLOSED' | 'ARCHIVED'> = ['CLOSED', 'ARCHIVED'];

export interface RouteSheetRoutesDeps extends RbacDeps {
  db: Database | null;
  /** Test seam — defaults to the Puppeteer renderer. */
  renderPdf?: (html: string) => Promise<Buffer>;
}

function clientIp(req: Request): string {
  const fwd = req.header('x-forwarded-for');
  return (fwd ? fwd.split(',')[0]!.trim() : req.ip) ?? 'unknown';
}

function periodLabel(e: {
  periodLabel: string | null;
  periodYear: number | null;
  periodMonth: number | null;
}): string | null {
  if (e.periodLabel && e.periodLabel.trim()) return e.periodLabel;
  if (e.periodYear != null) {
    return e.periodMonth != null ? `${e.periodMonth}/${e.periodYear}` : String(e.periodYear);
  }
  return null;
}

function clientAddress(c: {
  mailingStreet1: string | null;
  mailingStreet2: string | null;
  mailingCity: string | null;
  mailingState: string | null;
  mailingPostal: string | null;
  billingAddress: string | null;
}): string | null {
  const parts = [
    c.mailingStreet1,
    c.mailingStreet2,
    [c.mailingCity, c.mailingState, c.mailingPostal].filter(Boolean).join(', '),
  ]
    .filter((p) => p && p.trim())
    .join(', ');
  return parts || c.billingAddress || null;
}

export function createRouteSheetRouter(deps: RouteSheetRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router, ['clientId', 'printId']);
  const renderPdf = deps.renderPdf ?? renderHtmlToPdf;

  // ── Assemble the render snapshot for one engagement ──────────────────
  async function buildSnapshot(
    db: Database,
    firmId: string,
    engagementId: string,
    workflowState: string,
    note: string,
  ): Promise<RouteSheetItemSnapshot | null> {
    const [e] = await db
      .select({
        id: engagements.id,
        name: engagements.name,
        clientId: engagements.clientId,
        partnerId: engagements.partnerId,
        managerId: engagements.managerId,
        periodLabel: engagements.periodLabel,
        periodYear: engagements.periodYear,
        periodMonth: engagements.periodMonth,
        dueDate: engagements.dueDate,
      })
      .from(engagements)
      .where(eq(engagements.id, engagementId))
      .limit(1);
    if (!e) return null;

    const [c] = await db
      .select({
        name: clients.name,
        mailingStreet1: clients.mailingStreet1,
        mailingStreet2: clients.mailingStreet2,
        mailingCity: clients.mailingCity,
        mailingState: clients.mailingState,
        mailingPostal: clients.mailingPostal,
        billingAddress: clients.billingAddress,
      })
      .from(clients)
      .where(and(eq(clients.id, e.clientId), eq(clients.firmId, firmId)))
      .limit(1);
    if (!c) return null;

    const staffName = async (id: string | null): Promise<string | null> => {
      if (!id) return null;
      const [u] = await db
        .select({ fullName: appUsers.fullName })
        .from(appUsers)
        .where(eq(appUsers.id, id))
        .limit(1);
      return u?.fullName ?? null;
    };
    const [partnerName, managerName] = await Promise.all([
      staffName(e.partnerId),
      staffName(e.managerId),
    ]);

    const assigneeRows = await db
      .select({ fullName: appUsers.fullName })
      .from(engagementAssignments)
      .innerJoin(appUsers, eq(appUsers.id, engagementAssignments.appUserId))
      .where(eq(engagementAssignments.engagementId, engagementId));
    const assignees = [...new Set(assigneeRows.map((r) => r.fullName).filter(Boolean))];

    // Contacts: prefer the canonical person record, fall back to the
    // legacy client_contact columns. Primary first.
    const contactRows = await db
      .select({
        isPrimary: clientContacts.isPrimary,
        cName: clientContacts.fullName,
        cEmail: clientContacts.email,
        cPhone: clientContacts.phone,
        cMobile: clientContacts.mobile,
        pName: persons.fullName,
        pEmail: persons.email,
        pPhone: persons.phone,
        pMobile: persons.mobile,
      })
      .from(clientContacts)
      .leftJoin(persons, eq(persons.id, clientContacts.personId))
      .where(eq(clientContacts.clientId, e.clientId))
      .orderBy(desc(clientContacts.isPrimary))
      .limit(2);
    const contacts = contactRows.map((r) => ({
      name: r.pName ?? r.cName ?? '',
      email: r.pEmail ?? r.cEmail ?? null,
      home: r.pPhone ?? r.cPhone ?? null,
      mobile: r.pMobile ?? r.cMobile ?? null,
    }));

    const [statusRow] = await db
      .select({ label: engagementStatusConfig.label })
      .from(engagementStatusConfig)
      .where(
        and(
          eq(engagementStatusConfig.firmId, firmId),
          eq(engagementStatusConfig.workflowState, workflowState),
        ),
      )
      .limit(1);

    return {
      engagementId: e.id,
      engagementName: e.name,
      workflowStateLabel: statusRow?.label ?? workflowState,
      periodLabel: periodLabel(e),
      dueDate: e.dueDate ?? null,
      partnerName,
      managerName,
      assignees,
      client: { name: c.name, address: clientAddress(c), contacts },
      note,
    };
  }

  // A client-only snapshot with the engagement section left blank — used when
  // there's no engagement selected/available, so staff get a fillable sheet.
  async function buildBlankSnapshot(
    db: Database,
    firmId: string,
    clientId: string,
    note: string,
  ): Promise<RouteSheetItemSnapshot | null> {
    const [c] = await db
      .select({
        name: clients.name,
        mailingStreet1: clients.mailingStreet1,
        mailingStreet2: clients.mailingStreet2,
        mailingCity: clients.mailingCity,
        mailingState: clients.mailingState,
        mailingPostal: clients.mailingPostal,
        billingAddress: clients.billingAddress,
      })
      .from(clients)
      .where(and(eq(clients.id, clientId), eq(clients.firmId, firmId)))
      .limit(1);
    if (!c) return null;

    const contactRows = await db
      .select({
        cName: clientContacts.fullName,
        cEmail: clientContacts.email,
        cPhone: clientContacts.phone,
        cMobile: clientContacts.mobile,
        pName: persons.fullName,
        pEmail: persons.email,
        pPhone: persons.phone,
        pMobile: persons.mobile,
      })
      .from(clientContacts)
      .leftJoin(persons, eq(persons.id, clientContacts.personId))
      .where(eq(clientContacts.clientId, clientId))
      .orderBy(desc(clientContacts.isPrimary))
      .limit(2);
    const contacts = contactRows.map((r) => ({
      name: r.pName ?? r.cName ?? '',
      email: r.pEmail ?? r.cEmail ?? null,
      home: r.pPhone ?? r.cPhone ?? null,
      mobile: r.pMobile ?? r.cMobile ?? null,
    }));

    return {
      engagementId: '',
      engagementName: '',
      workflowStateLabel: '',
      periodLabel: null,
      dueDate: null,
      partnerName: null,
      managerName: null,
      assignees: [],
      client: { name: c.name, address: clientAddress(c), contacts },
      note,
    };
  }

  // ── GET uncompleted engagements for the route-sheet dialog ───────────
  router.get(
    '/client/:clientId/engagements',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ items: [], statusOptions: [] });
        return;
      }
      const clientId = req.params['clientId']!;
      const [c] = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.id, clientId), eq(clients.firmId, firmId)))
        .limit(1);
      if (!c) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }
      const items = await deps.db
        .select({
          id: engagements.id,
          name: engagements.name,
          status: engagements.status,
          workflowState: engagements.workflowState,
          // 0167 — an engagement's service line is resolved via its type.
          serviceLineId: engagementTypes.serviceLineId,
          dueDate: engagements.dueDate,
          periodLabel: engagements.periodLabel,
          periodYear: engagements.periodYear,
          periodMonth: engagements.periodMonth,
        })
        .from(engagements)
        .leftJoin(engagementTypes, eq(engagements.engagementTypeId, engagementTypes.id))
        .where(
          and(
            eq(engagements.clientId, clientId),
            notInArray(engagements.status, TERMINAL_LIFECYCLE),
            notInArray(engagements.workflowState, TERMINAL_WORKFLOW),
          ),
        )
        .orderBy(desc(engagements.createdAt));
      const [statusRows, mappings] = await Promise.all([
        deps.db
          .select({
            workflowState: engagementStatusConfig.workflowState,
            label: engagementStatusConfig.label,
            sortOrder: engagementStatusConfig.sortOrder,
          })
          .from(engagementStatusConfig)
          .where(eq(engagementStatusConfig.firmId, firmId))
          .orderBy(engagementStatusConfig.sortOrder),
        deps.db
          .select({
            workflowState: engagementStatusServiceLine.workflowState,
            serviceLineId: engagementStatusServiceLine.serviceLineId,
          })
          .from(engagementStatusServiceLine)
          .where(eq(engagementStatusServiceLine.firmId, firmId)),
      ]);
      const byState = new Map<string, string[]>();
      for (const m of mappings) {
        const list = byState.get(m.workflowState);
        if (list) list.push(m.serviceLineId);
        else byState.set(m.workflowState, [m.serviceLineId]);
      }
      const statusOptions = statusRows.map((s) => ({
        ...s,
        serviceLineIds: (byState.get(s.workflowState) ?? []).sort(),
      }));
      res.json({
        items: items.map((e) => ({ ...e, period: periodLabel(e) })),
        statusOptions,
      });
    },
  );

  // ── POST commit status changes + record a print ─────────────────────
  const PrintSchema = z.object({
    clientId: z.string().uuid(),
    note: z.string().max(4000).optional(),
    // Empty items ⇒ a blank route sheet (no engagement selected/available).
    items: z
      .array(
        z.object({
          engagementId: z.string().uuid(),
          workflowState: z.string().min(1).max(120),
        }),
      )
      .max(50),
  });

  router.post('/print', requirePermission(deps, 'engagement:write'), async (req, res) => {
    const session = req.staffSession!;
    const firmId = session.firmId;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = PrintSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', detail: parsed.error.flatten() });
      return;
    }
    const note = parsed.data.note?.trim() ?? '';
    const ids = parsed.data.items.map((i) => i.engagementId);

    // Confirm the client is in this firm.
    const [client] = await deps.db
      .select({ id: clients.id })
      .from(clients)
      .where(and(eq(clients.id, parsed.data.clientId), eq(clients.firmId, firmId)))
      .limit(1);
    if (!client) {
      res.status(404).json({ error: 'client_not_found' });
      return;
    }

    // One record per page: an engagement snapshot, or — when no engagement is
    // selected/available — a single client-only "blank" snapshot.
    const itemRecords: Array<{
      engagementId: string | null;
      before: string | null;
      after: string | null;
      snapshot: RouteSheetItemSnapshot;
    }> = [];

    if (ids.length === 0) {
      const snapshot = await buildBlankSnapshot(deps.db, firmId, parsed.data.clientId, note);
      if (!snapshot) {
        res.status(500).json({ error: 'snapshot_failed' });
        return;
      }
      itemRecords.push({ engagementId: null, before: null, after: null, snapshot });
    } else {
      // Load the engagements (firm-scoped, on this client) + their current state.
      const rows = await deps.db
        .select({
          id: engagements.id,
          clientId: engagements.clientId,
          workflowState: engagements.workflowState,
        })
        .from(engagements)
        .where(and(eq(engagements.clientId, parsed.data.clientId), inArray(engagements.id, ids)));
      const byId = new Map(rows.map((r) => [r.id, r]));
      // Every requested engagement must belong to this client.
      if (rows.length !== new Set(ids).size) {
        res.status(400).json({ error: 'engagement_not_on_client' });
        return;
      }
      // Validate every target workflowState against the firm catalog.
      const validStates = new Set(
        (
          await deps.db
            .select({ ws: engagementStatusConfig.workflowState })
            .from(engagementStatusConfig)
            .where(eq(engagementStatusConfig.firmId, firmId))
        ).map((r) => r.ws),
      );
      for (const it of parsed.data.items) {
        if (!validStates.has(it.workflowState)) {
          res.status(400).json({ error: 'invalid_workflow_state', detail: it.workflowState });
          return;
        }
      }

      // Commit each changed workflow_state via the canonical path: update,
      // audit, stage the configured client notification. Build a snapshot
      // per engagement for the print record / reprint.
      for (const it of parsed.data.items) {
        const cur = byId.get(it.engagementId)!;
        const before = cur.workflowState;
        const after = it.workflowState;
        if (before !== after) {
          await deps.db
            .update(engagements)
            .set({ workflowState: after, updatedAt: new Date() })
            .where(eq(engagements.id, it.engagementId));
          await emitAudit(deps.db, {
            action: 'UPDATE',
            entityType: 'engagement_workflow_state',
            entityId: it.engagementId,
            actorAppUserId: session.appUserId,
            before: { workflowState: before },
            after: { workflowState: after },
            ip: clientIp(req),
            userAgent: req.header('user-agent') ?? null,
          }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
          void stageStatusNotification(deps.db, {
            firmId,
            engagementId: it.engagementId,
            clientId: parsed.data.clientId,
            fromState: before,
            toState: after,
            actorAppUserId: session.appUserId,
            ip: clientIp(req),
            userAgent: req.header('user-agent') ?? null,
          }).catch((err: unknown) => logger.error({ err }, 'status notification staging failed'));
        }
        const snapshot = await buildSnapshot(deps.db, firmId, it.engagementId, after, note);
        if (!snapshot) {
          res.status(500).json({ error: 'snapshot_failed' });
          return;
        }
        itemRecords.push({ engagementId: it.engagementId, before, after, snapshot });
      }
    }

    // Render once to validate the template/Puppeteer path succeeds before
    // we persist the print (bytes are re-derivable from the snapshot).
    try {
      await renderPdf(renderRouteSheetHtml(itemRecords.map((r) => r.snapshot)));
    } catch (err) {
      logger.error({ err }, 'route-sheet render failed');
      res.status(502).json({ error: 'render_failed' });
      return;
    }

    const [print] = await deps.db
      .insert(routeSheetPrints)
      .values({
        firmId,
        clientId: parsed.data.clientId,
        createdByAppUserId: session.appUserId,
        note: note || null,
      })
      .returning({ id: routeSheetPrints.id });
    const printId = print!.id;
    for (const r of itemRecords) {
      await deps.db.insert(routeSheetPrintItems).values({
        routeSheetPrintId: printId,
        engagementId: r.engagementId,
        workflowStateBefore: r.before,
        workflowStateAfter: r.after,
        snapshotJson: r.snapshot,
      });
    }
    await emitAudit(deps.db, {
      action: 'EXPORT',
      entityType: 'route_sheet_print',
      entityId: printId,
      actorAppUserId: session.appUserId,
      after: {
        clientId: parsed.data.clientId,
        note,
        items: itemRecords.map((r) => ({
          engagementId: r.engagementId,
          before: r.before,
          after: r.after,
        })),
      },
      ip: clientIp(req),
      userAgent: req.header('user-agent') ?? null,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

    res.status(201).json({ printId, pages: itemRecords.length });
  });

  // ── GET (re)render the stored snapshot → inline PDF ─────────────────
  router.get(
    '/:printId/pdf',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [print] = await deps.db
        .select({ id: routeSheetPrints.id, clientId: routeSheetPrints.clientId })
        .from(routeSheetPrints)
        .where(
          and(eq(routeSheetPrints.id, req.params['printId']!), eq(routeSheetPrints.firmId, firmId)),
        )
        .limit(1);
      if (!print) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const items = await deps.db
        .select({ snapshot: routeSheetPrintItems.snapshotJson })
        .from(routeSheetPrintItems)
        .where(eq(routeSheetPrintItems.routeSheetPrintId, print.id));
      const snapshots = items
        .map((i) => i.snapshot)
        .filter((s): s is RouteSheetItemSnapshot => !!s);
      if (snapshots.length === 0) {
        res.status(404).json({ error: 'empty_print' });
        return;
      }
      try {
        const pdf = await renderPdf(renderRouteSheetHtml(snapshots));
        const name = snapshots[0]!.client.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="route-sheet-${name}.pdf"`);
        res.send(pdf);
      } catch (err) {
        logger.error({ err }, 'route-sheet reprint render failed');
        res.status(502).json({ error: 'render_failed' });
      }
    },
  );

  // ── POST direct-print the stored snapshot to a gateway printer ──────
  const DirectPrintSchema = z.object({
    printerId: z.number().int().positive(),
    copies: z.number().int().min(1).max(20).optional(),
  });
  router.post(
    '/:printId/print',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = DirectPrintSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const [print] = await deps.db
        .select({ id: routeSheetPrints.id })
        .from(routeSheetPrints)
        .where(
          and(
            eq(routeSheetPrints.id, req.params['printId']!),
            eq(routeSheetPrints.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!print) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const items = await deps.db
        .select({ snapshot: routeSheetPrintItems.snapshotJson })
        .from(routeSheetPrintItems)
        .where(eq(routeSheetPrintItems.routeSheetPrintId, print.id));
      const snapshots = items
        .map((i) => i.snapshot)
        .filter((s): s is RouteSheetItemSnapshot => !!s);
      if (snapshots.length === 0) {
        res.status(404).json({ error: 'empty_print' });
        return;
      }
      let pdf: Buffer;
      try {
        pdf = await renderPdf(renderRouteSheetHtml(snapshots));
      } catch (err) {
        logger.error({ err }, 'route-sheet print render failed');
        res.status(502).json({ error: 'render_failed' });
        return;
      }
      const result = await sendToPrinter({
        db: deps.db,
        firmId: session.firmId,
        appUserId: session.appUserId,
        printableType: 'route_sheet',
        printableId: print.id,
        pdf,
        printerId: parsed.data.printerId,
        copies: parsed.data.copies ?? 1,
      });
      if (!result.ok) {
        res.status(502).json({ error: result.error });
        return;
      }
      res.json({ ok: true, jobId: result.jobId });
    },
  );

  // ── GET recent prints for a client (history list) ───────────────────
  router.get(
    '/client/:clientId/history',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const clientId = req.params['clientId']!;
      const rows = await deps.db
        .select({
          id: routeSheetPrints.id,
          note: routeSheetPrints.note,
          printedAt: routeSheetPrints.printedAt,
          staffName: appUsers.fullName,
        })
        .from(routeSheetPrints)
        .leftJoin(appUsers, eq(appUsers.id, routeSheetPrints.createdByAppUserId))
        .where(and(eq(routeSheetPrints.firmId, firmId), eq(routeSheetPrints.clientId, clientId)))
        .orderBy(desc(routeSheetPrints.printedAt))
        .limit(50);
      // Per-print engagement count.
      const counts = new Map<string, number>();
      if (rows.length > 0) {
        const itemRows = await deps.db
          .select({
            printId: routeSheetPrintItems.routeSheetPrintId,
            engagementId: routeSheetPrintItems.engagementId,
          })
          .from(routeSheetPrintItems)
          .where(
            inArray(
              routeSheetPrintItems.routeSheetPrintId,
              rows.map((r) => r.id),
            ),
          );
        // Count only real engagements — a blank sheet's null-engagement row
        // shouldn't read as "1 engagement".
        for (const ir of itemRows) {
          if (ir.engagementId) counts.set(ir.printId, (counts.get(ir.printId) ?? 0) + 1);
        }
      }
      res.json({
        items: rows.map((r) => ({ ...r, engagementCount: counts.get(r.id) ?? 0 })),
      });
    },
  );

  return router;
}
