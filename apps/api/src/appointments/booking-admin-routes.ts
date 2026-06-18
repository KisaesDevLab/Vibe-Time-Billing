// SPDX-License-Identifier: Elastic-2.0
//
// Staff-side management of public booking pages (0168): CRUD for the pages +
// their own availability windows + approver/notify lists, and the booking-
// request approval queue. Approving a request is what actually creates the
// appointment (single staff) and confirms the visitor; until then the request
// is just a PENDING hold. Mounted under /api/staff/appointments.

import crypto from 'node:crypto';

import express, { type Router } from 'express';
import { and, desc, eq, ne } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import {
  appUsers,
  appointmentStaff,
  appointmentTypes,
  appointments,
  bookingRequests,
  publicBookingAvailability,
  publicBookingLinkApprovers,
  publicBookingLinkNotify,
  staffPublicBookingLinks,
} from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';
import { firmScope, renderTemplate } from '../notifications/templating';
import { generateBookingSlug, normalizeCustomSlug } from './booking-slug';
import { findBookingConflict } from './availability';
import type { BookingQueue } from './queue';

export interface BookingAdminRoutesDeps extends RbacDeps {
  db: Database | null;
  redis?: Redis | null;
  queue?: BookingQueue;
  sendEmail?: (args: { to: string; subject: string; body: string }) => Promise<void>;
  staffBaseUrl?: string;
  /** Public base for building the shareable booking URL shown to staff. */
  intakeBaseUrl?: string;
  now?: () => Date;
}

const TOKEN_TTL_MS = 60 * 24 * 3600_000; // 60 days

const WindowSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  endTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  locationTypes: z
    .array(z.enum(['VIDEO', 'PHONE', 'IN_PERSON']))
    .nullable()
    .optional(),
  locationOptionId: z.string().uuid().nullable().optional(),
  appointmentTypeIds: z.array(z.string().uuid()).nullable().optional(),
});

const LinkSchema = z.object({
  staffId: z.string().uuid(),
  slug: z.string().max(50).optional(),
  customMessage: z.string().max(2000).nullable().optional(),
  allowedAppointmentTypeIds: z.array(z.string().uuid()).nullable().optional(),
  holdExpiryHours: z.number().int().min(1).max(720).optional(),
  slotIncrementMinutes: z.number().int().min(5).max(240).optional(),
  minNoticeHours: z.number().int().min(0).max(8760).optional(),
  bufferBeforeMinutes: z.number().int().min(0).max(240).optional(),
  bufferAfterMinutes: z.number().int().min(0).max(240).optional(),
  defaultDurationMinutes: z.number().int().min(5).max(480).optional(),
  requireCaptcha: z.boolean().optional(),
  dailyCap: z.number().int().min(1).max(1000).nullable().optional(),
  isActive: z.boolean().optional(),
  windows: z.array(WindowSchema).max(50).optional(),
  approverIds: z.array(z.string().uuid()).max(50).optional(),
  notify: z
    .array(z.object({ appUserId: z.string().uuid(), channels: z.array(z.enum(['EMAIL', 'SMS'])) }))
    .max(50)
    .optional(),
});

export function createBookingAdminRouter(deps: BookingAdminRoutesDeps): Router {
  const router = express.Router();
  const now = (): Date => (deps.now ? deps.now() : new Date());
  const publicUrl = (slug: string): string =>
    `${(deps.intakeBaseUrl ?? '').replace(/\/$/, '')}/book/${slug}`;

  // ---- booking pages CRUD -------------------------------------------

  async function uniqueSlug(
    db: Database,
    requested: string | undefined,
    excludeId?: string,
  ): Promise<string | null> {
    if (requested) {
      const norm = normalizeCustomSlug(requested);
      if (!norm) return null;
      const conds = [eq(staffPublicBookingLinks.slug, norm)];
      // When editing, a page keeping its own slug must not clash with itself.
      if (excludeId) conds.push(ne(staffPublicBookingLinks.id, excludeId));
      const [clash] = await db
        .select({ id: staffPublicBookingLinks.id })
        .from(staffPublicBookingLinks)
        .where(and(...conds))
        .limit(1);
      return clash ? null : norm;
    }
    for (let i = 0; i < 8; i++) {
      const candidate = generateBookingSlug();
      const [clash] = await db
        .select({ id: staffPublicBookingLinks.id })
        .from(staffPublicBookingLinks)
        .where(eq(staffPublicBookingLinks.slug, candidate))
        .limit(1);
      if (!clash) return candidate;
    }
    return null;
  }

  async function replaceChildren(
    tx: Database,
    linkId: string,
    data: {
      windows?: z.infer<typeof WindowSchema>[];
      approverIds?: string[];
      notify?: { appUserId: string; channels: ('EMAIL' | 'SMS')[] }[];
    },
  ): Promise<void> {
    if (data.windows) {
      await tx
        .delete(publicBookingAvailability)
        .where(eq(publicBookingAvailability.bookingLinkId, linkId));
      if (data.windows.length > 0) {
        await tx.insert(publicBookingAvailability).values(
          data.windows.map((w) => ({
            bookingLinkId: linkId,
            dayOfWeek: w.dayOfWeek,
            startTime: w.startTime,
            endTime: w.endTime,
            locationTypes: w.locationTypes ?? null,
            locationOptionId: w.locationOptionId ?? null,
            appointmentTypeIds: w.appointmentTypeIds ?? null,
          })),
        );
      }
    }
    if (data.approverIds) {
      await tx
        .delete(publicBookingLinkApprovers)
        .where(eq(publicBookingLinkApprovers.bookingLinkId, linkId));
      if (data.approverIds.length > 0) {
        await tx
          .insert(publicBookingLinkApprovers)
          .values(data.approverIds.map((appUserId) => ({ bookingLinkId: linkId, appUserId })));
      }
    }
    if (data.notify) {
      await tx
        .delete(publicBookingLinkNotify)
        .where(eq(publicBookingLinkNotify.bookingLinkId, linkId));
      if (data.notify.length > 0) {
        await tx.insert(publicBookingLinkNotify).values(
          data.notify.map((n) => ({
            bookingLinkId: linkId,
            appUserId: n.appUserId,
            channels: n.channels,
          })),
        );
      }
    }
  }

  router.get('/booking-links', requirePermission(deps, 'appointment:read'), async (req, res) => {
    const firmId = req.staffSession!.firmId;
    if (!deps.db) return void res.status(503).json({ error: 'db_unavailable' });
    const rows = await deps.db
      .select({
        id: staffPublicBookingLinks.id,
        slug: staffPublicBookingLinks.slug,
        staffId: staffPublicBookingLinks.staffId,
        staffName: appUsers.fullName,
        isActive: staffPublicBookingLinks.isActive,
        createdAt: staffPublicBookingLinks.createdAt,
      })
      .from(staffPublicBookingLinks)
      .innerJoin(appUsers, eq(appUsers.id, staffPublicBookingLinks.staffId))
      .where(eq(staffPublicBookingLinks.firmId, firmId))
      .orderBy(desc(staffPublicBookingLinks.createdAt));
    res.json({ items: rows.map((r) => ({ ...r, publicUrl: publicUrl(r.slug) })) });
  });

  router.get(
    '/booking-links/:id',
    requirePermission(deps, 'appointment:read'),
    async (req, res) => {
      const firmId = req.staffSession!.firmId;
      const id = String(req.params['id']);
      if (!deps.db) return void res.status(503).json({ error: 'db_unavailable' });
      const [link] = await deps.db
        .select()
        .from(staffPublicBookingLinks)
        .where(and(eq(staffPublicBookingLinks.id, id), eq(staffPublicBookingLinks.firmId, firmId)))
        .limit(1);
      if (!link) return void res.status(404).json({ error: 'not_found' });
      const windows = await deps.db
        .select()
        .from(publicBookingAvailability)
        .where(eq(publicBookingAvailability.bookingLinkId, id));
      const approvers = await deps.db
        .select({ appUserId: publicBookingLinkApprovers.appUserId })
        .from(publicBookingLinkApprovers)
        .where(eq(publicBookingLinkApprovers.bookingLinkId, id));
      const notify = await deps.db
        .select({
          appUserId: publicBookingLinkNotify.appUserId,
          channels: publicBookingLinkNotify.channels,
        })
        .from(publicBookingLinkNotify)
        .where(eq(publicBookingLinkNotify.bookingLinkId, id));
      res.json({
        link,
        publicUrl: publicUrl(link.slug),
        windows,
        approverIds: approvers.map((a) => a.appUserId),
        notify,
      });
    },
  );

  router.post('/booking-links', requirePermission(deps, 'appointment:write'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) return void res.status(503).json({ error: 'db_unavailable' });
    const parsed = LinkSchema.safeParse(req.body);
    if (!parsed.success)
      return void res
        .status(400)
        .json({ error: 'invalid_payload', issues: parsed.error.flatten() });
    const data = parsed.data;
    // Staff must belong to the firm.
    const [staff] = await deps.db
      .select({ id: appUsers.id })
      .from(appUsers)
      .where(and(eq(appUsers.id, data.staffId), eq(appUsers.firmId, session.firmId)))
      .limit(1);
    if (!staff) return void res.status(400).json({ error: 'unknown_staff' });
    const slug = await uniqueSlug(deps.db, data.slug);
    if (!slug) return void res.status(409).json({ error: 'slug_unavailable' });
    let linkId = '';
    await deps.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(staffPublicBookingLinks)
        .values({
          firmId: session.firmId,
          staffId: data.staffId,
          slug,
          customMessage: data.customMessage ?? null,
          allowedAppointmentTypeIds: data.allowedAppointmentTypeIds ?? null,
          holdExpiryHours: data.holdExpiryHours ?? 72,
          slotIncrementMinutes: data.slotIncrementMinutes ?? 30,
          minNoticeHours: data.minNoticeHours ?? 1,
          bufferBeforeMinutes: data.bufferBeforeMinutes ?? 0,
          bufferAfterMinutes: data.bufferAfterMinutes ?? 0,
          defaultDurationMinutes: data.defaultDurationMinutes ?? 30,
          requireCaptcha: data.requireCaptcha ?? true,
          dailyCap: data.dailyCap ?? null,
          isActive: data.isActive ?? true,
        })
        .returning({ id: staffPublicBookingLinks.id });
      linkId = row!.id;
      await replaceChildren(tx as unknown as Database, linkId, data);
    });
    await emitAudit(deps.db, {
      action: 'CREATE',
      entityType: 'public_booking_link',
      entityId: linkId,
      actorAppUserId: session.appUserId,
      after: { slug, staffId: data.staffId },
    }).catch(() => undefined);
    res.status(201).json({ id: linkId, slug, publicUrl: publicUrl(slug) });
  });

  router.patch(
    '/booking-links/:id',
    requirePermission(deps, 'appointment:write'),
    async (req, res) => {
      const session = req.staffSession!;
      const id = String(req.params['id']);
      if (!deps.db) return void res.status(503).json({ error: 'db_unavailable' });
      const parsed = LinkSchema.partial({ staffId: true }).safeParse(req.body);
      if (!parsed.success)
        return void res
          .status(400)
          .json({ error: 'invalid_payload', issues: parsed.error.flatten() });
      const data = parsed.data;
      const [existing] = await deps.db
        .select({ id: staffPublicBookingLinks.id })
        .from(staffPublicBookingLinks)
        .where(
          and(
            eq(staffPublicBookingLinks.id, id),
            eq(staffPublicBookingLinks.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!existing) return void res.status(404).json({ error: 'not_found' });
      // Optional custom-slug change (exclude this page from the clash check).
      let slug: string | undefined;
      if (data.slug) {
        const s = await uniqueSlug(deps.db, data.slug, id);
        if (!s) return void res.status(409).json({ error: 'slug_unavailable' });
        slug = s;
      }
      await deps.db.transaction(async (tx) => {
        await tx
          .update(staffPublicBookingLinks)
          .set({
            ...(slug ? { slug } : {}),
            ...(data.customMessage !== undefined ? { customMessage: data.customMessage } : {}),
            ...(data.allowedAppointmentTypeIds !== undefined
              ? { allowedAppointmentTypeIds: data.allowedAppointmentTypeIds }
              : {}),
            ...(data.holdExpiryHours !== undefined
              ? { holdExpiryHours: data.holdExpiryHours }
              : {}),
            ...(data.slotIncrementMinutes !== undefined
              ? { slotIncrementMinutes: data.slotIncrementMinutes }
              : {}),
            ...(data.minNoticeHours !== undefined ? { minNoticeHours: data.minNoticeHours } : {}),
            ...(data.bufferBeforeMinutes !== undefined
              ? { bufferBeforeMinutes: data.bufferBeforeMinutes }
              : {}),
            ...(data.bufferAfterMinutes !== undefined
              ? { bufferAfterMinutes: data.bufferAfterMinutes }
              : {}),
            ...(data.defaultDurationMinutes !== undefined
              ? { defaultDurationMinutes: data.defaultDurationMinutes }
              : {}),
            ...(data.requireCaptcha !== undefined ? { requireCaptcha: data.requireCaptcha } : {}),
            ...(data.dailyCap !== undefined ? { dailyCap: data.dailyCap } : {}),
            ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
          })
          .where(eq(staffPublicBookingLinks.id, id));
        await replaceChildren(tx as unknown as Database, id, data);
      });
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'public_booking_link',
        entityId: id,
        actorAppUserId: session.appUserId,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  router.delete(
    '/booking-links/:id',
    requirePermission(deps, 'appointment:write'),
    async (req, res) => {
      const session = req.staffSession!;
      const id = String(req.params['id']);
      if (!deps.db) return void res.status(503).json({ error: 'db_unavailable' });
      const result = await deps.db
        .delete(staffPublicBookingLinks)
        .where(
          and(
            eq(staffPublicBookingLinks.id, id),
            eq(staffPublicBookingLinks.firmId, session.firmId),
          ),
        )
        .returning({ id: staffPublicBookingLinks.id });
      if (result.length === 0) return void res.status(404).json({ error: 'not_found' });
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'public_booking_link',
        entityId: id,
        actorAppUserId: session.appUserId,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  // ---- booking-request approval queue -------------------------------

  /** The acting user may decide a request when they are a configured approver
   *  of the page, the page's staff member, or no approvers were configured. */
  async function canDecide(
    db: Database,
    linkId: string | null,
    staffId: string,
    userId: string,
  ): Promise<boolean> {
    if (userId === staffId) return true;
    if (!linkId) return true;
    const approvers = await db
      .select({ appUserId: publicBookingLinkApprovers.appUserId })
      .from(publicBookingLinkApprovers)
      .where(eq(publicBookingLinkApprovers.bookingLinkId, linkId));
    if (approvers.length === 0) return true;
    return approvers.some((a) => a.appUserId === userId);
  }

  router.get('/booking-requests', requirePermission(deps, 'appointment:read'), async (req, res) => {
    const firmId = req.staffSession!.firmId;
    if (!deps.db) return void res.status(503).json({ error: 'db_unavailable' });
    const rows = await deps.db
      .select({
        id: bookingRequests.id,
        bookingLinkId: bookingRequests.bookingLinkId,
        staffId: bookingRequests.staffId,
        staffName: appUsers.fullName,
        startsAt: bookingRequests.startsAt,
        endsAt: bookingRequests.endsAt,
        visitorName: bookingRequests.visitorName,
        visitorEmail: bookingRequests.visitorEmail,
        visitorPhone: bookingRequests.visitorPhone,
        notes: bookingRequests.notes,
        holdExpiresAt: bookingRequests.holdExpiresAt,
        createdAt: bookingRequests.createdAt,
      })
      .from(bookingRequests)
      .innerJoin(appUsers, eq(appUsers.id, bookingRequests.staffId))
      .where(and(eq(bookingRequests.firmId, firmId), eq(bookingRequests.status, 'PENDING')))
      .orderBy(bookingRequests.startsAt);
    res.json({ items: rows });
  });

  router.get(
    '/booking-requests/count',
    requirePermission(deps, 'appointment:read'),
    async (req, res) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) return void res.json({ count: 0 });
      const rows = await deps.db
        .select({ id: bookingRequests.id })
        .from(bookingRequests)
        .where(and(eq(bookingRequests.firmId, firmId), eq(bookingRequests.status, 'PENDING')));
      res.json({ count: rows.length });
    },
  );

  router.post(
    '/booking-requests/:id/approve',
    requirePermission(deps, 'appointment:write'),
    async (req, res) => {
      const session = req.staffSession!;
      const id = String(req.params['id']);
      if (!deps.db) return void res.status(503).json({ error: 'db_unavailable' });
      const db = deps.db;
      const [reqRow] = await db
        .select()
        .from(bookingRequests)
        .where(and(eq(bookingRequests.id, id), eq(bookingRequests.firmId, session.firmId)))
        .limit(1);
      if (!reqRow) return void res.status(404).json({ error: 'not_found' });
      if (reqRow.status !== 'PENDING')
        return void res.status(409).json({ error: 'already_decided' });
      if (!(await canDecide(db, reqRow.bookingLinkId, reqRow.staffId, session.appUserId))) {
        return void res.status(403).json({ error: 'not_an_approver' });
      }

      const typeName = reqRow.appointmentTypeId
        ? (
            await db
              .select({ name: appointmentTypes.name })
              .from(appointmentTypes)
              .where(eq(appointmentTypes.id, reqRow.appointmentTypeId))
              .limit(1)
          )[0]?.name
        : null;
      const title = typeName ?? 'Appointment';
      const cancelToken = crypto.randomUUID();
      const rescheduleToken = crypto.randomUUID();

      let appointmentId = '';
      try {
        await db.transaction(async (tx) => {
          const { sql } = await import('drizzle-orm');
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${reqRow.staffId}::text, 0))`,
          );
          if (await findBookingConflict(tx, [reqRow.staffId], reqRow.startsAt, reqRow.endsAt)) {
            throw new Error('slot_taken');
          }
          const [appt] = await tx
            .insert(appointments)
            .values({
              firmId: session.firmId,
              appointmentTypeId: reqRow.appointmentTypeId ?? null,
              title,
              startsAt: reqRow.startsAt,
              endsAt: reqRow.endsAt,
              durationMinutes: reqRow.durationMinutes,
              location: (reqRow.location as 'VIDEO' | 'PHONE' | 'IN_PERSON' | null) ?? 'VIDEO',
              locationDetail: reqRow.locationDetail,
              locationOptionId: reqRow.locationOptionId,
              leadAppUserId: reqRow.staffId,
              status: 'SCHEDULED',
              cancelToken,
              rescheduleToken,
              tokenExpiresAt: new Date(reqRow.endsAt.getTime() + TOKEN_TTL_MS),
              createdById: session.appUserId,
            })
            .returning({ id: appointments.id });
          appointmentId = appt!.id;
          await tx.insert(appointmentStaff).values({ appointmentId, staffId: reqRow.staffId });
          await tx
            .update(bookingRequests)
            .set({
              status: 'APPROVED',
              decidedByAppUserId: session.appUserId,
              decidedAt: now(),
              createdAppointmentId: appointmentId,
              updatedAt: now(),
            })
            .where(eq(bookingRequests.id, id));
        });
      } catch (err) {
        if (err instanceof Error && err.message === 'slot_taken') {
          return void res.status(409).json({ error: 'slot_taken' });
        }
        logger.error({ err }, 'booking approve failed');
        return void res.status(500).json({ error: 'approve_failed' });
      }

      // Calendar write (best-effort) + visitor confirmation.
      if (deps.queue) {
        await deps.queue
          .providerWrite({ appointmentId, staffId: reqRow.staffId })
          .catch((err: unknown) => logger.warn({ err }, 'enqueue providerWrite failed'));
      }
      void sendApprovedConfirmation(deps, db, {
        firmId: session.firmId,
        visitorName: reqRow.visitorName,
        visitorEmail: reqRow.visitorEmail,
        staffId: reqRow.staffId,
        startsAt: reqRow.startsAt,
        durationMinutes: reqRow.durationMinutes,
        title,
        cancelToken,
        rescheduleToken,
      }).catch((err) => logger.warn({ err }, 'booking approve confirmation failed'));

      await emitAudit(db, {
        action: 'UPDATE',
        entityType: 'booking_request',
        entityId: id,
        actorAppUserId: session.appUserId,
        after: { status: 'APPROVED', appointmentId },
      }).catch(() => undefined);
      res.json({ ok: true, appointmentId });
    },
  );

  router.post(
    '/booking-requests/:id/decline',
    requirePermission(deps, 'appointment:write'),
    async (req, res) => {
      const session = req.staffSession!;
      const id = String(req.params['id']);
      if (!deps.db) return void res.status(503).json({ error: 'db_unavailable' });
      const db = deps.db;
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null;
      const [reqRow] = await db
        .select()
        .from(bookingRequests)
        .where(and(eq(bookingRequests.id, id), eq(bookingRequests.firmId, session.firmId)))
        .limit(1);
      if (!reqRow) return void res.status(404).json({ error: 'not_found' });
      if (reqRow.status !== 'PENDING')
        return void res.status(409).json({ error: 'already_decided' });
      if (!(await canDecide(db, reqRow.bookingLinkId, reqRow.staffId, session.appUserId))) {
        return void res.status(403).json({ error: 'not_an_approver' });
      }
      await db
        .update(bookingRequests)
        .set({
          status: 'DECLINED',
          decidedByAppUserId: session.appUserId,
          decidedAt: now(),
          declineReason: reason,
          updatedAt: now(),
        })
        .where(eq(bookingRequests.id, id));

      // Notify the visitor (best-effort).
      if (deps.sendEmail) {
        const firm = await firmScope(db, session.firmId);
        const fmt = fmtWhen(reqRow.startsAt);
        const { subject, body } = await renderTemplate({
          db,
          firmId: session.firmId,
          kind: 'booking_request_declined',
          channel: 'EMAIL',
          fallback: {
            subject: 'Update on your booking request',
            body: `Hi ${reqRow.visitorName},\n\nWe weren't able to confirm your requested time of ${fmt.date} at ${fmt.time}. Please feel free to request another time.`,
          },
          context: {
            client: { name: reqRow.visitorName },
            firm,
            appointment: { date: fmt.date, time: fmt.time },
          },
        });
        await deps
          .sendEmail({
            to: reqRow.visitorEmail,
            subject: subject ?? 'Update on your booking request',
            body,
          })
          .catch(() => undefined);
      }
      await emitAudit(db, {
        action: 'UPDATE',
        entityType: 'booking_request',
        entityId: id,
        actorAppUserId: session.appUserId,
        after: { status: 'DECLINED' },
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  return router;
}

function fmtWhen(at: Date): { date: string; time: string } {
  return {
    date: new Intl.DateTimeFormat('en-US', { dateStyle: 'full' }).format(at),
    time: new Intl.DateTimeFormat('en-US', { timeStyle: 'short' }).format(at),
  };
}

async function sendApprovedConfirmation(
  deps: BookingAdminRoutesDeps,
  db: Database,
  a: {
    firmId: string;
    visitorName: string;
    visitorEmail: string;
    staffId: string;
    startsAt: Date;
    durationMinutes: number;
    title: string;
    cancelToken: string;
    rescheduleToken: string;
  },
): Promise<void> {
  if (!deps.sendEmail) return;
  const [staff] = await db
    .select({ name: appUsers.fullName })
    .from(appUsers)
    .where(eq(appUsers.id, a.staffId))
    .limit(1);
  const firm = await firmScope(db, a.firmId);
  const fmt = fmtWhen(a.startsAt);
  const base = deps.staffBaseUrl ?? '';
  const { subject, body } = await renderTemplate({
    db,
    firmId: a.firmId,
    kind: 'appointment_confirmation',
    channel: 'EMAIL',
    fallback: {
      subject: `Confirmed: ${a.title} on ${fmt.date}`,
      body: `Hi ${a.visitorName},\n\nYour appointment is confirmed:\n\n${a.title}\n${fmt.date} at ${fmt.time}\nWith: ${staff?.name ?? ''}`,
    },
    context: {
      client: { name: a.visitorName },
      firm,
      staff: { names: staff?.name ?? '' },
      appointment: {
        subject: a.title,
        date: fmt.date,
        time: fmt.time,
        duration: String(a.durationMinutes),
        cancel_url: `${base}/api/public/appointments/${a.cancelToken}/cancel`,
        reschedule_request_url: `${base}/api/public/appointments/${a.rescheduleToken}/request`,
      },
    },
  });
  await deps
    .sendEmail({ to: a.visitorEmail, subject: subject ?? `Confirmed: ${a.title}`, body })
    .catch(() => undefined);
}
