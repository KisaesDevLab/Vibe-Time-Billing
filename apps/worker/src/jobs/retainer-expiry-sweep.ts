// SPDX-License-Identifier: Elastic-2.0
//
// R4 — Daily retainer expiry sweep. Flips status from active/exhausted
// to expired when expiry_date < CURRENT_DATE. Hours forfeit per D4.

import { and, eq, lt, or, sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import { retainers } from '@vibe/db/schema';

export async function runRetainerExpirySweep(
  db: Database,
  log: Logger,
  now: Date = new Date(),
): Promise<{ expired: number }> {
  const today = now.toISOString().slice(0, 10);
  const updated = await db
    .update(retainers)
    .set({ status: 'expired', updatedAt: now })
    .where(
      and(
        or(eq(retainers.status, 'active'), eq(retainers.status, 'exhausted')),
        lt(retainers.expiryDate, today),
      ),
    )
    .returning({ id: retainers.id });
  if (updated.length > 0) {
    log.info({ count: updated.length }, 'retainer expiry sweep: expired retainers');
  }
  void sql;
  return { expired: updated.length };
}
