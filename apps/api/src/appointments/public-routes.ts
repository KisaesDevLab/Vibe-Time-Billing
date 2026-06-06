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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Browser form submits are urlencoded → render HTML; API calls are JSON. */
function wantsHtml(req: Request): boolean {
  return req.is('application/x-www-form-urlencoded') !== false;
}

export function createAppointmentPublicRouter(deps: AppointmentPublicDeps): Router {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));
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

  // --- server-rendered confirm pages (links from emails) -------------
  function page(title: string, bodyHtml: string): string {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f6f8;color:#1c2127;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}.card{background:#fff;border:1px solid #e3e6ea;border-radius:12px;padding:32px;max-width:420px;width:100%}h1{font-size:20px;margin:0 0 12px}p{color:#5b6470;font-size:14px;line-height:1.5}button,.btn{display:inline-block;margin-top:16px;padding:10px 16px;border-radius:8px;border:none;background:#2563eb;color:#fff;font-size:14px;cursor:pointer;text-decoration:none}textarea{width:100%;box-sizing:border-box;margin-top:12px;padding:8px;border:1px solid #cdd2d8;border-radius:8px;font:inherit}</style></head><body><div class="card">${bodyHtml}</div></body></html>`;
  }

  async function loadByToken(
    field: 'cancel' | 'reschedule',
    token: string,
  ): Promise<typeof appointments.$inferSelect | null> {
    if (!UUID_RE.test(token) || !deps.db) return null;
    const col = field === 'cancel' ? appointments.cancelToken : appointments.rescheduleToken;
    const [appt] = await deps.db.select().from(appointments).where(eq(col, token)).limit(1);
    return appt ?? null;
  }

  router.get('/:cancelToken/cancel', async (req: Request, res: Response) => {
    const appt = await loadByToken('cancel', req.params['cancelToken']!);
    const now = nowFn();
    if (!appt || (appt.tokenExpiresAt && appt.tokenExpiresAt.getTime() < now.getTime())) {
      res
        .status(410)
        .send(
          page(
            'Link expired',
            `<h1>This link has expired</h1><p>Please contact the firm directly to make changes.</p>`,
          ),
        );
      return;
    }
    if (appt.status !== 'SCHEDULED') {
      res.send(
        page(
          'Appointment',
          `<h1>Nothing to cancel</h1><p>This appointment is already ${appt.status.toLowerCase()}.</p>`,
        ),
      );
      return;
    }
    res.send(
      page(
        'Cancel appointment',
        `<h1>Cancel this appointment?</h1><p>${escapeHtml(appt.title)}</p>
         <form method="POST"><button type="submit">Yes, cancel</button></form>`,
      ),
    );
  });

  router.get('/:rescheduleToken/request', async (req: Request, res: Response) => {
    const appt = await loadByToken('reschedule', req.params['rescheduleToken']!);
    const now = nowFn();
    if (!appt || (appt.tokenExpiresAt && appt.tokenExpiresAt.getTime() < now.getTime())) {
      res
        .status(410)
        .send(
          page(
            'Link expired',
            `<h1>This link has expired</h1><p>Please contact the firm directly.</p>`,
          ),
        );
      return;
    }
    res.send(
      page(
        'Request a new time',
        `<h1>Request a different time</h1><p>${escapeHtml(appt.title)}</p>
         <form method="POST"><textarea name="message" rows="3" placeholder="Optional: when works better?"></textarea>
         <button type="submit">Send request</button></form>`,
      ),
    );
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
    if (wantsHtml(req)) {
      res.send(
        page('Cancelled', `<h1>Appointment cancelled</h1><p>Thanks — we've let the team know.</p>`),
      );
      return;
    }
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
      await queue
        .rescheduleRequestedStaffSend({ appointmentId: appt.id, message })
        .catch((err: unknown) => logger.warn({ err }, 'enqueue reschedule-requested staff failed'));
    }
    if (wantsHtml(req)) {
      res.send(
        page(
          'Request sent',
          `<h1>Request sent</h1><p>The team will reach out to confirm a new time.</p>`,
        ),
      );
      return;
    }
    res.json({ status: 'requested' });
  });

  return router;
}
