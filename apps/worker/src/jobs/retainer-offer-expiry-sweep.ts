// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// R4 — Daily offer expiry sweep. Flips status from 'pending' to
// 'expired' when offer_expires_at < now. pending_payment offers stay
// alone — they have a paid invoice in flight; let the AR flow finish.

import { and, eq, lt } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import { retainerOffers } from '@vibe/db/schema';

export async function runRetainerOfferExpirySweep(
  db: Database,
  log: Logger,
  now: Date = new Date(),
): Promise<{ expired: number }> {
  const updated = await db
    .update(retainerOffers)
    .set({ status: 'expired', updatedAt: now })
    .where(and(eq(retainerOffers.status, 'pending'), lt(retainerOffers.offerExpiresAt, now)))
    .returning({ id: retainerOffers.id });
  if (updated.length > 0) {
    log.info({ count: updated.length }, 'retainer offer expiry sweep: expired offers');
  }
  return { expired: updated.length };
}
