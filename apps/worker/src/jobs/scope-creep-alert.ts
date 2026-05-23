// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Scope-creep alert (Phase 19 #15, scope-creep variant of #16 detection).
// Scans mixed-mode engagements with out-of-scope time entries in the last
// 30 days. When the out-of-scope share of total hours exceeds the
// threshold (default 20%), records an audit event so the staff inbox can
// surface it. Suppressed if the same engagement was alerted in the last
// 7 days.

import { and, eq, gte, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { auditLog, clients, engagements, timeEntries } from '@vibe/db/schema';

import type { Logger } from 'pino';

const THRESHOLD_PCT = parseFloat(process.env['SCOPE_CREEP_THRESHOLD_PCT'] ?? '20');
const LOOKBACK_DAYS = 30;
const SUPPRESS_DAYS = 7;

export async function runScopeCreepAlert(
  db: Database,
  log: Logger,
  now = new Date(),
): Promise<{ scanned: number; alerted: number }> {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const rows = await db
    .select({
      engagementId: engagements.id,
      clientId: clients.id,
      firmId: clients.firmId,
      totalHours: sql<string>`COALESCE(SUM(${timeEntries.hours}), 0)`,
      outOfScopeHours: sql<string>`COALESCE(SUM(${timeEntries.hours}) FILTER (WHERE ${timeEntries.inScopeFlag} = false), 0)`,
    })
    .from(engagements)
    .innerJoin(clients, eq(clients.id, engagements.clientId))
    .leftJoin(
      timeEntries,
      and(eq(timeEntries.engagementId, engagements.id), gte(timeEntries.entryDate, since)),
    )
    .where(and(eq(engagements.status, 'ACTIVE'), eq(engagements.mixedModeEnabled, true)))
    .groupBy(engagements.id, clients.id, clients.firmId);

  let alerted = 0;
  const suppressCutoff = new Date(now.getTime() - SUPPRESS_DAYS * 86_400_000);
  for (const r of rows) {
    const total = Number(r.totalHours);
    const oos = Number(r.outOfScopeHours);
    if (total <= 0) continue;
    const pct = (oos / total) * 100;
    if (pct < THRESHOLD_PCT) continue;
    const [existing] = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, 'scope_creep_alert'),
          eq(auditLog.entityId, r.engagementId),
          gte(auditLog.occurredAt, suppressCutoff),
        ),
      )
      .limit(1);
    if (existing) continue;
    await db.insert(auditLog).values({
      action: 'CREATE',
      entityType: 'scope_creep_alert',
      entityId: r.engagementId,
      afterJson: {
        engagementId: r.engagementId,
        clientId: r.clientId,
        firmId: r.firmId,
        windowDays: LOOKBACK_DAYS,
        totalHours: total,
        outOfScopeHours: oos,
        creepPct: pct,
        threshold: THRESHOLD_PCT,
      },
    });
    alerted++;
    log.warn(
      { engagementId: r.engagementId, creepPct: pct.toFixed(1) },
      'scope creep threshold exceeded',
    );
  }
  return { scanned: rows.length, alerted };
}
