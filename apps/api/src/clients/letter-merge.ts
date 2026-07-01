// SPDX-License-Identifier: Elastic-2.0
//
// Mail-merge: render a firm letter template personalized for one or more
// clients. Phase 1 output is a single combined PDF (one page-run per
// client). Reuses the invoice/statement template engine (so letters get
// {{ }} / {{#if}} / {{#each}} + CSS) and the same firm/client token
// conventions as the rest of the app.
//
// A letter template is an `engagement_letter_template` row (firm library,
// edited in Admin → Templates → Letter). Its `bodyHtml` may be a full
// HTML document (with its own <style>/@page for letterhead + page size);
// tokens are substituted in that HTML per client.

import { and, asc, eq, gte, inArray, isNotNull, lt } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appointments,
  clientContacts,
  clientRequests,
  clients,
  engagementLetterTemplates,
  engagements,
  offices,
  persons,
} from '@vibe/db/schema';
import {
  composeInvoiceHtml,
  escapeHtml,
  formatDateUS,
  type TemplateContext,
} from '@vibe/core/invoicing';

import { formatMailingAddress } from './mailing-print';

export interface LetterTemplateLite {
  id: string;
  name: string;
  engagementTypeId: string | null;
}

/** Active letter templates for the merge picker. */
export async function listLetterTemplates(
  db: Database,
  firmId: string,
): Promise<LetterTemplateLite[]> {
  const rows = await db
    .select({
      id: engagementLetterTemplates.id,
      name: engagementLetterTemplates.name,
      engagementTypeId: engagementLetterTemplates.engagementTypeId,
      status: engagementLetterTemplates.status,
    })
    .from(engagementLetterTemplates)
    .where(eq(engagementLetterTemplates.firmId, firmId));
  return rows
    .filter((r) => r.status === 'ACTIVE')
    .map((r) => ({ id: r.id, name: r.name, engagementTypeId: r.engagementTypeId }));
}

/** Load one template's body, firm-scoped. Null when not found. */
export async function loadLetterTemplateBody(
  db: Database,
  firmId: string,
  templateId: string,
): Promise<{ name: string; bodyHtml: string } | null> {
  const [row] = await db
    .select({ name: engagementLetterTemplates.name, bodyHtml: engagementLetterTemplates.bodyHtml })
    .from(engagementLetterTemplates)
    .where(
      and(
        eq(engagementLetterTemplates.id, templateId),
        eq(engagementLetterTemplates.firmId, firmId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export interface ClientLetterData {
  id: string;
  name: string;
  clientFacingName: string | null;
  mailingStreet1: string | null;
  mailingStreet2: string | null;
  mailingCity: string | null;
  mailingState: string | null;
  mailingPostal: string | null;
  mailingCountry: string | null;
  /** Greeting name — primary → billing → first ACTIVE contact (any). */
  primaryContactName: string | null;
  /** Email delivery target — primary → billing → first ACTIVE contact
   *  that HAS an email. Null when none has an email (letter can't email). */
  recipientEmail: string | null;
  recipientName: string | null;
  /** Soonest OPEN drop-off due date across the client's engagements,
   *  formatted MM/DD/YYYY. Null when none. */
  dropOffDate?: string | null;
  /** Selected-appointment context — only set by loadAppointmentLetterData
   *  (the Appointments-list mail merge), one letter per appointment. */
  appointment?: AppointmentLetterCtx | null;
  /** Engagement name — only set by loadEngagementLetterData. */
  engagementName?: string | null;
}

export interface AppointmentLetterCtx {
  /** "MM/DD/YYYY at H:MM AM/PM" in the firm's default-office timezone. */
  datetime: string;
  date: string;
  time: string;
  title: string;
  location: string;
}

/** Load the per-client data a letter needs (mailing address + primary
 *  contact name), firm-scoped, preserving the caller's id order. */
export async function loadClientLetterData(
  db: Database,
  firmId: string,
  clientIds: string[],
): Promise<ClientLetterData[]> {
  const rows = await db
    .select({
      id: clients.id,
      name: clients.name,
      clientFacingName: clients.clientFacingName,
      mailingStreet1: clients.mailingStreet1,
      mailingStreet2: clients.mailingStreet2,
      mailingCity: clients.mailingCity,
      mailingState: clients.mailingState,
      mailingPostal: clients.mailingPostal,
      mailingCountry: clients.mailingCountry,
    })
    .from(clients)
    .where(and(eq(clients.firmId, firmId), inArray(clients.id, clientIds)));
  if (rows.length === 0) return [];

  const contactRows = await db
    .select({
      clientId: clientContacts.clientId,
      fullName: persons.fullName,
      email: persons.email,
      isPrimary: clientContacts.isPrimary,
      isBilling: clientContacts.isBilling,
      status: clientContacts.status,
    })
    .from(clientContacts)
    .innerJoin(persons, eq(persons.id, clientContacts.personId))
    .where(
      inArray(
        clientContacts.clientId,
        rows.map((r) => r.id),
      ),
    );
  const byClient = new Map<string, typeof contactRows>();
  for (const c of contactRows) {
    if (c.status !== 'ACTIVE') continue;
    const arr = byClient.get(c.clientId) ?? [];
    arr.push(c);
    byClient.set(c.clientId, arr);
  }
  const pickName = (clientId: string): string | null => {
    const cs = byClient.get(clientId) ?? [];
    const pick = cs.find((c) => c.isPrimary) || cs.find((c) => c.isBilling) || cs[0];
    return pick?.fullName ?? null;
  };
  const pickRecipient = (clientId: string): { email: string; name: string | null } | null => {
    const cs = byClient.get(clientId) ?? [];
    const pick =
      cs.find((c) => c.isPrimary && c.email) ||
      cs.find((c) => c.isBilling && c.email) ||
      cs.find((c) => c.email);
    return pick?.email ? { email: pick.email, name: pick.fullName ?? null } : null;
  };

  // Soonest OPEN drop-off due date per client (via engagement → client).
  const dropRows = await db
    .select({ clientId: engagements.clientId, dueDate: clientRequests.dueDate })
    .from(clientRequests)
    .innerJoin(engagements, eq(clientRequests.engagementId, engagements.id))
    .where(
      and(
        eq(clientRequests.firmId, firmId),
        inArray(
          engagements.clientId,
          rows.map((r) => r.id),
        ),
        eq(clientRequests.kind, 'DROP_OFF'),
        eq(clientRequests.status, 'OPEN'),
        isNotNull(clientRequests.dueDate),
      ),
    )
    .orderBy(asc(clientRequests.dueDate));
  const dropByClient = new Map<string, string>();
  for (const d of dropRows) {
    // Ordered asc by dueDate → first seen per client is the soonest.
    if (d.dueDate && !dropByClient.has(d.clientId)) {
      dropByClient.set(d.clientId, formatDateUS(d.dueDate));
    }
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  // Preserve caller order; drop ids that weren't found / not in firm.
  return clientIds
    .map((id) => byId.get(id))
    .filter((r): r is (typeof rows)[number] => Boolean(r))
    .map((r) => {
      const recipient = pickRecipient(r.id);
      return {
        ...r,
        primaryContactName: pickName(r.id),
        recipientEmail: recipient?.email ?? null,
        recipientName: recipient?.name ?? null,
        dropOffDate: dropByClient.get(r.id) ?? null,
      };
    });
}

/** Firm's default-office timezone (fallback America/Chicago) — used to
 *  render appointment times in the letter. Mirrors email-jobs.ts. */
async function firmTimezone(db: Database, firmId: string): Promise<string> {
  const [row] = await db
    .select({ tz: offices.timezone })
    .from(offices)
    .where(and(eq(offices.firmId, firmId), eq(offices.isDefault, true)))
    .limit(1);
  return row?.tz ?? 'America/Chicago';
}

// Milliseconds `tz` is ahead of UTC at the given instant (DST-aware).
function tzOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const m: Record<string, number> = {};
  for (const p of parts) if (p.type !== 'literal') m[p.type] = Number(p.value);
  // Intl gives 24 for midnight; normalize.
  const hour = m['hour'] === 24 ? 0 : m['hour']!;
  const asUtc = Date.UTC(m['year']!, m['month']! - 1, m['day']!, hour, m['minute']!, m['second']!);
  return asUtc - at.getTime();
}

/** The UTC instant of local midnight (start of day) for `ymd` (YYYY-MM-DD)
 *  in timezone `tz`. Used so an appointment date-range filter matches the
 *  calendar day the firm actually sees. Exported for tests. */
export function zonedDayStartUtc(ymd: string, tz: string): Date {
  const [y, mo, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y!, mo! - 1, d!, 0, 0, 0);
  // Correct the guess by the tz offset at that (approximate) instant.
  return new Date(guess - tzOffsetMs(new Date(guess), tz));
}

/** ymd + 1 day, as a YYYY-MM-DD string (calendar arithmetic, UTC-safe).
 *  Exported for tests. */
export function nextYmd(ymd: string): string {
  const [y, mo, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, mo! - 1, d! + 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

const LOCATION_LABEL: Record<string, string> = {
  VIDEO: 'Video',
  PHONE: 'Phone',
  IN_PERSON: 'In person',
};

function formatAppt(
  startsAt: Date,
  title: string,
  location: string,
  tz: string,
): AppointmentLetterCtx {
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
  }).format(startsAt);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
  }).format(startsAt);
  return {
    datetime: `${date} at ${time}`,
    date,
    time,
    title,
    location: LOCATION_LABEL[location] ?? location,
  };
}

/** One letter row per selected appointment (Appointments-list mail merge):
 *  the appointment's client + that appointment's date/time context. Skips
 *  appointments with no client (internal meetings) or missing client.
 *  Preserves the caller's appointment-id order. */
export async function loadAppointmentLetterData(
  db: Database,
  firmId: string,
  appointmentIds: string[],
): Promise<ClientLetterData[]> {
  const appts = await db
    .select({
      id: appointments.id,
      clientId: appointments.clientId,
      startsAt: appointments.startsAt,
      title: appointments.title,
      location: appointments.location,
    })
    .from(appointments)
    .where(and(eq(appointments.firmId, firmId), inArray(appointments.id, appointmentIds)));
  if (appts.length === 0) return [];
  const clientIds = [
    ...new Set(appts.map((a) => a.clientId).filter((x): x is string => Boolean(x))),
  ];
  const clientData = await loadClientLetterData(db, firmId, clientIds);
  const clientById = new Map(clientData.map((c) => [c.id, c]));
  const tz = await firmTimezone(db, firmId);
  const rows: ClientLetterData[] = [];
  for (const id of appointmentIds) {
    const a = appts.find((x) => x.id === id);
    if (!a || !a.clientId) continue;
    const c = clientById.get(a.clientId);
    if (!c) continue;
    rows.push({ ...c, appointment: formatAppt(a.startsAt, a.title, a.location, tz) });
  }
  return rows;
}

export interface AppointmentRange {
  /** 'YYYY-MM-DD' inclusive bounds; either may be omitted. */
  from?: string;
  to?: string;
}

/** One letter row per selected engagement (Engagements-list mail merge):
 *  the engagement's client + engagement name + THIS engagement's drop-off
 *  due date + the engagement's appointment (soonest; optionally restricted
 *  to a starts-at date range). Preserves the caller's engagement-id order. */
export async function loadEngagementLetterData(
  db: Database,
  firmId: string,
  engagementIds: string[],
  apptRange?: AppointmentRange,
): Promise<ClientLetterData[]> {
  const now = new Date();
  // engagement has no firm_id — firm-scope via its client.
  const engs = await db
    .select({ id: engagements.id, clientId: engagements.clientId, name: engagements.name })
    .from(engagements)
    .innerJoin(clients, eq(engagements.clientId, clients.id))
    .where(and(eq(clients.firmId, firmId), inArray(engagements.id, engagementIds)));
  if (engs.length === 0) return [];
  const clientData = await loadClientLetterData(db, firmId, [
    ...new Set(engs.map((e) => e.clientId)),
  ]);
  const clientById = new Map(clientData.map((c) => [c.id, c]));

  // Per-engagement OPEN drop-off due date (soonest).
  const drops = await db
    .select({ engagementId: clientRequests.engagementId, dueDate: clientRequests.dueDate })
    .from(clientRequests)
    .where(
      and(
        eq(clientRequests.firmId, firmId),
        inArray(clientRequests.engagementId, engagementIds),
        eq(clientRequests.kind, 'DROP_OFF'),
        eq(clientRequests.status, 'OPEN'),
        isNotNull(clientRequests.dueDate),
      ),
    )
    .orderBy(asc(clientRequests.dueDate));
  const dropByEng = new Map<string, string>();
  for (const d of drops) {
    if (d.dueDate && !dropByEng.has(d.engagementId))
      dropByEng.set(d.engagementId, formatDateUS(d.dueDate));
  }

  const tz = await firmTimezone(db, firmId);
  // Per-engagement appointment (soonest). With a date range, bound by the
  // office-local calendar days [from, to] (converted to UTC instants so a
  // late-evening appointment isn't misfiled by the UTC/office offset). With
  // NO range, restrict to upcoming appointments (soonest still in the future)
  // rather than the earliest in all history.
  const rangeActive = Boolean(apptRange?.from || apptRange?.to);
  const apptConds = [
    eq(appointments.firmId, firmId),
    inArray(appointments.engagementId, engagementIds),
  ];
  if (apptRange?.from)
    apptConds.push(gte(appointments.startsAt, zonedDayStartUtc(apptRange.from, tz)));
  if (apptRange?.to)
    apptConds.push(lt(appointments.startsAt, zonedDayStartUtc(nextYmd(apptRange.to), tz)));
  if (!rangeActive) apptConds.push(gte(appointments.startsAt, now));
  const appts = await db
    .select({
      engagementId: appointments.engagementId,
      startsAt: appointments.startsAt,
      title: appointments.title,
      location: appointments.location,
    })
    .from(appointments)
    .where(and(...apptConds))
    .orderBy(asc(appointments.startsAt));
  const apptByEng = new Map<string, (typeof appts)[number]>();
  for (const a of appts) {
    if (a.engagementId && !apptByEng.has(a.engagementId)) apptByEng.set(a.engagementId, a);
  }

  const rows: ClientLetterData[] = [];
  for (const engId of engagementIds) {
    const e = engs.find((x) => x.id === engId);
    if (!e) continue;
    const c = clientById.get(e.clientId);
    if (!c) continue;
    const a = apptByEng.get(engId);
    if (rangeActive && !a) continue; // skip engagements with no in-range appointment
    rows.push({
      ...c,
      engagementName: e.name,
      dropOffDate: dropByEng.get(engId) ?? null,
      appointment: a ? formatAppt(a.startsAt, a.title, a.location, tz) : null,
    });
  }
  return rows;
}

/** MM/DD/YYYY for the `today` token, in the server's local time. */
function todayUS(now: Date): string {
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${now.getFullYear()}`;
}

/** Build the template context for one client. `firm` is the shared
 *  `firmScope` record (fetched once per merge run). */
export function buildLetterContext(
  client: ClientLetterData,
  firm: Record<string, string>,
  now: Date,
): TemplateContext {
  const addressLines = formatMailingAddress(client); // \n-joined, '' when empty
  const addressHtml = addressLines
    .split('\n')
    .map((l) => escapeHtml(l))
    .join('<br>');
  const cityState = [client.mailingCity, client.mailingState].filter(Boolean).join(', ');
  const cityStateZip = [cityState, client.mailingPostal].filter(Boolean).join(' ');
  return {
    firm,
    today: todayUS(now),
    client: {
      name: client.name,
      display_name: (client.clientFacingName ?? '').trim() || client.name,
      primary_contact: client.primaryContactName ?? '',
      // Plain multi-line block (use with CSS `white-space: pre-line`) and a
      // ready <br> HTML variant (use via `{{{ client.address_block_html }}}`).
      mailing_address: addressLines,
      address_block_html: addressHtml,
      street1: client.mailingStreet1 ?? '',
      street2: client.mailingStreet2 ?? '',
      city: client.mailingCity ?? '',
      state: client.mailingState ?? '',
      postal: client.mailingPostal ?? '',
      country: client.mailingCountry ?? '',
      city_state_zip: cityStateZip,
      drop_off_date: client.dropOffDate ?? '',
    },
    appointment: {
      datetime: client.appointment?.datetime ?? '',
      date: client.appointment?.date ?? '',
      time: client.appointment?.time ?? '',
      title: client.appointment?.title ?? '',
      location: client.appointment?.location ?? '',
    },
    engagement: {
      name: client.engagementName ?? '',
    },
  };
}

// A stored body is a "full document" (ships its own letterhead/@page via
// <style>/<head>) vs a fragment authored in the WYSIWYG editor. Fragments
// get the default letter stylesheet so they render like a real letter
// (1in margins, serif body, an <h1> firm name + <hr> letterhead rule).
export function isFullHtmlDoc(html: string): boolean {
  return /<!doctype|<html|<head|<style/i.test(html);
}

// Default letterhead/letter styling for fragment (WYSIWYG) letters. An
// <h1> reads as the firm-name letterhead; <hr> is the rule under it.
export const DEFAULT_LETTER_CSS = `
@page { size: Letter; margin: 1in; }
body { font: 12pt Georgia, "Times New Roman", serif; color: #1a1a1a; line-height: 1.5; }
h1 { font-family: Arial, Helvetica, sans-serif; font-size: 20pt; margin: 0 0 4px; }
h2 { font-size: 14pt; margin: 18px 0 6px; }
h3 { font-size: 12pt; margin: 14px 0 6px; }
p { margin: 0 0 12px; }
hr { border: none; border-top: 2px solid #1a1a1a; margin: 8px 0 24px; }
ul, ol { margin: 0 0 12px 22px; }
`;

/** Render one client's letter to a full HTML document. Fragment bodies get
 *  the default letter stylesheet; full-document bodies self-style. */
export function renderLetterHtml(
  bodyHtml: string,
  client: ClientLetterData,
  firm: Record<string, string>,
  now: Date,
): string {
  const css = isFullHtmlDoc(bodyHtml) ? '' : DEFAULT_LETTER_CSS;
  return composeInvoiceHtml(bodyHtml, css, buildLetterContext(client, firm, now));
}

// Token catalog — drives the editor variable picker + docs.
export interface LetterTokenEntry {
  token: string;
  label: string;
  raw?: boolean;
}
export const LETTER_TEMPLATE_TOKENS: LetterTokenEntry[] = [
  { token: 'client.name', label: 'Client legal name' },
  { token: 'client.display_name', label: 'Client display name' },
  { token: 'client.primary_contact', label: 'Primary contact name' },
  { token: 'client.mailing_address', label: 'Mailing address (use pre-line CSS)' },
  { token: 'client.address_block_html', label: 'Mailing address as HTML', raw: true },
  { token: 'client.street1', label: 'Street line 1' },
  { token: 'client.street2', label: 'Street line 2' },
  { token: 'client.city', label: 'City' },
  { token: 'client.state', label: 'State' },
  { token: 'client.postal', label: 'ZIP / postal' },
  { token: 'client.city_state_zip', label: 'City, State ZIP' },
  { token: 'client.drop_off_date', label: 'Drop-off due date' },
  { token: 'appointment.datetime', label: 'Appointment date & time' },
  { token: 'appointment.date', label: 'Appointment date' },
  { token: 'appointment.time', label: 'Appointment time' },
  { token: 'appointment.title', label: 'Appointment title' },
  { token: 'appointment.location', label: 'Appointment location' },
  { token: 'engagement.name', label: 'Engagement name' },
  { token: 'firm.name', label: 'Firm name' },
  { token: 'firm.displayName', label: 'Firm display name' },
  { token: 'firm.support_email', label: 'Firm email' },
  { token: 'firm.support_phone', label: 'Firm phone' },
  { token: 'firm.support_web', label: 'Firm website' },
  { token: 'today', label: "Today's date (MM/DD/YYYY)" },
];
