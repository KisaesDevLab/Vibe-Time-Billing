// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Prometheus-format gauges for the document-intake surface, folded into the
// API's /metrics endpoint. Best-effort; the caller swallows failures.

import { sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { intakeSessions } from '@vibe/db/schema';

export async function collectIntakeMetricsText(db: Database): Promise<string> {
  const rows = await db
    .select({ status: intakeSessions.status, n: sql<number>`count(*)::int` })
    .from(intakeSessions)
    .groupBy(intakeSessions.status);

  const byStatus = new Map<string, number>();
  for (const r of rows) byStatus.set(r.status, Number(r.n));
  const statuses = ['pending_scan', 'processing', 'received', 'disposed', 'rejected'];

  const lines: string[] = [];
  lines.push('# HELP vibe_intake_sessions Document-intake sessions by status.');
  lines.push('# TYPE vibe_intake_sessions gauge');
  for (const s of statuses) {
    lines.push(`vibe_intake_sessions{service="api",status="${s}"} ${byStatus.get(s) ?? 0}`);
  }
  return lines.join('\n');
}
