// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0168 — expire stale public booking-request holds. A PENDING booking_request
// reserves its slot until hold_expires_at; once that passes without a staff
// decision, this sweep flips it to EXPIRED (freeing the slot) and lets the
// visitor know their requested time is no longer held. Runs every 15 min.

import { and, eq, lt } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import { bookingRequests } from '@vibe/db/schema';

import type { MailDispatch } from '../dispatchers';
import { firmScope, renderTemplate } from '../notifications/templating';

export interface BookingHoldExpiryResult {
  expired: number;
  notified: number;
}

export async function runBookingHoldExpiryTick(
  db: Database,
  log: Logger,
  args: { sendEmail?: MailDispatch | undefined } = {},
): Promise<BookingHoldExpiryResult> {
  const now = new Date();
  const expired = await db
    .update(bookingRequests)
    .set({ status: 'EXPIRED', updatedAt: now })
    .where(and(eq(bookingRequests.status, 'PENDING'), lt(bookingRequests.holdExpiresAt, now)))
    .returning({
      id: bookingRequests.id,
      firmId: bookingRequests.firmId,
      visitorName: bookingRequests.visitorName,
      visitorEmail: bookingRequests.visitorEmail,
      startsAt: bookingRequests.startsAt,
    });

  let notified = 0;
  if (args.sendEmail && expired.length > 0) {
    for (const r of expired) {
      try {
        const firm = await firmScope(db, r.firmId);
        const date = new Intl.DateTimeFormat('en-US', { dateStyle: 'full' }).format(r.startsAt);
        const time = new Intl.DateTimeFormat('en-US', { timeStyle: 'short' }).format(r.startsAt);
        // Reuse the declined template — an expired hold is "we didn't confirm
        // your requested time"; the firm can customize it in admin.
        const { subject, body } = await renderTemplate({
          db,
          firmId: r.firmId,
          kind: 'booking_request_declined',
          channel: 'EMAIL',
          fallback: {
            subject: 'Your booking request has expired',
            body: `Hi ${r.visitorName},\n\nYour requested time of ${date} at ${time} is no longer held. Please feel free to request another time.`,
          },
          context: {
            client: { name: r.visitorName },
            firm,
            appointment: { date, time },
          },
        });
        await args.sendEmail({
          to: r.visitorEmail,
          subject: subject ?? 'Your booking request has expired',
          body,
        });
        notified += 1;
      } catch (err) {
        log.warn({ err, requestId: r.id }, 'booking hold expiry notify failed');
      }
    }
  }

  if (expired.length > 0)
    log.info({ expired: expired.length, notified }, 'booking hold expiry sweep');
  return { expired: expired.length, notified };
}
