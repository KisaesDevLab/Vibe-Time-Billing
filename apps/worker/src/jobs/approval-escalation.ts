// SPDX-License-Identifier: Elastic-2.0
//
// Approval auto-escalation (Phase 18 #7). For each PENDING approval_request
// whose requested_at is older than the rule's auto_escalate_hours, clear
// the approver_id so the request flows back into the unassigned pool.
// The rule lookup is best-effort by entity_type — full per-rule resolution
// is a future enhancement.

import { and, eq, isNotNull, lte, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { approvalRequests, approvalRules } from '@vibe/db/schema';

import type { Logger } from 'pino';

export async function runApprovalEscalation(
  db: Database,
  log: Logger,
  now = new Date(),
): Promise<{ scanned: number; escalated: number }> {
  // Default escalation: 24h if no rule.
  const stale = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.status, 'PENDING'),
        isNotNull(approvalRequests.approverId),
        lte(approvalRequests.requestedAt, new Date(now.getTime() - 24 * 3600 * 1000)),
      ),
    )
    .limit(500);
  if (stale.length === 0) {
    return { scanned: 0, escalated: 0 };
  }
  // Pull rules for the same entity types — pick the smallest auto_escalate.
  const types = Array.from(new Set(stale.map((r) => r.entityType)));
  const rules = types.length
    ? await db
        .select()
        .from(approvalRules)
        .where(sql`${approvalRules.entityType} = ANY(${types})`)
    : [];
  const escalateByType = new Map<string, number>();
  for (const r of rules) {
    if (r.autoEscalateHours == null) continue;
    const cur = escalateByType.get(r.entityType);
    if (cur == null || r.autoEscalateHours < cur) {
      escalateByType.set(r.entityType, r.autoEscalateHours);
    }
  }
  let escalated = 0;
  for (const req of stale) {
    const ruleHours = escalateByType.get(req.entityType) ?? 24;
    const ageMs = now.getTime() - new Date(req.requestedAt).getTime();
    if (ageMs < ruleHours * 3600 * 1000) continue;
    await db
      .update(approvalRequests)
      .set({ approverId: null })
      .where(eq(approvalRequests.id, req.id));
    escalated++;
    log.info(
      { requestId: req.id, entityType: req.entityType, ruleHours },
      'approval auto-escalated to unassigned pool',
    );
  }
  return { scanned: stale.length, escalated };
}
