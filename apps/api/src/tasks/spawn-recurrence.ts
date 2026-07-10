// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Recurring-task spawn helper. Shared by both task PATCH handlers (the
// firm-wide /tasks router and the per-client /clients/:id/tasks router) so the
// behaviour is identical no matter which surface marks a task DONE. When a task
// that carries a recurrence cadence transitions into DONE, this opens its
// successor: a clone of the task, OPEN, with the due date rolled forward one
// cadence step and the same recurrence so the chain continues.

import type { Database } from '@vibe/db';
import { clientTasks } from '@vibe/db/schema';
import { nextTaskDueDate, type TaskRecurrence } from '@vibe/core/tasks';

import { emitAudit } from '../auth/audit';

type TxOrDb = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

/** The just-completed task, with the fields carried forward to its successor. */
export interface RecurringTaskSource {
  id: string;
  firmId: string;
  clientId: string;
  engagementId: string | null;
  assigneeUserId: string | null;
  title: string;
  description: string | null;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  recurrence: TaskRecurrence;
  dueDate: string | null;
}

/**
 * Insert the next occurrence of a recurring task. The next due date advances
 * from the completed task's due date when it had one (keeps a fixed calendar
 * cadence), else from today. Returns the spawned row's id, or null if no DB.
 */
export async function spawnRecurringFollowUp(
  tx: TxOrDb,
  source: RecurringTaskSource,
  actorAppUserId: string,
  now: Date = new Date(),
): Promise<string | null> {
  const base = source.dueDate ?? now.toISOString().slice(0, 10);
  const nextDue = nextTaskDueDate(base, source.recurrence);

  const [row] = await tx
    .insert(clientTasks)
    .values({
      firmId: source.firmId,
      clientId: source.clientId,
      engagementId: source.engagementId,
      assigneeUserId: source.assigneeUserId,
      title: source.title,
      description: source.description,
      priority: source.priority,
      status: 'OPEN',
      dueDate: nextDue,
      recurrence: source.recurrence,
      createdById: actorAppUserId,
    })
    .returning({ id: clientTasks.id });

  await emitAudit(tx as Database, {
    action: 'CREATE',
    entityType: 'client_task',
    entityId: row?.id ?? null,
    actorAppUserId,
    after: {
      clientId: source.clientId,
      title: source.title,
      recurrence: source.recurrence,
      dueDate: nextDue,
      spawnedFromTaskId: source.id,
    },
  }).catch(() => undefined);

  return row?.id ?? null;
}
