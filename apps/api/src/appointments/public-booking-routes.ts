// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Public self-booking (0168). Unauthenticated surface mounted at
// /api/public/book, served from the intake subdomain. A visitor resolves a
// short-slug link, views slots from the PAGE's own availability, and submits
// a booking REQUEST — which creates a PENDING booking_request (the slot hold)
// and notifies the page's approvers + notify list. No appointment is created
// until a staff approver confirms (see booking-routes.ts).

import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { and, eq, gt, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import { checkAndIncrement } from '@vibe/core/auth';
import { renderNotification } from '@vibe/core/notifications';
import type { Database } from '@vibe/db';
import {
  appUsers,
  appointmentLocationOptions,
  appointmentTypes,
  bookingRequests,
  firmSettings,
  offices,
  publicBookingAvailability,
  publicBookingLinkApprovers,
  publicBookingLinkNotify,
  staffNotifications,
  staffPublicBookingLinks,
} from '@vibe/db/schema';

import { findOrCreatePerson } from '../clients/person-helpers';
import { createFreeBusyProvider } from '../calendar/freebusy';
import { logger } from '../logger';
import { decryptTurnstileSecret } from '../intake/turnstile-config';
import { firmScope, loadNotificationTemplate } from '../notifications/templating';
import {
  findBookingConflict,
  getAvailableSlots,
  type AvailabilityWindowRow,
  type StaffBusyProvider,
} from './availability';
import { pokeStaffEvents } from '../notifications/staff-events-bus';

export interface PublicBookingRoutesDeps {
  db: Database | null;
  redis?: Redis | null;
  busyProvider?: StaffBusyProvider;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sendEmail?: (args: { to: string; subject: string; body: string }) => Promise<void>;
  sendSms?: (args: { to: string; body: string }) => Promise<void>;
  /** Public base for the booking link itself (intake subdomain). */
  intakeBaseUrl?: string;
  /** Staff app base for the approval action link in staff notifications. */
  staffBaseUrl?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[A-Za-z0-9-]{2,50}$/;

function dow(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

async function firmTimezone(db: Database, firmId: string): Promise<string> {
  const [row] = await db
    .select({ tz: offices.timezone })
    .from(offices)
    .where(and(eq(offices.firmId, firmId), eq(offices.isDefault, true)))
    .limit(1);
  return row?.tz ?? 'America/Chicago';
}

function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0]!.trim();
  return req.ip ?? 'unknown';
}

interface ResolvedLink {
  id: string;
  firmId: string;
  staffId: string;
  staffName: string;
  customMessage: string | null;
  slotIncrementMinutes: number;
  minNoticeHours: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  defaultDurationMinutes: number;
  holdExpiryHours: number;
  requireCaptcha: boolean;
  dailyCap: number | null;
  allowedTypeIds: string[] | null;
}

async function resolveLink(db: Database, slug: string): Promise<ResolvedLink | null> {
  const [link] = await db
    .select({
      id: staffPublicBookingLinks.id,
      firmId: staffPublicBookingLinks.firmId,
      staffId: staffPublicBookingLinks.staffId,
      staffName: appUsers.fullName,
      customMessage: staffPublicBookingLinks.customMessage,
      slotIncrementMinutes: staffPublicBookingLinks.slotIncrementMinutes,
      minNoticeHours: staffPublicBookingLinks.minNoticeHours,
      bufferBeforeMinutes: staffPublicBookingLinks.bufferBeforeMinutes,
      bufferAfterMinutes: staffPublicBookingLinks.bufferAfterMinutes,
      defaultDurationMinutes: staffPublicBookingLinks.defaultDurationMinutes,
      holdExpiryHours: staffPublicBookingLinks.holdExpiryHours,
      requireCaptcha: staffPublicBookingLinks.requireCaptcha,
      dailyCap: staffPublicBookingLinks.dailyCap,
      allowedTypeIds: staffPublicBookingLinks.allowedAppointmentTypeIds,
      isActive: staffPublicBookingLinks.isActive,
    })
    .from(staffPublicBookingLinks)
    .innerJoin(appUsers, eq(appUsers.id, staffPublicBookingLinks.staffId))
    .where(eq(staffPublicBookingLinks.slug, slug))
    .limit(1);
  if (!link || !link.isActive) return null;
  const allowed = Array.isArray(link.allowedTypeIds) ? (link.allowedTypeIds as string[]) : null;
  return { ...link, allowedTypeIds: allowed };
}

/** The page's bookable appointment types (firm types, intersected with the
 *  link's allow-list when set). */
async function loadTypes(
  db: Database,
  link: ResolvedLink,
): Promise<{ id: string; name: string; durationMinutes: number }[]> {
  const rows = await db
    .select({
      id: appointmentTypes.id,
      name: appointmentTypes.name,
      durationMinutes: appointmentTypes.defaultDurationMinutes,
      isActive: appointmentTypes.isActive,
    })
    .from(appointmentTypes)
    .where(eq(appointmentTypes.firmId, link.firmId));
  return rows
    .filter((t) => t.isActive)
    .filter((t) => !link.allowedTypeIds || link.allowedTypeIds.includes(t.id))
    .map((t) => ({ id: t.id, name: t.name, durationMinutes: t.durationMinutes }));
}

function settingsOverrideFor(link: ResolvedLink): {
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minNoticeHours: number;
  slotIncrementMinutes: number;
  bookingEnabled: boolean;
} {
  return {
    bufferBeforeMinutes: link.bufferBeforeMinutes,
    bufferAfterMinutes: link.bufferAfterMinutes,
    minNoticeHours: link.minNoticeHours,
    slotIncrementMinutes: link.slotIncrementMinutes,
    bookingEnabled: true,
  };
}

/** All of a page's active windows, grouped by weekday (0-6) and shaped for
 *  the slot engine — loaded once so the month view doesn't re-query per day. */
async function windowsByDow(
  db: Database,
  link: ResolvedLink,
): Promise<Map<number, AvailabilityWindowRow[]>> {
  const rows = await db
    .select()
    .from(publicBookingAvailability)
    .where(eq(publicBookingAvailability.bookingLinkId, link.id));
  const out = new Map<number, AvailabilityWindowRow[]>();
  for (const r of rows) {
    if (!r.isActive) continue;
    const list = out.get(r.dayOfWeek) ?? [];
    list.push({
      staffId: link.staffId,
      startTime: r.startTime,
      endTime: r.endTime,
      isActive: true,
      locationTypes: r.locationTypes,
      locationOptionId: r.locationOptionId,
      appointmentTypeIds: r.appointmentTypeIds,
    });
    out.set(r.dayOfWeek, list);
  }
  return out;
}

/** Page windows for a given weekday, shaped for the slot engine. */
async function windowsForDay(
  db: Database,
  link: ResolvedLink,
  date: string,
): Promise<AvailabilityWindowRow[]> {
  return (await windowsByDow(db, link)).get(dow(date)) ?? [];
}

const LOCATION_TYPES = ['IN_PERSON', 'PHONE', 'VIDEO'] as const;
const LOC_LABEL: Record<string, string> = {
  IN_PERSON: 'In person',
  PHONE: 'Phone',
  VIDEO: 'Video',
};

export interface MeetingOption {
  key: string; // 'opt:<id>' or 'type:<TYPE>'
  label: string;
  locationType: string; // VIDEO | PHONE | IN_PERSON
  locationOptionId: string | null;
  detail: string | null;
}

/** The "how would you like to meet?" options a page offers, derived from its
 *  windows: each referenced location preset, plus the bare contact types of
 *  windows that have no preset (an unrestricted window offers all three). */
async function loadLocations(db: Database, link: ResolvedLink): Promise<MeetingOption[]> {
  const wins = await db
    .select({
      locationTypes: publicBookingAvailability.locationTypes,
      locationOptionId: publicBookingAvailability.locationOptionId,
      isActive: publicBookingAvailability.isActive,
    })
    .from(publicBookingAvailability)
    .where(eq(publicBookingAvailability.bookingLinkId, link.id));
  const active = wins.filter((w) => w.isActive);
  const optIds = [
    ...new Set(active.map((w) => w.locationOptionId).filter((x): x is string => !!x)),
  ];
  const opts = optIds.length
    ? await db
        .select({
          id: appointmentLocationOptions.id,
          name: appointmentLocationOptions.name,
          locationType: appointmentLocationOptions.locationType,
          detail: appointmentLocationOptions.detail,
        })
        .from(appointmentLocationOptions)
        .where(inArray(appointmentLocationOptions.id, optIds))
    : [];
  const out = new Map<string, MeetingOption>();
  for (const o of opts) {
    out.set(`opt:${o.id}`, {
      key: `opt:${o.id}`,
      label: `${o.name} (${LOC_LABEL[o.locationType] ?? o.locationType})`,
      locationType: o.locationType,
      locationOptionId: o.id,
      detail: o.detail,
    });
  }
  for (const w of active) {
    if (w.locationOptionId) continue;
    // Only windows that EXPLICITLY restrict contact types surface a choice.
    // A fully-unrestricted window (null/empty location_types, no preset) keeps
    // the page location-agnostic, so the visitor isn't forced to pick one.
    if (!w.locationTypes || w.locationTypes.length === 0) continue;
    for (const t of w.locationTypes) {
      if (!(LOCATION_TYPES as readonly string[]).includes(t)) continue;
      out.set(`type:${t}`, {
        key: `type:${t}`,
        label: LOC_LABEL[t] ?? t,
        locationType: t,
        locationOptionId: null,
        detail: null,
      });
    }
  }
  return [...out.values()];
}

function parseLocationParams(
  loc: unknown,
  locId: unknown,
): { location: string | undefined; locationOptionId: string | undefined } {
  const location =
    typeof loc === 'string' && (LOCATION_TYPES as readonly string[]).includes(loc)
      ? loc
      : undefined;
  const locationOptionId = typeof locId === 'string' && UUID_RE.test(locId) ? locId : undefined;
  return { location, locationOptionId };
}

function durationFor(
  link: ResolvedLink,
  types: { id: string; durationMinutes: number }[],
  typeId: string | undefined,
): number {
  if (typeId) {
    const t = types.find((x) => x.id === typeId);
    if (t) return t.durationMinutes;
  }
  return link.defaultDurationMinutes;
}

async function loadTurnstile(
  db: Database,
  firmId: string,
): Promise<{ siteKey: string; secret: string } | null> {
  const [s] = await db
    .select({ siteKey: firmSettings.turnstileSiteKey, secretEnc: firmSettings.turnstileSecretEnc })
    .from(firmSettings)
    .where(eq(firmSettings.firmId, firmId))
    .limit(1);
  if (!s?.siteKey || !s.secretEnc) return null;
  try {
    return { siteKey: s.siteKey, secret: decryptTurnstileSecret(s.secretEnc) };
  } catch {
    return null;
  }
}

async function verifyTurnstile(
  secret: string,
  token: string,
  ip: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip && ip !== 'unknown') body.set('remoteip', ip);
    const r = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = (await r.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

export function createPublicBookingRouter(deps: PublicBookingRoutesDeps): Router {
  const router = express.Router();
  const now = (): Date => (deps.now ? deps.now() : new Date());
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as typeof fetch);

  function providerFor(firmId: string): StaffBusyProvider {
    return (
      deps.busyProvider ??
      createFreeBusyProvider({ db: deps.db!, firmId, fetchImpl: deps.fetchImpl })
    );
  }

  // CORS + per-IP rate limit (fails open on Redis error).
  router.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Credentials', 'false');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    if (!deps.redis) {
      next();
      return;
    }
    void checkAndIncrement(deps.redis, {
      key: `rl:book:ip:${clientIp(req)}`,
      windowSeconds: 60,
      max: 60,
    })
      .then((limit) => {
        if (!limit.allowed) {
          res.setHeader('Retry-After', String(limit.retryAfterSeconds ?? 60));
          res.status(429).json({ error: 'rate_limited' });
          return;
        }
        next();
      })
      .catch((err: unknown) => {
        logger.warn({ err }, 'public booking rate limiter error; allowing request');
        next();
      });
  });

  function db(res: Response): Database | null {
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return null;
    }
    return deps.db;
  }

  // GET /:slug — resolve the page (404 if missing/inactive).
  router.get('/:slug', async (req: Request, res: Response) => {
    const d = db(res);
    if (!d) return;
    const slug = String(req.params['slug'] ?? '');
    if (!SLUG_RE.test(slug)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const link = await resolveLink(d, slug);
    if (!link) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const types = await loadTypes(d, link);
    const locations = await loadLocations(d, link);
    const turnstile = link.requireCaptcha ? await loadTurnstile(d, link.firmId) : null;
    res.json({
      staffName: link.staffName,
      customMessage: link.customMessage,
      types,
      locations,
      captchaSiteKey: turnstile?.siteKey ?? null,
    });
  });

  // GET /:slug/slots?date=YYYY-MM-DD&typeId= — page-availability slots.
  router.get('/:slug/slots', async (req: Request, res: Response) => {
    const d = db(res);
    if (!d) return;
    const link = await resolveLink(d, String(req.params['slug'] ?? ''));
    if (!link) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const date = String(req.query['date'] ?? '');
    if (!DATE_RE.test(date)) {
      res.status(400).json({ error: 'invalid_date' });
      return;
    }
    const typeId =
      typeof req.query['typeId'] === 'string' && UUID_RE.test(req.query['typeId'])
        ? req.query['typeId']
        : undefined;
    const loc = parseLocationParams(req.query['location'], req.query['locationId']);
    const types = await loadTypes(d, link);
    if (typeId && !types.some((t) => t.id === typeId)) {
      res.status(400).json({ error: 'unknown_type' });
      return;
    }
    const tz = await firmTimezone(d, link.firmId);
    const result = await getAvailableSlots({
      db: d,
      staffIds: [link.staffId],
      date,
      durationMinutes: durationFor(link, types, typeId),
      timezone: tz,
      now: now(),
      busyProvider: providerFor(link.firmId),
      appointmentTypeId: typeId,
      location: loc.location,
      locationOptionId: loc.locationOptionId,
      settingsOverride: settingsOverrideFor(link),
      availabilityRowsOverride: await windowsForDay(d, link, date),
    });
    // Public surface: only expose the bookable start times, not staff pips.
    res.json({
      date,
      timezone: tz,
      slots: result.slots.filter((s) => s.available).map((s) => ({ start: s.start, end: s.end })),
    });
  });

  // GET /:slug/month?year=&month=&typeId= — which days have any open slot
  // (drives the calendar's bookable-day highlighting, like the staff wizard).
  router.get('/:slug/month', async (req: Request, res: Response) => {
    const d = db(res);
    if (!d) return;
    const link = await resolveLink(d, String(req.params['slug'] ?? ''));
    if (!link) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const year = Number(req.query['year']);
    const month = Number(req.query['month']); // 1-12
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      res.status(400).json({ error: 'invalid_month' });
      return;
    }
    const typeId =
      typeof req.query['typeId'] === 'string' && UUID_RE.test(req.query['typeId'])
        ? req.query['typeId']
        : undefined;
    const types = await loadTypes(d, link);
    if (typeId && !types.some((t) => t.id === typeId)) {
      res.status(400).json({ error: 'unknown_type' });
      return;
    }
    const loc = parseLocationParams(req.query['location'], req.query['locationId']);
    const tz = await firmTimezone(d, link.firmId);
    const durationMinutes = durationFor(link, types, typeId);
    const settings = settingsOverrideFor(link);
    const byDow = await windowsByDow(d, link);
    const provider = providerFor(link.firmId);
    const at = now();
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const days: Record<string, boolean> = {};
    for (let dd = 1; dd <= daysInMonth; dd++) {
      const date = `${year}-${String(month).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
      const wins = byDow.get(dow(date)) ?? [];
      if (wins.length === 0) {
        days[date] = false;
        continue;
      }
      const result = await getAvailableSlots({
        db: d,
        staffIds: [link.staffId],
        date,
        durationMinutes,
        timezone: tz,
        now: at,
        busyProvider: provider,
        appointmentTypeId: typeId,
        location: loc.location,
        locationOptionId: loc.locationOptionId,
        settingsOverride: settings,
        availabilityRowsOverride: wins,
      });
      days[date] = result.slots.some((s) => s.available);
    }
    res.json({ days, timezone: tz });
  });

  // POST /:slug/request — submit a booking request (creates a PENDING hold).
  router.post('/:slug/request', async (req: Request, res: Response) => {
    const d = db(res);
    if (!d) return;
    const link = await resolveLink(d, String(req.params['slug'] ?? ''));
    if (!link) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body['name'] === 'string' ? body['name'].trim() : '';
    const email = typeof body['email'] === 'string' ? body['email'].trim() : '';
    const phone = typeof body['phone'] === 'string' ? body['phone'].trim() : '';
    const notes = typeof body['notes'] === 'string' ? body['notes'].trim().slice(0, 2000) : '';
    const startsAtRaw = typeof body['startsAt'] === 'string' ? body['startsAt'] : '';
    const typeId =
      typeof body['typeId'] === 'string' && UUID_RE.test(body['typeId'])
        ? body['typeId']
        : undefined;
    const captchaToken = typeof body['captchaToken'] === 'string' ? body['captchaToken'] : '';
    const reqLoc = parseLocationParams(body['location'], body['locationId']);

    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !startsAtRaw) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }

    // Resolve the chosen meeting location against what the page offers, so we
    // store a legit location type + detail on the request.
    const offeredLocations = await loadLocations(d, link);
    let chosenLocation: MeetingOption | null = null;
    if (offeredLocations.length > 0) {
      chosenLocation =
        offeredLocations.find(
          (o) =>
            (reqLoc.locationOptionId
              ? o.locationOptionId === reqLoc.locationOptionId
              : o.locationOptionId === null) && o.locationType === reqLoc.location,
        ) ??
        // Fall back to the sole option when the page offers exactly one.
        (offeredLocations.length === 1 ? offeredLocations[0]! : null);
      if (!chosenLocation) {
        res.status(400).json({ error: 'location_required' });
        return;
      }
    }
    const startsAt = new Date(startsAtRaw);
    if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() <= now().getTime()) {
      res.status(400).json({ error: 'invalid_time' });
      return;
    }

    // CAPTCHA — fails CLOSED when required. If the link demands CAPTCHA but
    // Turnstile isn't configured / can't be decrypted, reject rather than
    // silently letting the unauthenticated request through.
    if (link.requireCaptcha) {
      const turnstile = await loadTurnstile(d, link.firmId);
      if (!turnstile) {
        res.status(503).json({ error: 'captcha_unavailable' });
        return;
      }
      const ok = captchaToken
        ? await verifyTurnstile(turnstile.secret, captchaToken, clientIp(req), fetchImpl)
        : false;
      if (!ok) {
        res.status(400).json({ error: 'captcha_failed' });
        return;
      }
    }

    // Tighter per-slug submit rate limit + per-link daily cap.
    const submitLimit = deps.redis
      ? await checkAndIncrement(deps.redis, {
          key: `rl:book:submit:${link.id}`,
          windowSeconds: 60,
          max: 10,
        }).catch(() => ({ allowed: true }) as { allowed: boolean })
      : { allowed: true };
    if (!submitLimit.allowed) {
      res.status(429).json({ error: 'rate_limited' });
      return;
    }

    const types = await loadTypes(d, link);
    if (typeId && !types.some((t) => t.id === typeId)) {
      res.status(400).json({ error: 'unknown_type' });
      return;
    }
    const durationMinutes = durationFor(link, types, typeId);
    const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);
    const tz = await firmTimezone(d, link.firmId);
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(startsAt);

    if (link.dailyCap != null) {
      // Cap the number of bookings on the requested APPOINTMENT day. The
      // window must key off starts_at, not created_at — a future-dated
      // request is always created "today", so counting created_at in the
      // appointment-day window returned 0 and the cap never fired.
      const dayStart = new Date(startsAt);
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart.getTime() + 24 * 3600_000);
      const [{ n }] = (await d
        .select({ n: sql<number>`count(*)::int` })
        .from(bookingRequests)
        .where(
          and(
            eq(bookingRequests.bookingLinkId, link.id),
            inArray(bookingRequests.status, ['PENDING', 'APPROVED']),
            gte(bookingRequests.startsAt, dayStart),
            lt(bookingRequests.startsAt, dayEnd),
          ),
        )) as [{ n: number }];
      if (n >= link.dailyCap) {
        res.status(409).json({ error: 'daily_cap_reached' });
        return;
      }
    }

    // Verify the requested slot is genuinely offered + free for the chosen
    // type + location.
    const avail = await getAvailableSlots({
      db: d,
      staffIds: [link.staffId],
      date,
      durationMinutes,
      timezone: tz,
      now: now(),
      busyProvider: providerFor(link.firmId),
      appointmentTypeId: typeId,
      location: chosenLocation?.locationType,
      locationOptionId: chosenLocation?.locationOptionId ?? undefined,
      settingsOverride: settingsOverrideFor(link),
      availabilityRowsOverride: await windowsForDay(d, link, date),
    });
    const offered = avail.slots.some((s) => s.available && s.start === startsAt.toISOString());
    if (!offered) {
      res.status(409).json({ error: 'slot_taken' });
      return;
    }

    const personId = await findOrCreatePerson(d, {
      firmId: link.firmId,
      fullName: name,
      email,
      phone: phone || null,
    }).catch(() => null);

    // Serialize on the staff member, re-check conflict + an existing hold, then
    // insert the PENDING hold — so two concurrent requests can't both take it.
    let requestId: string | null = null;
    try {
      await d.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${link.staffId}::text, 0))`,
        );
        if (await findBookingConflict(tx, [link.staffId], startsAt, endsAt)) {
          throw new Error('slot_taken');
        }
        const [held] = await tx
          .select({ id: bookingRequests.id })
          .from(bookingRequests)
          .where(
            and(
              eq(bookingRequests.staffId, link.staffId),
              eq(bookingRequests.status, 'PENDING'),
              gt(bookingRequests.holdExpiresAt, now()),
              lt(bookingRequests.startsAt, endsAt),
              gt(bookingRequests.endsAt, startsAt),
            ),
          )
          .limit(1);
        if (held) throw new Error('slot_taken');
        const [row] = await tx
          .insert(bookingRequests)
          .values({
            firmId: link.firmId,
            bookingLinkId: link.id,
            staffId: link.staffId,
            appointmentTypeId: typeId ?? null,
            startsAt,
            endsAt,
            durationMinutes,
            visitorName: name,
            visitorEmail: email,
            visitorPhone: phone || null,
            notes: notes || null,
            personId: personId ?? null,
            location: chosenLocation?.locationType ?? null,
            locationOptionId: chosenLocation?.locationOptionId ?? null,
            locationDetail: chosenLocation?.detail ?? null,
            status: 'PENDING',
            holdExpiresAt: new Date(now().getTime() + link.holdExpiryHours * 3600_000),
          })
          .returning({ id: bookingRequests.id });
        requestId = row!.id;
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'slot_taken') {
        res.status(409).json({ error: 'slot_taken' });
        return;
      }
      logger.error({ err }, 'booking request insert failed');
      res.status(500).json({ error: 'request_failed' });
      return;
    }

    const fmt = formatWhen(startsAt, tz);
    // Best-effort fan-out: notify staff, confirm to the visitor.
    void notifyStaffOfRequest(deps, d, link, requestId!, { name, email, fmt }).catch((err) =>
      logger.warn({ err }, 'booking request staff notify failed'),
    );
    void confirmToVisitor(deps, d, link, { name, email, phone: phone || null, fmt }).catch((err) =>
      logger.warn({ err }, 'booking request visitor confirm failed'),
    );

    res.status(201).json({
      ok: true,
      message:
        'Your booking request was received. You will get a confirmation once it is approved.',
    });
  });

  return router;
}

function formatWhen(at: Date, tz: string): { date: string; time: string } {
  return {
    date: new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'full' }).format(at),
    time: new Intl.DateTimeFormat('en-US', { timeZone: tz, timeStyle: 'short' }).format(at),
  };
}

async function notifyStaffOfRequest(
  deps: PublicBookingRoutesDeps,
  db: Database,
  link: ResolvedLink,
  requestId: string,
  visitor: { name: string; email: string; fmt: { date: string; time: string } },
): Promise<void> {
  const approvers = await db
    .select({ id: publicBookingLinkApprovers.appUserId })
    .from(publicBookingLinkApprovers)
    .where(eq(publicBookingLinkApprovers.bookingLinkId, link.id));
  const notify = await db
    .select({ id: publicBookingLinkNotify.appUserId, channels: publicBookingLinkNotify.channels })
    .from(publicBookingLinkNotify)
    .where(eq(publicBookingLinkNotify.bookingLinkId, link.id));

  const approverIds = new Set(approvers.map((a) => a.id));
  const recipientIds = new Set<string>([...approverIds, ...notify.map((n) => n.id)]);
  if (recipientIds.size === 0) return;

  const users = await db
    .select({
      id: appUsers.id,
      email: appUsers.email,
      name: appUsers.fullName,
      phone: appUsers.smsOtpPhoneE164,
    })
    .from(appUsers)
    .where(inArray(appUsers.id, [...recipientIds]));
  const smsByUser = new Map(notify.map((n) => [n.id, (n.channels ?? []).includes('SMS')]));

  const actionUrl = `${deps.staffBaseUrl ?? ''}/appointments?bookingRequest=${requestId}`;
  const subject = `Booking request: ${visitor.name} — ${visitor.fmt.date} ${visitor.fmt.time}`;
  const lines = [
    `${visitor.name} requested an appointment with ${link.staffName}:`,
    ``,
    `  ${visitor.fmt.date} at ${visitor.fmt.time}`,
    `  ${visitor.name} <${visitor.email}>`,
    ``,
    `Review and approve or decline: ${actionUrl}`,
  ].join('\n');

  for (const u of users) {
    if (approverIds.has(u.id)) {
      await db
        .insert(staffNotifications)
        .values({
          firmId: link.firmId,
          recipientAppUserId: u.id,
          type: 'booking_request',
          entityType: 'booking_request',
          entityId: requestId,
          title: 'Booking request needs approval',
          body: `${visitor.name} — ${visitor.fmt.date} ${visitor.fmt.time}`,
          actionUrl: `/appointments?bookingRequest=${requestId}`,
        })
        .catch((err: unknown) => logger.warn({ err }, 'booking staff_notification insert failed'));
      pokeStaffEvents([u.id]);
    }
    if (deps.sendEmail && u.email) {
      await deps.sendEmail({ to: u.email, subject, body: lines }).catch(() => undefined);
    }
    if (deps.sendSms && smsByUser.get(u.id) && u.phone) {
      await deps.sendSms({ to: u.phone, body: `${subject}. ${actionUrl}` }).catch(() => undefined);
    }
  }
}

async function confirmToVisitor(
  deps: PublicBookingRoutesDeps,
  db: Database,
  link: ResolvedLink,
  visitor: {
    name: string;
    email: string;
    phone: string | null;
    fmt: { date: string; time: string };
  },
): Promise<void> {
  const firm = await firmScope(db, link.firmId);
  const context = {
    client: { name: visitor.name },
    firm,
    staff: { names: link.staffName },
    appointment: { date: visitor.fmt.date, time: visitor.fmt.time },
  };
  if (deps.sendEmail) {
    const override = await loadNotificationTemplate(
      db,
      link.firmId,
      'booking_request_submitted',
      'EMAIL',
    );
    const { subject, body } = renderNotification({
      override,
      fallback: {
        subject: 'We received your booking request',
        body:
          `Hi ${visitor.name},\n\n` +
          `Thanks for requesting an appointment with ${link.staffName}:\n\n` +
          `${visitor.fmt.date} at ${visitor.fmt.time}\n\n` +
          `Your request is pending confirmation — we'll email you as soon as it's approved.`,
      },
      context,
    });
    await deps
      .sendEmail({
        to: visitor.email,
        subject: subject ?? 'We received your booking request',
        body,
      })
      .catch(() => undefined);
  }
  if (deps.sendSms && visitor.phone) {
    const override = await loadNotificationTemplate(
      db,
      link.firmId,
      'booking_request_submitted',
      'SMS',
    );
    const { body } = renderNotification({
      override,
      fallback: {
        body: `We received your booking request for ${visitor.fmt.date} at ${visitor.fmt.time}. It is pending confirmation.`,
      },
      context,
    });
    await deps.sendSms({ to: visitor.phone, body }).catch(() => undefined);
  }
}
