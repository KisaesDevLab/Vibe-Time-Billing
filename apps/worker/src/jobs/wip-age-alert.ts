// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// WIP age alert (Phase 11 #24). Scans engagements whose oldest unbilled
// time entry is older than threshold (default 45 days). Emits one
// audit_log row per engagement per scan window so the staff inbox can
// nudge the partner to pre-bill. Suppressed 7 days per engagement.

import { and, eq, gte, isNull, lte, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { auditLog, clients, engagements, timeEntries } from '@vibe/db/schema';

import type { Logger } from 'pino';

const AGE_THRESHOLD_DAYS = parseInt(process.env['WIP_AGE_THRESHOLD_DAYS'] ?? '45', 10) || 45;
const SUPPRESS_DAYS = 7;

export async function runWipAgeAlert(
  db: Database,
  log: Logger,
  now = new Date(),
): Promise<{ scanned: number; alerted: number }> {
  const cutoff = new Date(now.getTime() - AGE_THRESHOLD_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const rows = await db
    .select({
      engagementId: engagements.id,
      clientId: clients.id,
      firmId: clients.firmId,
      partnerId: engagements.partnerId,
      oldestDate: sql<string>`MIN(${timeEntries.entryDate})`,
      hours: sql<string>`COALESCE(SUM(${timeEntries.hours}), 0)`,
      amountCents: sql<number>`COALESCE(SUM(${timeEntries.standardAmountCents}), 0)`,
    })
    .from(timeEntries)
    .innerJoin(engagements, eq(engagements.id, timeEntries.engagementId))
    .innerJoin(clients, eq(clients.id, engagements.clientId))
    .where(and(isNull(timeEntries.billingBatchId), lte(timeEntries.entryDate, cutoff)))
    .groupBy(engagements.id, clients.id, clients.firmId, engagements.partnerId);

  const suppressCutoff = new Date(now.getTime() - SUPPRESS_DAYS * 86_400_000);
  let alerted = 0;
  for (const r of rows) {
    const [existing] = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, 'wip_age_alert'),
          eq(auditLog.entityId, r.engagementId),
          gte(auditLog.occurredAt, suppressCutoff),
        ),
      )
      .limit(1);
    if (existing) continue;
    await db.insert(auditLog).values({
      action: 'CREATE',
      entityType: 'wip_age_alert',
      entityId: r.engagementId,
      actorMcpTokenId: 'wip-age-worker',
      afterJson: {
        engagementId: r.engagementId,
        clientId: r.clientId,
        firmId: r.firmId,
        partnerId: r.partnerId,
        oldestEntryDate: r.oldestDate,
        thresholdDays: AGE_THRESHOLD_DAYS,
        unbilledHours: Number(r.hours),
        unbilledAmountCents: Number(r.amountCents),
      },
    });
    alerted++;
    log.warn({ engagementId: r.engagementId, oldestEntryDate: r.oldestDate }, 'WIP age alert');
  }
  return { scanned: rows.length, alerted };
}
