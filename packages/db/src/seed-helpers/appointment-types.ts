// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// BK-1 — Default appointment types seeded on first firm setup. Firms
// tune these in Settings → Appointments → Appointment Types. Idempotent:
// only inserts when the firm has zero types, so operator edits survive.

import { eq, sql } from 'drizzle-orm';
import type { PgDatabase, QueryResultHKT } from 'drizzle-orm/pg-core';

import { appointmentTypes } from '../schema/core';

export interface AppointmentTypeDefault {
  name: string;
  defaultDurationMinutes: number;
  defaultLocationType: 'VIDEO' | 'PHONE' | 'IN_PERSON';
  color: string;
}

export const DEFAULT_APPOINTMENT_TYPES: ReadonlyArray<AppointmentTypeDefault> = [
  {
    name: 'Initial Consultation',
    defaultDurationMinutes: 60,
    defaultLocationType: 'IN_PERSON',
    color: '#2563eb',
  },
  {
    name: 'Tax Review',
    defaultDurationMinutes: 45,
    defaultLocationType: 'VIDEO',
    color: '#7c3aed',
  },
  {
    name: 'Planning Meeting',
    defaultDurationMinutes: 30,
    defaultLocationType: 'PHONE',
    color: '#0891b2',
  },
  {
    name: 'Document Drop-off',
    defaultDurationMinutes: 15,
    defaultLocationType: 'IN_PERSON',
    color: '#16a34a',
  },
  {
    name: 'Phone Call',
    defaultDurationMinutes: 30,
    defaultLocationType: 'PHONE',
    color: '#ca8a04',
  },
];

// reason: drizzle-orm's per-schema Tx types are not assignment-compatible
// across call sites; widening keeps the helper usable from seed scripts,
// the firm-creation transaction, and the admin seed-defaults route.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = PgDatabase<QueryResultHKT, any, any>;

/**
 * Seed the 5 default appointment types for a firm — only when it has
 * none yet. Returns the number inserted (0 if the firm already had any).
 */
export async function seedAppointmentTypes(tx: Tx, firmId: string): Promise<number> {
  const [existing] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(appointmentTypes)
    .where(eq(appointmentTypes.firmId, firmId));
  if ((existing?.n ?? 0) > 0) return 0;

  await tx.insert(appointmentTypes).values(
    DEFAULT_APPOINTMENT_TYPES.map((d, i) => ({
      firmId,
      name: d.name,
      defaultDurationMinutes: d.defaultDurationMinutes,
      defaultLocationType: d.defaultLocationType,
      color: d.color,
      sortOrder: i,
    })),
  );
  return DEFAULT_APPOINTMENT_TYPES.length;
}
