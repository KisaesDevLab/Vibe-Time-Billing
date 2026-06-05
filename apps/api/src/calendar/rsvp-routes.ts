// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CAL-6/CAL-8 — public one-click RSVP (no login). The reminder email embeds
// a signed token URL; this router renders a tiny branded confirm/decline
// page and records the response. Mounted at /api/calendar/rsvp (public).

import express, { type Request, type Response, type Router } from 'express';
import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { calendarEvents, calendarRsvpTokens, clientContacts, persons } from '@vibe/db/schema';

import { logger } from '../logger';
import { CalendarWriteService } from './write-service';

export interface RsvpDeps {
  db: Database | null;
  /** Injectable for tests; defaults to global fetch (calendar write-back). */
  fetchImpl?: typeof fetch;
}

interface Attendee {
  email?: string | null;
  name?: string | null;
  response_status?: string | null;
}

function page(title: string, bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 16px;color:#1a1a1a}.btn{display:inline-block;padding:10px 18px;border-radius:8px;border:none;font-size:15px;cursor:pointer;margin-right:8px}.ok{background:#1f9c4d;color:#fff}.no{background:#cc2d2d;color:#fff}.muted{color:#888;font-size:13px}.card{border:1px solid #e0e0e0;border-radius:10px;padding:16px;margin:16px 0}</style></head><body>${bodyHtml}</body></html>`;
}

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

export function createRsvpRouter(deps: RsvpDeps): Router {
  const router = express.Router();
  const writeService = new CalendarWriteService();
  const doFetch = deps.fetchImpl ?? fetch;

  async function resolve(token: string) {
    if (!deps.db) return null;
    const [row] = await deps.db
      .select({
        tokenId: calendarRsvpTokens.id,
        response: calendarRsvpTokens.response,
        expiresAt: calendarRsvpTokens.expiresAt,
        contactId: calendarRsvpTokens.clientContactId,
        eventId: calendarEvents.id,
        firmId: calendarEvents.firmId,
        subject: calendarEvents.subject,
        startAt: calendarEvents.startAt,
        location: calendarEvents.location,
        attendees: calendarEvents.attendees,
      })
      .from(calendarRsvpTokens)
      .innerJoin(calendarEvents, eq(calendarEvents.id, calendarRsvpTokens.eventId))
      .where(eq(calendarRsvpTokens.token, token))
      .limit(1);
    return row ?? null;
  }

  // GET /:token — render the confirm/decline page.
  router.get('/:token', async (req: Request, res: Response) => {
    const row = await resolve(req.params['token']!);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (!row) {
      res.status(404).send(page('Not found', '<h2>Link not found</h2>'));
      return;
    }
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
      res
        .status(410)
        .send(
          page(
            'Expired',
            '<h2>This link has expired</h2><p class="muted">Please contact the firm if you still need to respond.</p>',
          ),
        );
      return;
    }
    const when = row.startAt ? new Date(row.startAt).toLocaleString() : '';
    const status = row.response
      ? `<p>Your current response: <strong>${esc(row.response)}</strong>. You can change it below.</p>`
      : '';
    res.send(
      page(
        'Confirm your appointment',
        `<h2>${esc(row.subject ?? 'Appointment')}</h2>
         <div class="card"><div>${esc(when)}</div>${row.location ? `<div class="muted">${esc(row.location)}</div>` : ''}</div>
         ${status}
         <form method="post" action="/api/calendar/rsvp/${esc(req.params['token']!)}" style="margin-top:12px">
           <button class="btn ok" name="response" value="confirmed" type="submit">✓ Confirm</button>
           <button class="btn no" name="response" value="declined" type="submit">✗ Decline</button>
         </form>`,
      ),
    );
  });

  // POST /:token — record the response (form-encoded or JSON).
  router.post(
    '/:token',
    express.urlencoded({ extended: false }),
    express.json(),
    async (req: Request, res: Response) => {
      const response = String((req.body?.response ?? '') as string);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (response !== 'confirmed' && response !== 'declined') {
        res.status(400).send(page('Error', '<h2>Invalid response</h2>'));
        return;
      }
      const row = await resolve(req.params['token']!);
      if (!row || !deps.db) {
        res.status(404).send(page('Not found', '<h2>Link not found</h2>'));
        return;
      }
      if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
        res.status(410).send(page('Expired', '<h2>This link has expired</h2>'));
        return;
      }

      const now = new Date();
      await deps.db
        .update(calendarRsvpTokens)
        .set({ response, respondedAt: now })
        .where(eq(calendarRsvpTokens.id, row.tokenId));

      // Reflect the response into the event's attendee list (by contact email).
      if (row.contactId) {
        const [contact] = await deps.db
          .select({ email: persons.email })
          .from(clientContacts)
          .innerJoin(persons, eq(persons.id, clientContacts.personId))
          .where(eq(clientContacts.id, row.contactId))
          .limit(1);
        const email = contact?.email?.toLowerCase();
        if (email) {
          const attendees = (row.attendees as Attendee[] | null) ?? [];
          const next = attendees.map((a) =>
            a.email?.toLowerCase() === email
              ? { ...a, response_status: response === 'confirmed' ? 'accepted' : 'declined' }
              : a,
          );
          await deps.db
            .update(calendarEvents)
            .set({ attendees: next, updatedAt: now })
            .where(eq(calendarEvents.id, row.eventId));

          // CAL-9 — push the updated response to the provider event when
          // write-back is enabled (best-effort; never blocks the RSVP).
          try {
            await writeService.writeBackAttendees(
              { db: deps.db, fetchImpl: doFetch },
              { firmId: row.firmId, eventId: row.eventId },
            );
          } catch (err) {
            logger.warn({ err, eventId: row.eventId }, 'rsvp attendee write-back failed');
          }
        }
      }

      res.send(
        page(
          'Thank you',
          `<h2>Thanks — we've noted your response</h2><p>You ${response === 'confirmed' ? 'confirmed' : 'declined'} this appointment.</p><p class="muted">You can revisit this link to change your response.</p>`,
        ),
      );
    },
  );

  return router;
}
