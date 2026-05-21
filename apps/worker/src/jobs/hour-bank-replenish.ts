// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Hour-bank auto-replenish worker (Phase 10 #15). For each hour_bank
// with auto_replenish_enabled=true whose running balance has fallen
// below auto_replenish_threshold_hours, write a PURCHASE transaction
// that tops the bank up to auto_replenish_target_hours. Rollover-cap
// (Phase 10 #18) clamps the post-replenish balance so we never breach
// the engagement's contractual ceiling.

import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { hourBanks, hourBankTransactions } from '@vibe/db/schema';

import type { Logger } from 'pino';

export async function runHourBankReplenish(
  db: Database,
  log: Logger,
): Promise<{ scanned: number; replenished: number }> {
  const candidates = await db
    .select()
    .from(hourBanks)
    .where(and(eq(hourBanks.autoReplenishEnabled, true), isNull(hourBanks.forfeitedAt)))
    .limit(500);
  if (candidates.length === 0) return { scanned: 0, replenished: 0 };

  let replenished = 0;
  for (const bank of candidates) {
    const threshold = Number(bank.autoReplenishThresholdHours ?? 0);
    const target = Number(bank.autoReplenishTargetHours ?? 0);
    if (target <= 0 || threshold <= 0) continue;

    const [pur] = await db
      .select({
        hours: sql<string>`COALESCE(SUM(${hourBankTransactions.hours}), 0)`,
        amountCents: sql<number>`COALESCE(SUM(${hourBankTransactions.amountCents}), 0)`,
      })
      .from(hourBankTransactions)
      .where(
        and(
          eq(hourBankTransactions.hourBankId, bank.id),
          eq(hourBankTransactions.type, 'PURCHASE'),
        ),
      );
    const [neg] = await db
      .select({
        hours: sql<string>`COALESCE(SUM(${hourBankTransactions.hours}), 0)`,
      })
      .from(hourBankTransactions)
      .where(
        and(
          eq(hourBankTransactions.hourBankId, bank.id),
          sql`${hourBankTransactions.type} IN ('DEBIT', 'EXPIRE', 'FORFEIT')`,
        ),
      );
    const balanceHours =
      Number(bank.openingHours) + Number(pur?.hours ?? 0) - Number(neg?.hours ?? 0);

    if (balanceHours >= threshold) continue;

    let topUpHours = target - balanceHours;
    // Phase 10 #18 — rollover-cap enforcement. If the cap is set, never
    // let post-replenish balance exceed it.
    const cap = bank.rolloverCapHours != null ? Number(bank.rolloverCapHours) : null;
    if (cap != null) {
      const capped = cap - balanceHours;
      if (capped <= 0) continue;
      if (topUpHours > capped) topUpHours = capped;
    }
    if (topUpHours <= 0) continue;

    // Cost per hour comes from the original opening rate.
    const openingHoursNum = Number(bank.openingHours);
    const ratePerHourCents =
      openingHoursNum > 0 ? Math.round(Number(bank.openingAmountCents) / openingHoursNum) : 0;
    const topUpAmountCents = Math.round(topUpHours * ratePerHourCents);

    await db.transaction(async (tx) => {
      await tx.insert(hourBankTransactions).values({
        hourBankId: bank.id,
        type: 'PURCHASE',
        hours: topUpHours.toFixed(2),
        amountCents: topUpAmountCents,
        sourceRefType: 'auto_replenish',
        runningBalanceHours: (balanceHours + topUpHours).toFixed(2),
        occurredAt: new Date(),
      });
      await tx
        .update(hourBanks)
        .set({ autoReplenishLastRunAt: new Date() })
        .where(eq(hourBanks.id, bank.id));
    });
    replenished++;
    log.info({ bankId: bank.id, topUpHours }, 'hour bank auto-replenished');
  }
  return { scanned: candidates.length, replenished };
}
