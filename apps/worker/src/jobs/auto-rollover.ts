// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Auto-rollover scanner (Phase 8 #22). Per QUESTIONS Q23, this job does
// NOT auto-create the new engagement — it surfaces engagements with
// `auto_rollover_enabled = true` whose endDate falls within the next 30
// days, so the partner can decide. Each candidate produces one audit_log
// row per scan window, used by the staff inbox to flag pending decisions.

import { and, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { auditLog, clients, engagements } from '@vibe/db/schema';

import type { Logger } from 'pino';

export async function runAutoRolloverScan(
  db: Database,
  log: Logger,
  now = new Date(),
): Promise<{ scanned: number; notified: number }> {
  const lookaheadDate = new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
  const todayDate = now.toISOString().slice(0, 10);
  const due = await db
    .select({
      id: engagements.id,
      clientId: engagements.clientId,
      partnerId: engagements.partnerId,
      endDate: engagements.endDate,
      autoRolloverPriceIncreasePct: engagements.autoRolloverPriceIncreasePct,
      firmId: clients.firmId,
    })
    .from(engagements)
    .innerJoin(clients, eq(clients.id, engagements.clientId))
    .where(
      and(
        eq(engagements.autoRolloverEnabled, true),
        eq(engagements.status, 'ACTIVE'),
        isNotNull(engagements.endDate),
        gte(engagements.endDate, todayDate),
        lte(engagements.endDate, lookaheadDate),
      ),
    )
    .limit(500);
  if (due.length === 0) {
    return { scanned: 0, notified: 0 };
  }
  // Suppress duplicates: skip engagements that already have an audit
  // entry tagged kind=rollover_due in the last 7 days.
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);
  let notified = 0;
  for (const eng of due) {
    const [existing] = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, 'engagement_rollover'),
          eq(auditLog.entityId, eng.id),
          sql`${auditLog.occurredAt} >= ${sevenDaysAgo}`,
        ),
      )
      .limit(1);
    if (existing) continue;
    await db.insert(auditLog).values({
      action: 'CREATE',
      entityType: 'engagement_rollover',
      entityId: eng.id,
      actorMcpTokenId: 'auto-rollover-worker',
      afterJson: {
        engagementId: eng.id,
        clientId: eng.clientId,
        partnerId: eng.partnerId,
        endDate: eng.endDate,
        priceIncreasePct: eng.autoRolloverPriceIncreasePct,
        firmId: eng.firmId,
      },
    });
    notified++;
    log.info({ engagementId: eng.id, partnerId: eng.partnerId }, 'auto-rollover candidate flagged');
  }
  return { scanned: due.length, notified };
}
