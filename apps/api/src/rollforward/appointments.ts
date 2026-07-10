// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Rollforward Phase 4: appointment candidates for the APPROVED engagement
// candidates (cascade), with suggested next-year datetimes (date moved by the
// same deadline rule, wall-clock time-of-day preserved in the firm timezone),
// plus a conflict service reusing the BK booking overlap engine for existing
// appointments and an in-memory half-open check within the batch.

import { and, eq, inArray, ne } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appointmentStaff,
  appointments,
  offices,
  rollforwardAppointmentCandidates,
  rollforwardEngagementCandidates,
} from '@vibe/db/schema';
import { mapDateTime, type MappingMode } from '@vibe/core/rollforward';

import { findBookingConflict } from '../appointments/availability';

async function firmTimezone(db: Database, firmId: string): Promise<string> {
  const [o] = await db
    .select({ tz: offices.timezone })
    .from(offices)
    .where(and(eq(offices.firmId, firmId), eq(offices.isDefault, true)))
    .limit(1);
  return o?.tz ?? 'America/Chicago';
}

export async function buildAppointmentCandidates(
  db: Database,
  opts: {
    batchId: string;
    firmId: string;
    targetYear: number;
    mode: MappingMode;
    // Q46 — when true, also build candidates for appointments whose engagement
    // is NOT approved (they commit engagement-less). Default: cascade hard-block.
    allowAppointmentOnly?: boolean;
  },
): Promise<number> {
  // By default only appointments tied to engagements approved in step 2 (the
  // cascade); with the opt-in, all engagement candidates' appointments.
  const engCands = await db
    .select({
      id: rollforwardEngagementCandidates.id,
      sourceEngagementId: rollforwardEngagementCandidates.sourceEngagementId,
      returnType: rollforwardEngagementCandidates.returnType,
    })
    .from(rollforwardEngagementCandidates)
    .where(
      opts.allowAppointmentOnly
        ? eq(rollforwardEngagementCandidates.batchId, opts.batchId)
        : and(
            eq(rollforwardEngagementCandidates.batchId, opts.batchId),
            eq(rollforwardEngagementCandidates.status, 'APPROVED'),
          ),
    );

  // Re-runnable preview: clear prior appointment candidates for this batch.
  await db
    .delete(rollforwardAppointmentCandidates)
    .where(eq(rollforwardAppointmentCandidates.batchId, opts.batchId));
  if (engCands.length === 0) return 0;

  const byEngId = new Map(engCands.map((e) => [e.sourceEngagementId, e]));
  const appts = await db
    .select({
      id: appointments.id,
      engagementId: appointments.engagementId,
      clientId: appointments.clientId,
      title: appointments.title,
      startsAt: appointments.startsAt,
      endsAt: appointments.endsAt,
      durationMinutes: appointments.durationMinutes,
      location: appointments.location,
      locationOptionId: appointments.locationOptionId,
      leadAppUserId: appointments.leadAppUserId,
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.firmId, opts.firmId),
        inArray(
          appointments.engagementId,
          engCands.map((e) => e.sourceEngagementId),
        ),
        ne(appointments.status, 'CANCELLED'),
      ),
    );
  if (appts.length === 0) return 0;

  const staffRows = await db
    .select({ appointmentId: appointmentStaff.appointmentId, staffId: appointmentStaff.staffId })
    .from(appointmentStaff)
    .where(
      inArray(
        appointmentStaff.appointmentId,
        appts.map((a) => a.id),
      ),
    );
  const staffByAppt = new Map<string, string[]>();
  for (const r of staffRows) {
    const arr = staffByAppt.get(r.appointmentId) ?? [];
    arr.push(r.staffId);
    staffByAppt.set(r.appointmentId, arr);
  }

  const tz = await firmTimezone(db, opts.firmId);
  const rows = appts.map((a) => {
    const ec = byEngId.get(a.engagementId!)!;
    const duration =
      a.durationMinutes ?? Math.round((a.endsAt.getTime() - a.startsAt.getTime()) / 60_000);
    const suggested = mapDateTime({
      sourceUtcISO: a.startsAt.toISOString(),
      returnType: ec.returnType,
      targetYear: opts.targetYear,
      mode: opts.mode,
      zone: tz,
    });
    const staffIds = staffByAppt.get(a.id) ?? (a.leadAppUserId ? [a.leadAppUserId] : []);
    return {
      batchId: opts.batchId,
      firmId: opts.firmId,
      engagementCandidateId: ec.id,
      sourceAppointmentId: a.id,
      clientId: a.clientId,
      title: a.title,
      staffIds,
      sourceStartsAt: a.startsAt,
      suggestedStartsAt: new Date(suggested),
      durationMinutes: duration,
      location: a.location,
      locationOptionId: a.locationOptionId,
    };
  });
  await db.insert(rollforwardAppointmentCandidates).values(rows);
  await recomputeConflicts(db, opts.batchId);
  return rows.length;
}

// Flag candidates whose suggested datetime overlaps an existing appointment
// (BK engine) or another suggested appointment in the batch, per shared staff.
export async function recomputeConflicts(db: Database, batchId: string): Promise<void> {
  const cands = await db
    .select()
    .from(rollforwardAppointmentCandidates)
    .where(
      and(
        eq(rollforwardAppointmentCandidates.batchId, batchId),
        ne(rollforwardAppointmentCandidates.status, 'SKIPPED'),
      ),
    );
  const windows = cands.map((c) => {
    const start = c.suggestedStartsAt;
    return {
      id: c.id,
      staffIds: (c.staffIds as string[]) ?? [],
      start,
      end: start ? new Date(start.getTime() + c.durationMinutes * 60_000) : null,
    };
  });

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i]!;
    let conflict = false;
    if (w.start && w.end && w.staffIds.length > 0) {
      conflict = await findBookingConflict(db, w.staffIds, w.start, w.end);
      if (!conflict) {
        for (let j = 0; j < windows.length; j++) {
          if (i === j) continue;
          const o = windows[j]!;
          if (!o.start || !o.end) continue;
          const sharesStaff = w.staffIds.some((s) => o.staffIds.includes(s));
          // half-open overlap (back-to-back does not conflict)
          if (sharesStaff && w.start < o.end && w.end > o.start) {
            conflict = true;
            break;
          }
        }
      }
    }
    await db
      .update(rollforwardAppointmentCandidates)
      .set({ conflict })
      .where(eq(rollforwardAppointmentCandidates.id, w.id));
  }
}
