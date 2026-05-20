// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Hour-bank expiration worker (Phase 10 #17). For each hour_bank whose
// expiration_date has passed and which hasn't been forfeited yet, write
// a single EXPIRE transaction for the remaining balance and mark the
// bank forfeited.

import { and, eq, isNull, lte, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { hourBanks, hourBankTransactions } from '@vibe/db/schema';

import type { Logger } from 'pino';

export async function runHourBankExpiration(
  db: Database,
  log: Logger,
  today = new Date().toISOString().slice(0, 10),
): Promise<{ scanned: number; expired: number }> {
  const due = await db
    .select()
    .from(hourBanks)
    .where(
      and(
        isNull(hourBanks.forfeitedAt),
        sql`${hourBanks.expirationDate} IS NOT NULL`,
        lte(hourBanks.expirationDate, today),
      ),
    )
    .limit(500);
  if (due.length === 0) {
    return { scanned: 0, expired: 0 };
  }
  let expired = 0;
  for (const bank of due) {
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
        amountCents: sql<number>`COALESCE(SUM(${hourBankTransactions.amountCents}), 0)`,
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
    const balanceAmountCents =
      Number(bank.openingAmountCents) +
      Number(pur?.amountCents ?? 0) -
      Number(neg?.amountCents ?? 0);
    if (balanceHours <= 0 && balanceAmountCents <= 0) continue;
    await db.transaction(async (tx) => {
      await tx.insert(hourBankTransactions).values({
        hourBankId: bank.id,
        type: 'EXPIRE',
        hours: balanceHours.toFixed(2),
        amountCents: balanceAmountCents,
        sourceRefType: 'expiration',
        runningBalanceHours: '0.00',
        occurredAt: new Date(),
      });
      await tx
        .update(hourBanks)
        .set({
          forfeitedAt: new Date(),
          forfeitedAmountCents: balanceAmountCents,
        })
        .where(eq(hourBanks.id, bank.id));
    });
    expired++;
    log.info({ bankId: bank.id, hours: balanceHours }, 'hour bank expired');
  }
  return { scanned: due.length, expired };
}
