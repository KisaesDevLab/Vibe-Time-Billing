// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Extends the bulk demo seed (packages/db/src/scripts/seed-demo.ts) with data
// for the newer features that demo seed doesn't cover:
//   - spread engagement.workflow_state across the Kanban columns
//   - client_task rows (the top-level Tasks view + per-client tasks)
//   - appointments (calendar / booking / reminders)
//
// Idempotent-ish: clears its own prior task/appointment rows tagged with the
// [demo] marker before re-inserting. Run with DATABASE_URL + FIRM_ID env vars.

import { and, eq, sql } from 'drizzle-orm';

import { createDb } from '@vibe/db';
import { appointments, appointmentTypes, appUsers, clients, clientTasks } from '@vibe/db/schema';

const MARKER = '[demo]';

const TASK_TITLES = [
  'Request prior-year returns',
  'Follow up on missing 1099s',
  'Reconcile Q3 bank statements',
  'Send engagement letter',
  'Review trial balance',
  'Prepare extension',
  'Confirm estimated tax payment',
  'Gather payroll reports',
  'Schedule planning call',
  'Draft management letter',
  'Review depreciation schedule',
  'Collect K-1s from partners',
  'Verify EIN on file',
  'Upload signed Form 8879',
  'Close out fixed assets',
  'Chase outstanding A/R',
];

const PRIORITIES = ['LOW', 'LOW', 'MEDIUM', 'MEDIUM', 'MEDIUM', 'HIGH', 'HIGH', 'URGENT'] as const;
const STATUSES = [
  'OPEN',
  'OPEN',
  'OPEN',
  'IN_PROGRESS',
  'IN_PROGRESS',
  'BLOCKED',
  'DONE',
  'DONE',
  'CANCELED',
] as const;
const WORKFLOW_STATES = [
  'NOT_STARTED',
  'READY',
  'IN_PROGRESS',
  'IN_PROGRESS',
  'ON_HOLD',
  'NEEDS_REVIEW',
  'WITH_CLIENT',
  'COMPLETED',
  'CANCELED',
];
const LOCATIONS = ['VIDEO', 'VIDEO', 'PHONE', 'IN_PERSON'] as const;

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  const firmId = process.env['FIRM_ID'];
  if (!connectionString || !firmId) throw new Error('DATABASE_URL and FIRM_ID are required');
  const taskCount = parseInt(process.env['DEMO_TASKS'] ?? '140', 10);
  const apptCount = parseInt(process.env['DEMO_APPTS'] ?? '60', 10);

  const { db, close } = createDb({ connectionString });
  try {
    const clientRows = await db
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.firmId, firmId));
    const userRows = await db
      .select({ id: appUsers.id })
      .from(appUsers)
      .where(and(eq(appUsers.firmId, firmId), eq(appUsers.status, 'ACTIVE')));
    const typeRows = await db
      .select({ id: appointmentTypes.id, name: appointmentTypes.name })
      .from(appointmentTypes)
      .where(eq(appointmentTypes.firmId, firmId));
    if (clientRows.length === 0 || userRows.length === 0) {
      throw new Error('firm has no clients/users — run the demo seed first');
    }
    const clientIds = clientRows.map((c) => c.id);
    const userIds = userRows.map((u) => u.id);

    // 1) Spread engagement workflow_state across the Kanban columns.
    const wf = await db.execute(sql`
      UPDATE vibetb.engagement e
      SET workflow_state = (ARRAY['NOT_STARTED','READY','IN_PROGRESS','IN_PROGRESS','ON_HOLD','NEEDS_REVIEW','WITH_CLIENT','COMPLETED','CANCELED'])[(abs(hashtext(e.id::text)) % 9) + 1]
      WHERE e.client_id IN (SELECT id FROM vibetb.client WHERE firm_id = ${firmId})
    `);
    void WORKFLOW_STATES;

    // 2) client_task — clear prior demo tasks, then insert fresh.
    const priorTasks = await db
      .delete(clientTasks)
      .where(
        and(eq(clientTasks.firmId, firmId), sql`${clientTasks.description} LIKE ${`%${MARKER}%`}`),
      )
      .returning({ id: clientTasks.id });

    const now = new Date();
    const taskValues = Array.from({ length: taskCount }, () => {
      const r = Math.random();
      let dueDate: string | null;
      if (r < 0.25)
        dueDate = isoDate(addDays(now, -1 - Math.floor(Math.random() * 20))); // overdue
      else if (r < 0.75) dueDate = isoDate(addDays(now, 1 + Math.floor(Math.random() * 30)));
      else if (r < 0.9) dueDate = isoDate(addDays(now, 30 + Math.floor(Math.random() * 60)));
      else dueDate = null;
      const status = pick(STATUSES);
      return {
        firmId,
        clientId: pick(clientIds),
        assigneeUserId: pick(userIds),
        title: pick(TASK_TITLES),
        description: `Demo task ${MARKER}`,
        priority: pick(PRIORITIES),
        status,
        dueDate,
        completedAt: status === 'DONE' ? now : null,
        createdById: pick(userIds),
      };
    });
    for (let i = 0; i < taskValues.length; i += 100) {
      await db.insert(clientTasks).values(taskValues.slice(i, i + 100));
    }

    // 3) appointments — clear prior demo appts, then insert fresh.
    const priorAppts = await db
      .delete(appointments)
      .where(
        and(
          eq(appointments.firmId, firmId),
          sql`${appointments.internalNotes} LIKE ${`%${MARKER}%`}`,
        ),
      )
      .returning({ id: appointments.id });

    const apptValues = Array.from({ length: apptCount }, () => {
      const offsetDays = -30 + Math.floor(Math.random() * 75); // -30 .. +44
      const startHour = 8 + Math.floor(Math.random() * 9); // 8..16
      const starts = addDays(now, offsetDays);
      starts.setHours(startHour, 0, 0, 0);
      const durationMinutes = pick([30, 30, 60, 60, 90]);
      const ends = new Date(starts.getTime() + durationMinutes * 60_000);
      const past = starts.getTime() < now.getTime();
      const status = past
        ? Math.random() < 0.8
          ? 'COMPLETED'
          : 'CANCELLED'
        : Math.random() < 0.9
          ? 'SCHEDULED'
          : 'CANCELLED';
      const type = typeRows.length ? pick(typeRows) : null;
      return {
        firmId,
        clientId: pick(clientIds),
        title: type ? type.name : 'Client meeting',
        startsAt: starts,
        endsAt: ends,
        location: pick(LOCATIONS),
        leadAppUserId: pick(userIds),
        status: status as 'SCHEDULED' | 'COMPLETED' | 'CANCELLED',
        appointmentTypeId: type?.id ?? null,
        durationMinutes,
        internalNotes: `Demo appointment ${MARKER}`,
        createdById: pick(userIds),
      };
    });
    for (let i = 0; i < apptValues.length; i += 100) {
      await db.insert(appointments).values(apptValues.slice(i, i + 100));
    }

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          engagementsWorkflowUpdated: (wf as unknown as { count?: number }).count ?? 'ok',
          tasks: { cleared: priorTasks.length, inserted: taskValues.length },
          appointments: { cleared: priorAppts.length, inserted: apptValues.length },
        },
        null,
        2,
      ),
    );
  } finally {
    await close();
  }
}

void main().then(
  () => process.exit(0),
  (err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  },
);
