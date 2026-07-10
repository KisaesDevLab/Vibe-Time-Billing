// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// BK-1 — Default appointment types seeded on first firm setup. Firms
// tune these in Settings → Appointments → Appointment Types. Idempotent:
// only inserts when the firm has zero types, so operator edits survive.

import { eq, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import { appointmentTypes } from '../schema/core';

export interface AppointmentTypeDefault {
  name: string;
  defaultDurationMinutes: number;
  defaultLocationType: 'VIDEO' | 'PHONE' | 'IN_PERSON';
  color: string;
  description: string;
}

export const DEFAULT_APPOINTMENT_TYPES: ReadonlyArray<AppointmentTypeDefault> = [
  {
    name: 'Initial Consultation',
    defaultDurationMinutes: 60,
    defaultLocationType: 'IN_PERSON',
    color: '#2563eb',
    description: 'First meeting with a prospective or new client.',
  },
  {
    name: 'Tax Preparation',
    defaultDurationMinutes: 60,
    defaultLocationType: 'IN_PERSON',
    color: '#7c3aed',
    description: 'Gather documents and prepare the return.',
  },
  {
    name: 'Tax Planning',
    defaultDurationMinutes: 45,
    defaultLocationType: 'VIDEO',
    color: '#0891b2',
    description: 'Proactive year-round tax strategy session.',
  },
  {
    name: 'Tax Return Review',
    defaultDurationMinutes: 45,
    defaultLocationType: 'VIDEO',
    color: '#db2777',
    description: 'Walk through the completed return before filing.',
  },
  {
    name: 'Advisory / Planning Meeting',
    defaultDurationMinutes: 30,
    defaultLocationType: 'PHONE',
    color: '#16a34a',
    description: 'General advisory or financial-planning discussion.',
  },
  {
    name: 'Document Drop-off',
    defaultDurationMinutes: 15,
    defaultLocationType: 'IN_PERSON',
    color: '#ca8a04',
    description: 'Quick stop to hand off paperwork.',
  },
  {
    name: 'Phone Call',
    defaultDurationMinutes: 30,
    defaultLocationType: 'PHONE',
    color: '#475569',
    description: 'Scheduled phone call.',
  },
];

// reason: drizzle-orm's per-schema Tx types are not assignment-compatible
// across call sites; widening keeps the helper usable from seed scripts,
// the firm-creation transaction, and the admin seed-defaults route.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = PgDatabase<PgQueryResultHKT, any, any>;

/**
 * Seed the default appointment types for a firm — only when it has
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
      description: d.description,
      sortOrder: i,
    })),
  );
  return DEFAULT_APPOINTMENT_TYPES.length;
}
