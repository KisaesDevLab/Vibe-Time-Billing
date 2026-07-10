// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CAL-4 — the unmatched review queue API (mounted at /api/staff/calendar).
// Lists events whose match is still pending and lets staff confirm a client,
// dismiss, or spin up a stub client from the event. Firm-scoped; new-client
// is gated on client:write.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { appUsers, calendarEventMatches, calendarEvents, clients, offices } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';

export interface CalendarMatchDeps extends RbacDeps {
  db: Database | null;
}

const ConfirmSchema = z.object({ clientId: z.string().uuid() });
const DismissSchema = z.object({ reason: z.string().max(500).optional() });

export function createCalendarMatchRouter(deps: CalendarMatchDeps): Router {
  const router = express.Router();

  async function loadMatchInFirm(db: Database, firmId: string, matchId: string) {
    const [row] = await db
      .select({
        match: calendarEventMatches,
        eventFirmId: calendarEvents.firmId,
        subject: calendarEvents.subject,
        organizerEmail: calendarEvents.organizerEmail,
        attendees: calendarEvents.attendees,
      })
      .from(calendarEventMatches)
      .innerJoin(calendarEvents, eq(calendarEvents.id, calendarEventMatches.eventId))
      .where(eq(calendarEventMatches.id, matchId))
      .limit(1);
    if (!row || row.eventFirmId !== firmId) return null;
    return row;
  }

  // GET /unmatched — pending matches (suggested client resolved) for the firm.
  router.get('/unmatched', async (req: Request, res: Response) => {
    const firmId = req.staffSession!.firmId;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const staffFilter = req.query['staffId'] ? String(req.query['staffId']) : null;
    const where = staffFilter
      ? and(
          eq(calendarEvents.firmId, firmId),
          eq(calendarEventMatches.matchStatus, 'pending'),
          eq(calendarEvents.staffId, staffFilter),
        )
      : and(eq(calendarEvents.firmId, firmId), eq(calendarEventMatches.matchStatus, 'pending'));
    const rows = await deps.db
      .select({
        matchId: calendarEventMatches.id,
        eventId: calendarEvents.id,
        subject: calendarEvents.subject,
        startAt: calendarEvents.startAt,
        organizerEmail: calendarEvents.organizerEmail,
        attendees: calendarEvents.attendees,
        staffId: calendarEvents.staffId,
        tier: calendarEventMatches.matchTier,
        score: calendarEventMatches.matchScore,
        suggestedClientId: calendarEventMatches.clientId,
        suggestedClientName: clients.name,
      })
      .from(calendarEventMatches)
      .innerJoin(calendarEvents, eq(calendarEvents.id, calendarEventMatches.eventId))
      .leftJoin(clients, eq(clients.id, calendarEventMatches.clientId))
      .where(where)
      .orderBy(desc(calendarEvents.startAt))
      .limit(500);
    res.json({ items: rows });
  });

  // GET /unmatched/count — badge count of this staff's pending events.
  router.get('/unmatched/count', async (req: Request, res: Response) => {
    const firmId = req.staffSession!.firmId;
    const staffId = req.staffSession!.appUserId;
    if (!deps.db) {
      res.json({ count: 0 });
      return;
    }
    const rows = await deps.db
      .select({ id: calendarEventMatches.id })
      .from(calendarEventMatches)
      .innerJoin(calendarEvents, eq(calendarEvents.id, calendarEventMatches.eventId))
      .where(
        and(
          eq(calendarEvents.firmId, firmId),
          eq(calendarEvents.staffId, staffId),
          eq(calendarEventMatches.matchStatus, 'pending'),
        ),
      );
    res.json({ count: rows.length });
  });

  // POST /matches/:id/confirm — link the chosen client.
  router.post('/matches/:id/confirm', async (req: Request, res: Response) => {
    const firmId = req.staffSession!.firmId;
    const actor = req.staffSession!.appUserId;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = ConfirmSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body' });
      return;
    }
    const row = await loadMatchInFirm(deps.db, firmId, req.params['id']!);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // The client must belong to the firm.
    const [client] = await deps.db
      .select({ id: clients.id })
      .from(clients)
      .where(and(eq(clients.id, parsed.data.clientId), eq(clients.firmId, firmId)))
      .limit(1);
    if (!client) {
      res.status(400).json({ error: 'unknown_client' });
      return;
    }
    await deps.db
      .update(calendarEventMatches)
      .set({
        clientId: parsed.data.clientId,
        matchTier: 'manual',
        matchStatus: 'confirmed',
        matchedBy: actor,
        matchedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(calendarEventMatches.id, row.match.id));
    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'calendar_event_match',
      entityId: row.match.id,
      actorAppUserId: actor,
      after: { clientId: parsed.data.clientId, status: 'confirmed' },
    });
    res.json({ ok: true });
  });

  // POST /matches/:id/dismiss — mark not-a-client.
  router.post('/matches/:id/dismiss', async (req: Request, res: Response) => {
    const firmId = req.staffSession!.firmId;
    const actor = req.staffSession!.appUserId;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = DismissSchema.safeParse(req.body ?? {});
    const row = await loadMatchInFirm(deps.db, firmId, req.params['id']!);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await deps.db
      .update(calendarEventMatches)
      .set({
        matchStatus: 'dismissed',
        matchedBy: actor,
        matchedAt: new Date(),
        dismissedReason: parsed.success ? (parsed.data.reason ?? null) : null,
        updatedAt: new Date(),
      })
      .where(eq(calendarEventMatches.id, row.match.id));
    res.json({ ok: true });
  });

  // POST /matches/:id/new-client — create a stub client from the event +
  // link it. Gated on client:write.
  router.post(
    '/matches/:id/new-client',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const actor = req.staffSession!.appUserId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const row = await loadMatchInFirm(deps.db, firmId, req.params['id']!);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      // Resolve an office: staff default → firm default → any.
      const [me] = await deps.db
        .select({ defaultOfficeId: appUsers.defaultOfficeId })
        .from(appUsers)
        .where(eq(appUsers.id, actor))
        .limit(1);
      let officeId = me?.defaultOfficeId ?? null;
      if (!officeId) {
        const [office] = await deps.db
          .select({ id: offices.id })
          .from(offices)
          .where(eq(offices.firmId, firmId))
          .orderBy(desc(offices.isDefault), asc(offices.createdAt))
          .limit(1);
        officeId = office?.id ?? null;
      }
      if (!officeId) {
        res.status(409).json({ error: 'no_office' });
        return;
      }
      // Derive a name from the subject, else the organizer's email local-part.
      const name =
        row.subject?.trim() || row.organizerEmail?.split('@')[0] || 'New client (from calendar)';
      const [created] = await deps.db
        .insert(clients)
        .values({ firmId, name, partnerInChargeId: actor, officeId, clientType: 'BUSINESS' })
        .returning({ id: clients.id });
      await deps.db
        .update(calendarEventMatches)
        .set({
          clientId: created!.id,
          matchTier: 'manual',
          matchStatus: 'confirmed',
          matchedBy: actor,
          matchedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(calendarEventMatches.id, row.match.id));
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'client',
        entityId: created!.id,
        actorAppUserId: actor,
        after: { name, via: 'calendar_match' },
      });
      res.status(201).json({ clientId: created!.id });
    },
  );

  return router;
}
