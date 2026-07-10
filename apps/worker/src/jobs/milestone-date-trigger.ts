// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Milestone date-trigger worker (Phase 10 #6-#7). For each PENDING
// milestone whose trigger_type=DATE and trigger_date has arrived, mark
// it TRIGGERED. Invoice creation is left to the staff /milestones/:id/trigger
// endpoint so we don't auto-bill without an explicit decision.

import { and, eq, lte, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { milestones } from '@vibe/db/schema';

import type { Logger } from 'pino';

export async function runMilestoneDateTrigger(
  db: Database,
  log: Logger,
  today = new Date().toISOString().slice(0, 10),
): Promise<{ scanned: number; triggered: number }> {
  const due = await db
    .select({ id: milestones.id, name: milestones.name })
    .from(milestones)
    .where(
      and(
        eq(milestones.status, 'PENDING'),
        eq(milestones.triggerType, 'DATE'),
        sql`${milestones.triggerDate} IS NOT NULL`,
        lte(milestones.triggerDate, today),
      ),
    )
    .limit(500);
  if (due.length === 0) {
    return { scanned: 0, triggered: 0 };
  }
  let triggered = 0;
  for (const m of due) {
    await db
      .update(milestones)
      .set({ status: 'TRIGGERED', triggeredAt: new Date() })
      .where(eq(milestones.id, m.id));
    triggered++;
    log.info({ milestoneId: m.id, name: m.name }, 'milestone date trigger fired');
  }
  return { scanned: due.length, triggered };
}
