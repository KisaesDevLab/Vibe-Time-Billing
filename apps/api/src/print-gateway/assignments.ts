// SPDX-License-Identifier: Elastic-2.0
//
// Printer → office assignments. Maps a Vibe Print gateway printer
// (numeric id) to an office + label so the picker can group printers by
// location and staff pick the right one.

import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { offices, printerAssignments } from '@vibe/db/schema';

export interface PrinterAssignmentRow {
  gatewayPrinterId: number;
  officeId: string | null;
  officeName: string | null;
  label: string | null;
  enabled: boolean;
}

export async function listAssignments(
  db: Database,
  firmId: string,
): Promise<PrinterAssignmentRow[]> {
  return db
    .select({
      gatewayPrinterId: printerAssignments.gatewayPrinterId,
      officeId: printerAssignments.officeId,
      officeName: offices.name,
      label: printerAssignments.label,
      enabled: printerAssignments.enabled,
    })
    .from(printerAssignments)
    .leftJoin(offices, eq(offices.id, printerAssignments.officeId))
    .where(eq(printerAssignments.firmId, firmId));
}

export interface UpsertAssignmentInput {
  gatewayPrinterId: number;
  officeId?: string | null;
  label?: string | null;
  enabled?: boolean;
}

export async function upsertAssignment(
  db: Database,
  firmId: string,
  input: UpsertAssignmentInput,
): Promise<void> {
  await db
    .insert(printerAssignments)
    .values({
      firmId,
      gatewayPrinterId: input.gatewayPrinterId,
      officeId: input.officeId ?? null,
      label: input.label ?? null,
      enabled: input.enabled ?? true,
    })
    .onConflictDoUpdate({
      target: [printerAssignments.firmId, printerAssignments.gatewayPrinterId],
      set: {
        officeId: input.officeId ?? null,
        label: input.label ?? null,
        enabled: input.enabled ?? true,
        updatedAt: new Date(),
      },
    });
}

/** The enabled gateway printer assigned to an office, or null. */
export async function resolveOfficePrinter(
  db: Database,
  firmId: string,
  officeId: string | null,
): Promise<number | null> {
  if (!officeId) return null;
  const [row] = await db
    .select({ printerId: printerAssignments.gatewayPrinterId })
    .from(printerAssignments)
    .where(
      and(
        eq(printerAssignments.firmId, firmId),
        eq(printerAssignments.officeId, officeId),
        eq(printerAssignments.enabled, true),
      ),
    )
    .limit(1);
  return row?.printerId ?? null;
}

/** Resolve a single user's preselect printer: remembered → a printer
 *  assigned to their default office → firm default. Returns null if none. */
export async function resolvePreselectPrinter(
  db: Database,
  firmId: string,
  opts: {
    userDefaultPrinterId: number | null;
    userOfficeId: string | null;
    firmDefault: number | null;
  },
): Promise<number | null> {
  if (opts.userDefaultPrinterId != null) return opts.userDefaultPrinterId;
  if (opts.userOfficeId) {
    const [row] = await db
      .select({ printerId: printerAssignments.gatewayPrinterId })
      .from(printerAssignments)
      .where(
        and(
          eq(printerAssignments.firmId, firmId),
          eq(printerAssignments.officeId, opts.userOfficeId),
          eq(printerAssignments.enabled, true),
        ),
      )
      .limit(1);
    if (row) return row.printerId;
  }
  return opts.firmDefault;
}
