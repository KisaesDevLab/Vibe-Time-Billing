// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// BK-4/BK-6 — public appointment actions via signed token (no login).
// Mounted at /api/public/appointments (outside the staff/portal auth
// chains). Per-IP rate limited. Clients cancel or request a reschedule;
// staff are notified in-app + by email.
//
//   POST /:cancelToken/cancel        — client cancels
//   POST /:rescheduleToken/request   — client requests a new time
//
// (GET summary/confirmation pages are server-rendered in BK-6.)

import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { and, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import { checkAndIncrement } from '@vibe/core/auth';
import type { Database } from '@vibe/db';
import {
  appointmentRescheduleRequests,
  appointmentStaff,
  appointments,
  staffNotifications,
} from '@vibe/db/schema';

import { logger } from '../logger';
import { bullBookingQueue, type BookingQueue } from './queue';

export interface AppointmentPublicDeps {
  db: Database | null;
  redis: Redis;
  queue?: BookingQueue;
  now?: () => Date;
}

const IP_WINDOW_SECONDS = 60;
const IP_MAX_PER_WINDOW = 20;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0];
  return (first ?? req.ip ?? '0.0.0.0').trim();
}

export function createAppointmentPublicRouter(deps: AppointmentPublicDeps): Router {
  const router = express.Router();
  const queue = deps.queue ?? bullBookingQueue;
  const nowFn = deps.now ?? ((): Date => new Date());

  // Per-IP rate limit (20/min) — booking links are low-frequency.
  router.use((req: Request, res: Response, next: NextFunction) => {
    void checkAndIncrement(deps.redis, {
      key: `rl:appt:ip:${clientIp(req)}`,
      windowSeconds: IP_WINDOW_SECONDS,
      max: IP_MAX_PER_WINDOW,
    })
      .then((limit) => {
        if (!limit.allowed) {
          res.setHeader('Retry-After', String(limit.retryAfterSeconds));
          res.status(429).json({ error: 'rate_limited' });
          return;
        }
        next();
      })
      .catch((err: unknown) => {
        logger.warn({ err }, 'appointment public rate limiter error; allowing');
        next();
      });
  });

  router.post('/:cancelToken/cancel', async (req: Request, res: Response) => {
    const token = req.params['cancelToken']!;
    if (!UUID_RE.test(token) || !deps.db) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const db = deps.db;
    const now = nowFn();
    const [appt] = await db
      .select()
      .from(appointments)
      .where(eq(appointments.cancelToken, token))
      .limit(1);
    if (!appt || (appt.tokenExpiresAt && appt.tokenExpiresAt.getTime() < now.getTime())) {
      res.status(410).json({ error: 'expired_or_invalid' });
      return;
    }
    if (appt.status !== 'SCHEDULED') {
      res.json({ status: appt.status.toLowerCase() });
      return;
    }
    const staffRows = await db
      .select({ staffId: appointmentStaff.staffId })
      .from(appointmentStaff)
      .where(eq(appointmentStaff.appointmentId, appt.id));
    await db
      .update(appointments)
      .set({
        status: 'CANCELLED',
        cancelledAt: now,
        cancelledByActor: 'client',
        updatedAt: now,
      })
      .where(eq(appointments.id, appt.id));
    for (const r of staffRows) {
      await queue
        .providerDelete({ appointmentId: appt.id, staffId: r.staffId })
        .catch((err: unknown) => logger.warn({ err }, 'enqueue providerDelete failed'));
      await db
        .insert(staffNotifications)
        .values({
          firmId: appt.firmId,
          recipientAppUserId: r.staffId,
          type: 'appointment_cancelled_by_client',
          entityType: 'appointment',
          entityId: appt.id,
          title: 'Appointment cancelled by client',
          body: appt.title,
          actionUrl: `/appointments#list`,
        })
        .catch((err: unknown) => logger.warn({ err }, 'staff_notification insert failed'));
    }
    await queue
      .cancellationSend({ appointmentId: appt.id, cancelledBy: 'client' })
      .catch((err: unknown) => logger.warn({ err }, 'enqueue cancellation failed'));
    res.json({ status: 'cancelled' });
  });

  router.post('/:rescheduleToken/request', async (req: Request, res: Response) => {
    const token = req.params['rescheduleToken']!;
    if (!UUID_RE.test(token) || !deps.db) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const db = deps.db;
    const now = nowFn();
    const message = typeof req.body?.message === 'string' ? req.body.message.slice(0, 2000) : null;
    const [appt] = await db
      .select()
      .from(appointments)
      .where(eq(appointments.rescheduleToken, token))
      .limit(1);
    if (!appt || (appt.tokenExpiresAt && appt.tokenExpiresAt.getTime() < now.getTime())) {
      res.status(410).json({ error: 'expired_or_invalid' });
      return;
    }
    if (appt.status !== 'SCHEDULED') {
      res.json({ status: 'unavailable' });
      return;
    }
    // Idempotent: don't stack duplicate pending requests.
    const [existing] = await db
      .select({ id: appointmentRescheduleRequests.id })
      .from(appointmentRescheduleRequests)
      .where(
        and(
          eq(appointmentRescheduleRequests.appointmentId, appt.id),
          eq(appointmentRescheduleRequests.status, 'pending'),
        ),
      )
      .limit(1);
    if (!existing) {
      await db.insert(appointmentRescheduleRequests).values({
        appointmentId: appt.id,
        message,
        status: 'pending',
      });
      if (appt.createdById) {
        await db
          .insert(staffNotifications)
          .values({
            firmId: appt.firmId,
            recipientAppUserId: appt.createdById,
            type: 'reschedule_requested',
            entityType: 'appointment',
            entityId: appt.id,
            title: 'Client requested a reschedule',
            body: appt.title,
            actionUrl: `/appointments#inbox`,
          })
          .catch((err: unknown) => logger.warn({ err }, 'staff_notification insert failed'));
      }
    }
    res.json({ status: 'requested' });
  });

  return router;
}
