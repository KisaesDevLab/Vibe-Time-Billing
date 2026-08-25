// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Printer → office assignments. Maps a Vibe Print gateway printer
// (numeric id, unique within its gateway) to an office + label so the
// picker can group printers by location and staff pick the right one.
// PGW-1 (0228): every assignment may carry its owning gateway_id (null =
// the implicit legacy/default gateway) and resolution returns the
// (gateway, printer) pair — a bare printer id is only meaningful within
// one gateway. Office-printer picks are deterministic:
// is_office_default DESC, created_at ASC (D-PGW-08).

import { and, asc, desc, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { offices, printerAssignments } from '@vibe/db/schema';

export interface PrinterAssignmentRow {
  gatewayPrinterId: number;
  gatewayId: string | null;
  officeId: string | null;
  officeName: string | null;
  label: string | null;
  enabled: boolean;
  isOfficeDefault: boolean;
}

export async function listAssignments(
  db: Database,
  firmId: string,
): Promise<PrinterAssignmentRow[]> {
  return db
    .select({
      gatewayPrinterId: printerAssignments.gatewayPrinterId,
      gatewayId: printerAssignments.gatewayId,
      officeId: printerAssignments.officeId,
      officeName: offices.name,
      label: printerAssignments.label,
      enabled: printerAssignments.enabled,
      isOfficeDefault: printerAssignments.isOfficeDefault,
    })
    .from(printerAssignments)
    .leftJoin(offices, eq(offices.id, printerAssignments.officeId))
    .where(eq(printerAssignments.firmId, firmId));
}

export interface UpsertAssignmentInput {
  gatewayPrinterId: number;
  gatewayId?: string | null;
  officeId?: string | null;
  label?: string | null;
  enabled?: boolean;
  isOfficeDefault?: boolean;
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
      gatewayId: input.gatewayId ?? null,
      officeId: input.officeId ?? null,
      label: input.label ?? null,
      enabled: input.enabled ?? true,
      isOfficeDefault: input.isOfficeDefault ?? false,
    })
    .onConflictDoUpdate({
      // The legacy firm-wide unique index still governs writes until the
      // PGW-5 cutover drops it (only one implicit gateway exists until
      // the admin migrates the blob).
      target: [printerAssignments.firmId, printerAssignments.gatewayPrinterId],
      set: {
        gatewayId: input.gatewayId ?? null,
        officeId: input.officeId ?? null,
        label: input.label ?? null,
        enabled: input.enabled ?? true,
        isOfficeDefault: input.isOfficeDefault ?? false,
        updatedAt: new Date(),
      },
    });
}

/** A dispatchable (gateway, printer) pair. gatewayId null = the firm's
 *  default/legacy gateway. */
export interface PrinterTarget {
  gatewayId: string | null;
  printerId: number;
}

/** The office's assigned printer as a (gateway, printer) pair —
 *  deterministic: is_office_default DESC, created_at ASC. */
export async function resolveOfficePrinterTarget(
  db: Database,
  firmId: string,
  officeId: string | null,
): Promise<PrinterTarget | null> {
  if (!officeId) return null;
  const [row] = await db
    .select({
      printerId: printerAssignments.gatewayPrinterId,
      gatewayId: printerAssignments.gatewayId,
    })
    .from(printerAssignments)
    .where(
      and(
        eq(printerAssignments.firmId, firmId),
        eq(printerAssignments.officeId, officeId),
        eq(printerAssignments.enabled, true),
      ),
    )
    .orderBy(desc(printerAssignments.isOfficeDefault), asc(printerAssignments.createdAt))
    .limit(1);
  return row ? { gatewayId: row.gatewayId ?? null, printerId: row.printerId } : null;
}

/** Back-compat shim (pre-PGW callers): office printer as a bare id.
 *  Dispatch surfaces move to resolveOfficePrinterTarget in PGW-2. */
export async function resolveOfficePrinter(
  db: Database,
  firmId: string,
  officeId: string | null,
): Promise<number | null> {
  return (await resolveOfficePrinterTarget(db, firmId, officeId))?.printerId ?? null;
}

/** Resolve a single user's preselect printer as a (gateway, printer)
 *  pair: remembered → their office's printer → firm default. */
export async function resolvePreselectPrinterTarget(
  db: Database,
  firmId: string,
  opts: {
    userDefaultPrinterId: number | null;
    userDefaultPrinterGatewayId?: string | null;
    userOfficeId: string | null;
    firmDefault: number | null;
    firmDefaultGatewayId?: string | null;
  },
): Promise<PrinterTarget | null> {
  if (opts.userDefaultPrinterId != null) {
    return {
      gatewayId: opts.userDefaultPrinterGatewayId ?? null,
      printerId: opts.userDefaultPrinterId,
    };
  }
  const office = await resolveOfficePrinterTarget(db, firmId, opts.userOfficeId);
  if (office) return office;
  if (opts.firmDefault != null) {
    return { gatewayId: opts.firmDefaultGatewayId ?? null, printerId: opts.firmDefault };
  }
  return null;
}

/** Back-compat shim (pre-PGW callers): preselect printer as a bare id.
 *  Pickers move to resolvePreselectPrinterTarget in PGW-4. */
export async function resolvePreselectPrinter(
  db: Database,
  firmId: string,
  opts: {
    userDefaultPrinterId: number | null;
    userOfficeId: string | null;
    firmDefault: number | null;
  },
): Promise<number | null> {
  return (await resolvePreselectPrinterTarget(db, firmId, opts))?.printerId ?? null;
}
