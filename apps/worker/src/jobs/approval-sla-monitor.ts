// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Approval SLA monitor (Phase 18 #13). Scans PENDING approval_requests
// whose due_at has passed and emits one audit_log row per request per
// scan window. Distinct from approval-escalation (which clears the
// approver to flow the request back to the unassigned pool after a
// longer threshold) — this is the earlier "your SLA is at risk" nudge.
//
// Suppressed 24h per request so a stuck approval doesn't spam the inbox.

import { and, eq, gte, isNotNull, isNull, lte } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { approvalRequests, auditLog } from '@vibe/db/schema';

import type { Logger } from 'pino';

const SUPPRESS_HOURS = 24;

export async function runApprovalSlaMonitor(
  db: Database,
  log: Logger,
  now = new Date(),
): Promise<{ scanned: number; alerted: number }> {
  const overdue = await db
    .select({
      id: approvalRequests.id,
      entityType: approvalRequests.entityType,
      entityId: approvalRequests.entityId,
      approverId: approvalRequests.approverId,
      requesterId: approvalRequests.requesterId,
      requestedAt: approvalRequests.requestedAt,
      dueAt: approvalRequests.dueAt,
    })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.status, 'PENDING'),
        isNotNull(approvalRequests.dueAt),
        lte(approvalRequests.dueAt, now),
      ),
    )
    .limit(500);

  if (overdue.length === 0) return { scanned: 0, alerted: 0 };

  const suppressCutoff = new Date(now.getTime() - SUPPRESS_HOURS * 3600_000);
  let alerted = 0;

  for (const r of overdue) {
    const [existing] = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, 'approval_sla_breach'),
          eq(auditLog.entityId, r.id),
          gte(auditLog.occurredAt, suppressCutoff),
        ),
      )
      .limit(1);
    if (existing) continue;

    const ageMs = now.getTime() - new Date(r.requestedAt).getTime();
    const dueMs = r.dueAt ? now.getTime() - new Date(r.dueAt).getTime() : 0;

    await db.insert(auditLog).values({
      action: 'CREATE',
      entityType: 'approval_sla_breach',
      entityId: r.id,
      actorMcpTokenId: 'approval-sla-worker',
      afterJson: {
        approvalRequestId: r.id,
        entityType: r.entityType,
        entityId: r.entityId,
        approverId: r.approverId,
        requesterId: r.requesterId,
        requestedAt: r.requestedAt,
        dueAt: r.dueAt,
        ageHours: Math.round(ageMs / 3600_000),
        overdueByHours: Math.round(dueMs / 3600_000),
      },
    });
    alerted++;
    log.warn(
      {
        approvalRequestId: r.id,
        entityType: r.entityType,
        overdueByHours: Math.round(dueMs / 3600_000),
      },
      'approval SLA breach',
    );
  }

  return { scanned: overdue.length, alerted };
}

// Tame unused-import lint warnings — these are used in future filters.
void isNull;
