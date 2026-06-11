// SPDX-License-Identifier: Elastic-2.0
//
// Audit anomaly detector (Phase 19 #15). Scans the last hour of
// audit_log rows and emits one alert per actor whose event count
// exceeds the threshold (default 80/hour). Suppressed 1 hour per actor
// to avoid storms. The alert itself goes back into audit_log as an
// entity of type `audit_anomaly_alert`.

import { and, count, eq, gte, isNotNull, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { auditLog } from '@vibe/db/schema';

import type { Logger } from 'pino';

const THRESHOLD = parseInt(process.env['AUDIT_ANOMALY_THRESHOLD'] ?? '80', 10) || 80;
const WINDOW_MIN = 60;

export async function runAuditAnomaly(
  db: Database,
  log: Logger,
  now = new Date(),
): Promise<{ scanned: number; alerted: number }> {
  const since = new Date(now.getTime() - WINDOW_MIN * 60_000);
  const suppressCutoff = new Date(now.getTime() - WINDOW_MIN * 60_000);

  // Staff actor rollup.
  const staffCounts = await db
    .select({
      actorId: auditLog.actorAppUserId,
      n: sql<number>`COUNT(*)`,
    })
    .from(auditLog)
    .where(and(isNotNull(auditLog.actorAppUserId), gte(auditLog.occurredAt, since)))
    .groupBy(auditLog.actorAppUserId);

  // Portal actor rollup.
  const portalCounts = await db
    .select({
      actorId: auditLog.actorPortalIdentityId,
      n: sql<number>`COUNT(*)`,
    })
    .from(auditLog)
    .where(and(isNotNull(auditLog.actorPortalIdentityId), gte(auditLog.occurredAt, since)))
    .groupBy(auditLog.actorPortalIdentityId);

  let alerted = 0;
  for (const { actorId, n, kind } of [
    ...staffCounts.map((r) => ({ ...r, kind: 'staff' as const })),
    ...portalCounts.map((r) => ({ ...r, kind: 'portal' as const })),
  ]) {
    const c = Number(n);
    if (c < THRESHOLD || !actorId) continue;
    const [existing] = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, 'audit_anomaly_alert'),
          eq(auditLog.entityId, actorId),
          gte(auditLog.occurredAt, suppressCutoff),
        ),
      )
      .limit(1);
    if (existing) continue;
    await db.insert(auditLog).values({
      action: 'CREATE',
      entityType: 'audit_anomaly_alert',
      entityId: actorId,
      afterJson: {
        actorKind: kind,
        actorId,
        eventsLastHour: c,
        threshold: THRESHOLD,
      },
    });
    alerted++;
    log.warn(
      { actorKind: kind, actorId, eventsLastHour: c },
      'audit anomaly: actor exceeded threshold',
    );
  }
  void count;
  return { scanned: staffCounts.length + portalCounts.length, alerted };
}
