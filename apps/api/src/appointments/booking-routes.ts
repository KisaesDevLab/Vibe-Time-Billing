// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// BK-4 — multi-staff booking API. Mounted at /api/staff/appointments
// BEFORE the legacy single-staff router so the new create/cancel/detail
// paths take precedence; legacy create (POST /) still serves the old
// admin page + calendar write-back tests.
//
//   POST /book                                   — create (multi-staff)
//   POST /:id/reschedule                          — staff reschedule
//   POST /:id/cancel                              — staff cancel (multi-aware)
//   GET  /:id/detail                              — appt + staff + participants
//   GET  /reschedule-requests/count              — pending count (badge)
//   GET  /reschedule-requests                    — pending list (inbox)
//   POST /reschedule-requests/:requestId/accept  — accept (reschedule)
//   POST /reschedule-requests/:requestId/decline — decline
//
// Calendar fan-out + emails are enqueued (consumed by the worker in
// BK-5/BK-6). The slot is re-validated server-side; a taken slot → 409.

import crypto from 'node:crypto';

import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { and, asc, desc, eq, gte, ilike, inArray, lte, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import {
  appUsers,
  appointmentEngagementNotes,
  appointmentParticipants,
  appointmentRemindersSent,
  appointmentRescheduleRequests,
  appointmentStaff,
  appointmentTypes,
  appointments,
  clientContacts,
  clients,
  engagementNotes,
  engagements,
  offices,
  persons,
  staffBookingSettings,
  staffCalendarConnections,
} from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { createFreeBusyProvider } from '../calendar/freebusy';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';
import { getAvailableSlots, type StaffBusyProvider } from './availability';
import { bullBookingQueue, type BookingQueue } from './queue';

export interface BookingRoutesDeps extends RbacDeps {
  db: Database | null;
  queue?: BookingQueue;
  redis?: Redis | null;
  /** Test seam — free/busy source for slot re-validation. */
  busyProvider?: StaffBusyProvider;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/**
 * Best-effort invalidation of the BK-2 slot cache (`slots:{sortedIds}:…`)
 * for any cached combination that includes one of the affected staff. The
 * 2-minute TTL bounds staleness; this just makes a freshly-booked slot
 * disappear immediately. Never throws.
 */
async function bustSlotCache(redis: Redis | null | undefined, staffIds: string[]): Promise<void> {
  if (!redis || staffIds.length === 0) return;
  try {
    const affected = new Set(staffIds);
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'slots:*', 'COUNT', 200);
      cursor = next;
      const toDelete = keys.filter((k) => {
        const ids = k.split(':')[1]?.split(',') ?? [];
        return ids.some((id) => affected.has(id));
      });
      if (toDelete.length) await redis.del(...toDelete);
    } while (cursor !== '0');
  } catch (err) {
    logger.warn({ err }, 'slot cache bust failed');
  }
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/;
const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;

const BookSchema = z.object({
  staffIds: z.array(z.string().uuid()).min(1).max(10),
  appointmentTypeId: z.string().uuid().nullable().optional(),
  subject: z.string().min(1).max(240),
  startsAt: z.string().regex(ISO_RE),
  endsAt: z.string().regex(ISO_RE),
  durationMinutes: z.number().int().min(5).max(480).optional(),
  location: z.enum(['VIDEO', 'PHONE', 'IN_PERSON']).optional(),
  locationDetail: z.string().max(1000).nullable().optional(),
  clientId: z.string().uuid().nullable().optional(),
  engagementId: z.string().uuid().nullable().optional(),
  participantContactIds: z.array(z.string().uuid()).max(50).optional(),
  internalNotes: z.string().max(4000).nullable().optional(),
});

const RescheduleSchema = z.object({
  startsAt: z.string().regex(ISO_RE),
  endsAt: z.string().regex(ISO_RE),
});

async function firmTimezone(db: Database, firmId: string): Promise<string> {
  const [row] = await db
    .select({ tz: offices.timezone })
    .from(offices)
    .where(and(eq(offices.firmId, firmId), eq(offices.isDefault, true)))
    .limit(1);
  return row?.tz ?? 'America/Chicago';
}

function dateInTz(at: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function createBookingRouter(deps: BookingRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);
  const queue = deps.queue ?? bullBookingQueue;
  const nowFn = deps.now ?? ((): Date => new Date());

  function providerFor(firmId: string): StaffBusyProvider {
    return (
      deps.busyProvider ??
      createFreeBusyProvider({ db: deps.db!, firmId, fetchImpl: deps.fetchImpl })
    );
  }

  // ---- read helpers for the booking form -----------------------------
  router.get(
    '/bookable-staff',
    requirePermission(deps, 'appointment:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const rows = await deps.db
        .select({
          id: appUsers.id,
          name: appUsers.fullName,
          bookingEnabled: staffBookingSettings.bookingEnabled,
        })
        .from(appUsers)
        .leftJoin(staffBookingSettings, eq(staffBookingSettings.staffId, appUsers.id))
        .where(and(eq(appUsers.firmId, session.firmId), eq(appUsers.status, 'ACTIVE')));
      const conns = await deps.db
        .select({
          staffId: staffCalendarConnections.staffId,
          provider: staffCalendarConnections.provider,
        })
        .from(staffCalendarConnections)
        .where(
          and(
            eq(staffCalendarConnections.firmId, session.firmId),
            eq(staffCalendarConnections.enabled, true),
          ),
        );
      const providerByStaff = new Map<string, string>();
      for (const c of conns) if (c.staffId) providerByStaff.set(c.staffId, c.provider);
      const items = rows
        .map((r) => ({
          id: r.id,
          name: r.name,
          bookingEnabled: r.bookingEnabled ?? true,
          hasConnection: providerByStaff.has(r.id),
          provider: providerByStaff.get(r.id) ?? null,
        }))
        .filter((r) => r.bookingEnabled);
      res.json({ items });
    },
  );

  router.get(
    '/appointment-types',
    requirePermission(deps, 'appointment:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select()
        .from(appointmentTypes)
        .where(
          and(eq(appointmentTypes.firmId, session.firmId), eq(appointmentTypes.isActive, true)),
        )
        .orderBy(appointmentTypes.sortOrder);
      res.json({ items });
    },
  );

  // ---- enriched list (filters + staff stack + pagination) ------------
  router.get(
    '/list',
    requirePermission(deps, 'appointment:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [], total: 0, page: 1, pageSize: 25 });
        return;
      }
      const db = deps.db;
      const conds = [eq(appointments.firmId, session.firmId)];

      const status = typeof req.query['status'] === 'string' ? req.query['status'] : null;
      if (status === 'SCHEDULED' || status === 'COMPLETED' || status === 'CANCELLED') {
        conds.push(eq(appointments.status, status));
      }
      const clientId = typeof req.query['clientId'] === 'string' ? req.query['clientId'] : null;
      if (clientId && /^[0-9a-fA-F-]{36}$/.test(clientId)) {
        conds.push(eq(appointments.clientId, clientId));
      }
      const typeId = typeof req.query['typeId'] === 'string' ? req.query['typeId'] : null;
      if (typeId && /^[0-9a-fA-F-]{36}$/.test(typeId)) {
        conds.push(eq(appointments.appointmentTypeId, typeId));
      }
      const engagementId =
        typeof req.query['engagementId'] === 'string' ? req.query['engagementId'] : null;
      if (engagementId && /^[0-9a-fA-F-]{36}$/.test(engagementId)) {
        conds.push(eq(appointments.engagementId, engagementId));
      }
      const from = typeof req.query['from'] === 'string' ? new Date(req.query['from']) : null;
      if (from && !Number.isNaN(from.getTime())) conds.push(gte(appointments.startsAt, from));
      const to = typeof req.query['to'] === 'string' ? new Date(req.query['to']) : null;
      if (to && !Number.isNaN(to.getTime())) conds.push(lte(appointments.startsAt, to));
      const q = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';
      if (q) conds.push(ilike(appointments.title, `%${q}%`));

      // Staff filter: restrict to appointments that include this staff member.
      const staffId = typeof req.query['staffId'] === 'string' ? req.query['staffId'] : null;
      if (staffId && /^[0-9a-fA-F-]{36}$/.test(staffId)) {
        const withStaff = db
          .select({ id: appointmentStaff.appointmentId })
          .from(appointmentStaff)
          .where(eq(appointmentStaff.staffId, staffId));
        conds.push(inArray(appointments.id, withStaff));
      }

      const sortDir = req.query['sort'] === 'asc' ? asc : desc;
      const page = Math.max(1, Number(req.query['page']) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(req.query['pageSize']) || 25));

      const [{ n: total } = { n: 0 }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(appointments)
        .where(and(...conds));

      const rows = await db
        .select({
          id: appointments.id,
          title: appointments.title,
          startsAt: appointments.startsAt,
          endsAt: appointments.endsAt,
          status: appointments.status,
          location: appointments.location,
          clientId: appointments.clientId,
          clientName: clients.name,
          engagementId: appointments.engagementId,
          engagementName: engagements.name,
          typeName: appointmentTypes.name,
          typeColor: appointmentTypes.color,
        })
        .from(appointments)
        .leftJoin(clients, eq(clients.id, appointments.clientId))
        .leftJoin(engagements, eq(engagements.id, appointments.engagementId))
        .leftJoin(appointmentTypes, eq(appointmentTypes.id, appointments.appointmentTypeId))
        .where(and(...conds))
        .orderBy(sortDir(appointments.startsAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      const ids = rows.map((r) => r.id);
      const staffByAppt = new Map<string, { id: string; name: string }[]>();
      const pending = new Set<string>();
      if (ids.length > 0) {
        const staffRows = await db
          .select({
            appointmentId: appointmentStaff.appointmentId,
            id: appointmentStaff.staffId,
            name: appUsers.fullName,
          })
          .from(appointmentStaff)
          .innerJoin(appUsers, eq(appUsers.id, appointmentStaff.staffId))
          .where(inArray(appointmentStaff.appointmentId, ids));
        for (const s of staffRows) {
          const list = staffByAppt.get(s.appointmentId) ?? [];
          list.push({ id: s.id, name: s.name });
          staffByAppt.set(s.appointmentId, list);
        }
        const pendingRows = await db
          .select({ appointmentId: appointmentRescheduleRequests.appointmentId })
          .from(appointmentRescheduleRequests)
          .where(
            and(
              inArray(appointmentRescheduleRequests.appointmentId, ids),
              eq(appointmentRescheduleRequests.status, 'pending'),
            ),
          );
        for (const p of pendingRows) pending.add(p.appointmentId);
      }

      const items = rows.map((r) => ({
        ...r,
        staff: staffByAppt.get(r.id) ?? [],
        hasPendingReschedule: pending.has(r.id),
      }));
      res.json({ items, total, page, pageSize });
    },
  );

  // ---- create (multi-staff) ------------------------------------------
  router.post(
    '/book',
    requirePermission(deps, 'appointment:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = BookSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const db = deps.db;
      const data = parsed.data;
      const startsAt = new Date(data.startsAt);
      const endsAt = new Date(data.endsAt);
      if (endsAt.getTime() <= startsAt.getTime()) {
        res.status(400).json({ error: 'ends_before_starts' });
        return;
      }
      // Duration is ALWAYS derived from the times — never trust a client
      // durationMinutes (it would let a short validated slot persist a long
      // appointment that overruns the window / overlaps others).
      const durationMinutes = Math.round((endsAt.getTime() - startsAt.getTime()) / 60000);

      // Dedup staff (the array may repeat a member; appointment_staff has a
      // unique (appointment_id, staff_id) constraint that would 500 otherwise).
      const staffIds = [...new Set(data.staffIds)];

      // Staff must belong to the firm.
      const staff = await db
        .select({ id: appUsers.id })
        .from(appUsers)
        .where(and(inArray(appUsers.id, staffIds), eq(appUsers.firmId, session.firmId)));
      if (staff.length !== staffIds.length) {
        res.status(400).json({ error: 'unknown_staff' });
        return;
      }

      // An engagement may only be attached alongside its client.
      if (data.engagementId && !data.clientId) {
        res.status(400).json({ error: 'engagement_requires_client' });
        return;
      }

      // Client / engagement scoping.
      if (data.clientId) {
        const [c] = await db
          .select({ id: clients.id })
          .from(clients)
          .where(and(eq(clients.id, data.clientId), eq(clients.firmId, session.firmId)))
          .limit(1);
        if (!c) {
          res.status(404).json({ error: 'client_not_found' });
          return;
        }
        if (data.engagementId) {
          const [e] = await db
            .select({ id: engagements.id })
            .from(engagements)
            .where(
              and(eq(engagements.id, data.engagementId), eq(engagements.clientId, data.clientId)),
            )
            .limit(1);
          if (!e) {
            res.status(400).json({ error: 'engagement_not_in_client' });
            return;
          }
        }
      }

      // Appointment type (if any) must belong to the firm.
      if (data.appointmentTypeId) {
        const [t] = await db
          .select({ id: appointmentTypes.id })
          .from(appointmentTypes)
          .where(
            and(
              eq(appointmentTypes.id, data.appointmentTypeId),
              eq(appointmentTypes.firmId, session.firmId),
            ),
          )
          .limit(1);
        if (!t) {
          res.status(400).json({ error: 'unknown_appointment_type' });
          return;
        }
      }

      // Server-side slot re-validation (intersection across staff).
      const tz = await firmTimezone(db, session.firmId);
      const avail = await getAvailableSlots({
        db,
        staffIds,
        date: dateInTz(startsAt, tz),
        durationMinutes,
        timezone: tz,
        now: nowFn(),
        busyProvider: providerFor(session.firmId),
        location: data.location ?? 'VIDEO',
      });
      const match = avail.slots.find(
        (s) => s.start === startsAt.toISOString() && s.end === endsAt.toISOString(),
      );
      if (!match || !match.available) {
        const blocking = match?.staffAvailability.find((p) => !p.free)?.staffId ?? null;
        // `error` mirrors `code` so the FE api-client (which reads body.error)
        // surfaces it and the wizard can jump back to the time step.
        res.status(409).json({ error: 'slot_taken', code: 'slot_taken', staffId: blocking });
        return;
      }

      // Participants must belong to the client.
      const participantIds = [...new Set(data.participantContactIds ?? [])];
      if (participantIds.length > 0) {
        if (!data.clientId) {
          res.status(400).json({ error: 'participants_require_client' });
          return;
        }
        const valid = await db
          .select({ id: clientContacts.id })
          .from(clientContacts)
          .where(
            and(
              inArray(clientContacts.id, participantIds),
              eq(clientContacts.clientId, data.clientId),
            ),
          );
        if (valid.length !== participantIds.length) {
          res.status(400).json({ error: 'invalid_participant' });
          return;
        }
      }

      const cancelToken = crypto.randomUUID();
      const rescheduleToken = crypto.randomUUID();
      const tokenExpiresAt = new Date(endsAt.getTime() + TOKEN_TTL_MS);

      const appointmentId = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(appointments)
          .values({
            firmId: session.firmId,
            clientId: data.clientId ?? null,
            engagementId: data.engagementId ?? null,
            appointmentTypeId: data.appointmentTypeId ?? null,
            title: data.subject,
            startsAt,
            endsAt,
            durationMinutes,
            location: data.location ?? 'VIDEO',
            locationDetail: data.locationDetail ?? null,
            internalNotes: data.internalNotes ?? null,
            leadAppUserId: staffIds[0]!,
            status: 'SCHEDULED',
            cancelToken,
            rescheduleToken,
            tokenExpiresAt,
            createdById: session.appUserId,
          })
          .returning({ id: appointments.id });
        const apptId = row!.id;
        await tx
          .insert(appointmentStaff)
          .values(staffIds.map((staffId) => ({ appointmentId: apptId, staffId })));
        if (participantIds.length > 0) {
          await tx
            .insert(appointmentParticipants)
            .values(participantIds.map((cid) => ({ appointmentId: apptId, clientContactId: cid })));
        }
        if (data.engagementId) {
          const noteBody = `Appointment scheduled: ${data.subject} on ${startsAt.toISOString()}. Location: ${data.locationDetail ?? data.location ?? 'VIDEO'}.`;
          const [note] = await tx
            .insert(engagementNotes)
            .values({
              engagementId: data.engagementId,
              authorId: session.appUserId,
              body: noteBody,
            })
            .returning({ id: engagementNotes.id });
          await tx.insert(appointmentEngagementNotes).values({
            appointmentId: apptId,
            engagementId: data.engagementId,
            noteId: note!.id,
          });
        }
        return apptId;
      });

      // Fan-out: per-staff calendar write + one confirmation email.
      for (const staffId of staffIds) {
        await queue
          .providerWrite({ appointmentId, staffId })
          .catch((err: unknown) =>
            logger.warn({ err, appointmentId, staffId }, 'enqueue providerWrite failed'),
          );
      }
      if (participantIds.length > 0) {
        await queue
          .confirmationSend({ appointmentId })
          .catch((err: unknown) =>
            logger.warn({ err, appointmentId }, 'enqueue confirmation failed'),
          );
      }
      await bustSlotCache(deps.redis, staffIds);

      await emitAudit(db, {
        action: 'CREATE',
        entityType: 'appointment',
        entityId: appointmentId,
        actorAppUserId: session.appUserId,
        after: { subject: data.subject, staffIds, startsAt: data.startsAt },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

      res.status(201).json({ id: appointmentId, staffIds });
    },
  );

  // ---- detail (staff + participants + pending reschedule) ------------
  router.get(
    '/:id/detail',
    requirePermission(deps, 'appointment:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const db = deps.db;
      const [appt] = await db
        .select()
        .from(appointments)
        .where(and(eq(appointments.id, req.params['id']!), eq(appointments.firmId, session.firmId)))
        .limit(1);
      if (!appt) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const staff = await db
        .select({
          staffId: appointmentStaff.staffId,
          name: appUsers.fullName,
          writeStatus: appointmentStaff.providerWriteStatus,
          writeError: appointmentStaff.providerWriteError,
        })
        .from(appointmentStaff)
        .innerJoin(appUsers, eq(appUsers.id, appointmentStaff.staffId))
        .where(eq(appointmentStaff.appointmentId, appt.id));
      const participants = await db
        .select({
          id: appointmentParticipants.id,
          contactId: appointmentParticipants.clientContactId,
          name: persons.fullName,
          email: persons.email,
          rsvpStatus: appointmentParticipants.rsvpStatus,
          confirmationSentAt: appointmentParticipants.confirmationSentAt,
        })
        .from(appointmentParticipants)
        .innerJoin(clientContacts, eq(clientContacts.id, appointmentParticipants.clientContactId))
        .innerJoin(persons, eq(persons.id, clientContacts.personId))
        .where(eq(appointmentParticipants.appointmentId, appt.id));
      const requests = await db
        .select()
        .from(appointmentRescheduleRequests)
        .where(
          and(
            eq(appointmentRescheduleRequests.appointmentId, appt.id),
            eq(appointmentRescheduleRequests.status, 'pending'),
          ),
        );
      res.json({ appointment: appt, staff, participants, rescheduleRequests: requests });
    },
  );

  // ---- retry a failed per-staff calendar write -----------------------
  router.post(
    '/:id/staff/:staffId/retry-write',
    requirePermission(deps, 'appointment:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const db = deps.db;
      const [appt] = await db
        .select({ id: appointments.id })
        .from(appointments)
        .where(and(eq(appointments.id, req.params['id']!), eq(appointments.firmId, session.firmId)))
        .limit(1);
      if (!appt) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const staffId = req.params['staffId']!;
      await db
        .update(appointmentStaff)
        .set({ providerWriteStatus: 'pending', providerWriteError: null, updatedAt: new Date() })
        .where(
          and(eq(appointmentStaff.appointmentId, appt.id), eq(appointmentStaff.staffId, staffId)),
        );
      await queue
        .providerWrite({ appointmentId: appt.id, staffId })
        .catch((err: unknown) => logger.warn({ err }, 'enqueue retry providerWrite failed'));
      res.json({ ok: true });
    },
  );

  // ---- reschedule (staff) --------------------------------------------
  router.post(
    '/:id/reschedule',
    requirePermission(deps, 'appointment:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = RescheduleSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const out = await rescheduleAppointment(
        deps,
        queue,
        providerFor,
        nowFn,
        session.firmId,
        session.appUserId,
        req.params['id']!,
        new Date(parsed.data.startsAt),
        new Date(parsed.data.endsAt),
      );
      res.status(out.status).json(out.body);
    },
  );

  // ---- cancel (staff; multi-aware, supersedes legacy) ----------------
  router.post(
    '/:id/cancel',
    requirePermission(deps, 'appointment:write'),
    async (req: Request, res: Response, next: NextFunction) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const db = deps.db;
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : null;
      const [appt] = await db
        .select()
        .from(appointments)
        .where(and(eq(appointments.id, req.params['id']!), eq(appointments.firmId, session.firmId)))
        .limit(1);
      if (!appt) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const staffRows = await db
        .select({ staffId: appointmentStaff.staffId })
        .from(appointmentStaff)
        .where(eq(appointmentStaff.appointmentId, appt.id));
      // Legacy single-lead appts (no appointment_staff rows) fall through to
      // the legacy router's inline-delete cancel.
      if (staffRows.length === 0) {
        next();
        return;
      }
      if (appt.status !== 'SCHEDULED') {
        res.status(409).json({ error: 'not_cancellable', currentStatus: appt.status });
        return;
      }
      const now = nowFn();
      await db
        .update(appointments)
        .set({
          status: 'CANCELLED',
          cancelledAt: now,
          cancelledReason: reason,
          cancelledById: session.appUserId,
          cancelledByActor: 'staff',
          updatedAt: now,
        })
        .where(eq(appointments.id, appt.id));
      for (const r of staffRows) {
        await queue
          .providerDelete({ appointmentId: appt.id, staffId: r.staffId })
          .catch((err: unknown) => logger.warn({ err }, 'enqueue providerDelete failed'));
      }
      await queue
        .cancellationSend({ appointmentId: appt.id, cancelledBy: 'staff' })
        .catch((err: unknown) => logger.warn({ err }, 'enqueue cancellation failed'));
      await bustSlotCache(
        deps.redis,
        staffRows.map((r) => r.staffId),
      );
      await emitAudit(db, {
        action: 'UPDATE',
        entityType: 'appointment',
        entityId: appt.id,
        actorAppUserId: session.appUserId,
        before: { status: 'SCHEDULED' },
        after: { status: 'CANCELLED', cancelledBy: 'staff' },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  // ---- reschedule requests (inbox) -----------------------------------
  router.get(
    '/reschedule-requests/count',
    requirePermission(deps, 'appointment:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ count: 0 });
        return;
      }
      const [row] = await deps.db
        .select({ n: sql<number>`count(*)::int` })
        .from(appointmentRescheduleRequests)
        .innerJoin(appointments, eq(appointments.id, appointmentRescheduleRequests.appointmentId))
        .where(
          and(
            eq(appointments.firmId, session.firmId),
            eq(appointmentRescheduleRequests.status, 'pending'),
          ),
        );
      res.json({ count: row?.n ?? 0 });
    },
  );

  router.get(
    '/reschedule-requests',
    requirePermission(deps, 'appointment:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select({
          id: appointmentRescheduleRequests.id,
          appointmentId: appointmentRescheduleRequests.appointmentId,
          subject: appointments.title,
          startsAt: appointments.startsAt,
          message: appointmentRescheduleRequests.message,
          requestedAt: appointmentRescheduleRequests.requestedAt,
          contactName: persons.fullName,
        })
        .from(appointmentRescheduleRequests)
        .innerJoin(appointments, eq(appointments.id, appointmentRescheduleRequests.appointmentId))
        .leftJoin(
          clientContacts,
          eq(clientContacts.id, appointmentRescheduleRequests.requestedByContactId),
        )
        .leftJoin(persons, eq(persons.id, clientContacts.personId))
        .where(
          and(
            eq(appointments.firmId, session.firmId),
            eq(appointmentRescheduleRequests.status, 'pending'),
          ),
        )
        .orderBy(desc(appointmentRescheduleRequests.requestedAt));
      res.json({ items });
    },
  );

  router.post(
    '/reschedule-requests/:requestId/accept',
    requirePermission(deps, 'appointment:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = RescheduleSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const db = deps.db;
      const [reqRow] = await db
        .select({
          id: appointmentRescheduleRequests.id,
          appointmentId: appointmentRescheduleRequests.appointmentId,
          status: appointmentRescheduleRequests.status,
        })
        .from(appointmentRescheduleRequests)
        .innerJoin(appointments, eq(appointments.id, appointmentRescheduleRequests.appointmentId))
        .where(
          and(
            eq(appointmentRescheduleRequests.id, req.params['requestId']!),
            eq(appointments.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!reqRow) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (reqRow.status !== 'pending') {
        res.status(409).json({ error: 'already_resolved', status: reqRow.status });
        return;
      }
      const out = await rescheduleAppointment(
        deps,
        queue,
        providerFor,
        nowFn,
        session.firmId,
        session.appUserId,
        reqRow.appointmentId,
        new Date(parsed.data.startsAt),
        new Date(parsed.data.endsAt),
      );
      if (out.status >= 400) {
        res.status(out.status).json(out.body);
        return;
      }
      await db
        .update(appointmentRescheduleRequests)
        .set({ status: 'accepted', resolvedAt: nowFn(), resolvedByStaffId: session.appUserId })
        .where(
          and(
            eq(appointmentRescheduleRequests.id, reqRow.id),
            eq(appointmentRescheduleRequests.status, 'pending'),
          ),
        );
      res.json({ ok: true });
    },
  );

  router.post(
    '/reschedule-requests/:requestId/decline',
    requirePermission(deps, 'appointment:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const db = deps.db;
      const [reqRow] = await db
        .select({
          id: appointmentRescheduleRequests.id,
          status: appointmentRescheduleRequests.status,
        })
        .from(appointmentRescheduleRequests)
        .innerJoin(appointments, eq(appointments.id, appointmentRescheduleRequests.appointmentId))
        .where(
          and(
            eq(appointmentRescheduleRequests.id, req.params['requestId']!),
            eq(appointments.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!reqRow) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (reqRow.status !== 'pending') {
        res.status(409).json({ error: 'already_resolved', status: reqRow.status });
        return;
      }
      const declined = await db
        .update(appointmentRescheduleRequests)
        .set({ status: 'declined', resolvedAt: nowFn(), resolvedByStaffId: session.appUserId })
        .where(
          and(
            eq(appointmentRescheduleRequests.id, reqRow.id),
            eq(appointmentRescheduleRequests.status, 'pending'),
          ),
        )
        .returning({ appointmentId: appointmentRescheduleRequests.appointmentId });
      if (declined[0]) {
        await queue
          .declineSend({ appointmentId: declined[0].appointmentId })
          .catch((err: unknown) => logger.warn({ err }, 'enqueue decline email failed'));
      }
      res.json({ ok: true });
    },
  );

  return router;
}

/** Shared reschedule flow used by the staff endpoint + request-accept. */
async function rescheduleAppointment(
  deps: BookingRoutesDeps,
  queue: BookingQueue,
  providerFor: (firmId: string) => StaffBusyProvider,
  nowFn: () => Date,
  firmId: string,
  actorId: string,
  appointmentId: string,
  startsAt: Date,
  endsAt: Date,
): Promise<{ status: number; body: unknown }> {
  const db = deps.db!;
  if (endsAt.getTime() <= startsAt.getTime())
    return { status: 400, body: { error: 'ends_before_starts' } };
  const [appt] = await db
    .select()
    .from(appointments)
    .where(and(eq(appointments.id, appointmentId), eq(appointments.firmId, firmId)))
    .limit(1);
  if (!appt) return { status: 404, body: { error: 'not_found' } };
  if (appt.status !== 'SCHEDULED') {
    return { status: 409, body: { error: 'not_reschedulable', currentStatus: appt.status } };
  }
  const staffRows = await db
    .select({ staffId: appointmentStaff.staffId })
    .from(appointmentStaff)
    .where(eq(appointmentStaff.appointmentId, appt.id));
  const staffIds = staffRows.map((r) => r.staffId);
  if (staffIds.length === 0) return { status: 409, body: { error: 'no_staff_on_appointment' } };

  const durationMinutes = Math.round((endsAt.getTime() - startsAt.getTime()) / 60000);
  const tz = await firmTimezone(db, firmId);
  const avail = await getAvailableSlots({
    db,
    staffIds,
    date: dateInTz(startsAt, tz),
    durationMinutes,
    timezone: tz,
    now: nowFn(),
    busyProvider: providerFor(firmId),
    excludeAppointmentId: appt.id,
    location: appt.location,
  });
  const match = avail.slots.find(
    (s) => s.start === startsAt.toISOString() && s.end === endsAt.toISOString(),
  );
  if (!match || !match.available) {
    const blocking = match?.staffAvailability.find((p) => !p.free)?.staffId ?? null;
    return { status: 409, body: { error: 'slot_taken', code: 'slot_taken', staffId: blocking } };
  }
  const now = nowFn();
  await db
    .update(appointments)
    .set({ startsAt, endsAt, durationMinutes, lastRescheduledAt: now, updatedAt: now })
    .where(eq(appointments.id, appt.id));
  // Reset reminders so they re-fire against the new time.
  await db
    .delete(appointmentRemindersSent)
    .where(eq(appointmentRemindersSent.appointmentId, appt.id))
    .catch(() => undefined);
  for (const staffId of staffIds) {
    await queue
      .providerUpdate({ appointmentId: appt.id, staffId })
      .catch((err: unknown) => logger.warn({ err }, 'enqueue providerUpdate failed'));
  }
  await queue
    .rescheduleConfirmationSend({ appointmentId: appt.id })
    .catch((err: unknown) => logger.warn({ err }, 'enqueue reschedule confirmation failed'));
  await bustSlotCache(deps.redis, staffIds);
  await emitAudit(db, {
    action: 'UPDATE',
    entityType: 'appointment',
    entityId: appt.id,
    actorAppUserId: actorId,
    before: { startsAt: appt.startsAt, endsAt: appt.endsAt },
    after: { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() },
  }).catch(() => undefined);
  return { status: 200, body: { ok: true } };
}
