// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Hour-bank endpoints (Phase 10 #12-#18). Balance is computed as opening
// minus the sum of DEBIT/EXPIRE/FORFEIT transactions plus any PURCHASE
// top-ups. The ledger model means we never mutate hour_bank.opening — we
// always append a transaction row.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clients, engagements, hourBanks, hourBankTransactions } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';

export interface HourBankRoutesDeps extends RbacDeps {
  db: Database | null;
}

const TopUpSchema = z.object({
  hours: z.number().positive().max(10_000),
  amountCents: z.number().int().nonnegative(),
  note: z.string().max(400).optional(),
});

const DebitSchema = z.object({
  hours: z.number().positive().max(10_000),
  amountCents: z.number().int().nonnegative(),
  sourceRefType: z.string().max(40).optional(),
  sourceRefId: z.string().uuid().optional(),
  note: z.string().max(400).optional(),
});

export function createHourBankRouter(deps: HourBankRoutesDeps): Router {
  const router = express.Router();

  router.get(
    '/by-engagement/:engagementId',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ bank: null });
        return;
      }
      const ok = await engagementInFirm(deps.db, session.firmId, req.params['engagementId']!);
      if (!ok) {
        res.status(404).json({ error: 'engagement_not_found' });
        return;
      }
      const [bank] = await deps.db
        .select()
        .from(hourBanks)
        .where(eq(hourBanks.engagementId, req.params['engagementId']!))
        .limit(1);
      if (!bank) {
        res.json({ bank: null });
        return;
      }
      const balance = await computeBalance(
        deps.db,
        bank.id,
        Number(bank.openingHours),
        Number(bank.openingAmountCents),
      );
      res.json({ bank: { ...bank, ...balance } });
    },
  );

  router.get(
    '/:id/balance',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ balance: null });
        return;
      }
      const bank = await bankForFirm(deps.db, session.firmId, req.params['id']!);
      if (!bank) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const balance = await computeBalance(
        deps.db,
        bank.id,
        Number(bank.openingHours),
        Number(bank.openingAmountCents),
      );
      res.json({ balance });
    },
  );

  router.post(
    '/:id/top-up',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const parsed = TopUpSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const bank = await bankForFirm(deps.db, session.firmId, req.params['id']!);
      if (!bank) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const balance = await computeBalance(
        deps.db,
        bank.id,
        Number(bank.openingHours),
        Number(bank.openingAmountCents),
      );
      const newRunningHours = balance.balanceHours + parsed.data.hours;
      const [tx] = await deps.db
        .insert(hourBankTransactions)
        .values({
          hourBankId: bank.id,
          type: 'PURCHASE',
          hours: parsed.data.hours.toString(),
          amountCents: parsed.data.amountCents,
          sourceRefType: 'manual_top_up',
          runningBalanceHours: newRunningHours.toFixed(2),
          occurredAt: new Date(),
        })
        .returning({ id: hourBankTransactions.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'hour_bank_transaction',
        entityId: tx?.id,
        actorAppUserId: session.appUserId,
        after: {
          type: 'PURCHASE',
          hours: parsed.data.hours,
          amountCents: parsed.data.amountCents,
          bankId: bank.id,
          note: parsed.data.note,
        },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ ok: true, transactionId: tx?.id });
    },
  );

  router.post(
    '/:id/debit',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const parsed = DebitSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const bank = await bankForFirm(deps.db, session.firmId, req.params['id']!);
      if (!bank) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const balance = await computeBalance(
        deps.db,
        bank.id,
        Number(bank.openingHours),
        Number(bank.openingAmountCents),
      );
      if (parsed.data.hours > balance.balanceHours) {
        res.status(409).json({ error: 'insufficient_hours', availableHours: balance.balanceHours });
        return;
      }
      const newRunningHours = balance.balanceHours - parsed.data.hours;
      const [tx] = await deps.db
        .insert(hourBankTransactions)
        .values({
          hourBankId: bank.id,
          type: 'DEBIT',
          hours: parsed.data.hours.toString(),
          amountCents: parsed.data.amountCents,
          sourceRefType: parsed.data.sourceRefType ?? null,
          sourceRefId: parsed.data.sourceRefId ?? null,
          runningBalanceHours: newRunningHours.toFixed(2),
          occurredAt: new Date(),
        })
        .returning({ id: hourBankTransactions.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'hour_bank_transaction',
        entityId: tx?.id,
        actorAppUserId: session.appUserId,
        after: {
          type: 'DEBIT',
          hours: parsed.data.hours,
          amountCents: parsed.data.amountCents,
          bankId: bank.id,
        },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ ok: true, transactionId: tx?.id });
    },
  );

  router.post(
    '/:id/forfeit',
    requirePermission(deps, 'engagement:archive'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const bank = await bankForFirm(deps.db, session.firmId, req.params['id']!);
      if (!bank) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (bank.forfeitedAt) {
        res.status(409).json({ error: 'already_forfeited' });
        return;
      }
      const balance = await computeBalance(
        deps.db,
        bank.id,
        Number(bank.openingHours),
        Number(bank.openingAmountCents),
      );
      await deps.db.transaction(async (tx) => {
        await tx.insert(hourBankTransactions).values({
          hourBankId: bank.id,
          type: 'FORFEIT',
          hours: balance.balanceHours.toString(),
          amountCents: balance.balanceAmountCents,
          sourceRefType: 'engagement_close',
          runningBalanceHours: '0.00',
          occurredAt: new Date(),
        });
        await tx
          .update(hourBanks)
          .set({
            forfeitedAt: new Date(),
            forfeitedAmountCents: balance.balanceAmountCents,
          })
          .where(eq(hourBanks.id, bank.id));
      });
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'hour_bank',
        entityId: bank.id,
        actorAppUserId: session.appUserId,
        after: {
          forfeitedHours: balance.balanceHours,
          forfeitedAmountCents: balance.balanceAmountCents,
        },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, ...balance });
    },
  );

  return router;
}

async function bankForFirm(
  db: Database,
  firmId: string,
  bankId: string,
): Promise<typeof hourBanks.$inferSelect | null> {
  const [bank] = await db.select().from(hourBanks).where(eq(hourBanks.id, bankId)).limit(1);
  if (!bank) return null;
  const [scope] = await db
    .select({ id: engagements.id })
    .from(engagements)
    .innerJoin(clients, eq(clients.id, engagements.clientId))
    .where(and(eq(engagements.id, bank.engagementId), eq(clients.firmId, firmId)))
    .limit(1);
  if (!scope) return null;
  return bank;
}

async function engagementInFirm(
  db: Database,
  firmId: string,
  engagementId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: engagements.id })
    .from(engagements)
    .innerJoin(clients, eq(clients.id, engagements.clientId))
    .where(and(eq(engagements.id, engagementId), eq(clients.firmId, firmId)))
    .limit(1);
  return Boolean(row);
}

async function computeBalance(
  db: Database,
  bankId: string,
  openingHours: number,
  openingAmountCents: number,
): Promise<{ balanceHours: number; balanceAmountCents: number }> {
  const [pur] = await db
    .select({
      hours: sql<string>`COALESCE(SUM(${hourBankTransactions.hours}), 0)`.as('hours'),
      amountCents: sql<number>`COALESCE(SUM(${hourBankTransactions.amountCents}), 0)`.as(
        'amountCents',
      ),
    })
    .from(hourBankTransactions)
    .where(
      and(eq(hourBankTransactions.hourBankId, bankId), eq(hourBankTransactions.type, 'PURCHASE')),
    );
  const [neg] = await db
    .select({
      hours: sql<string>`COALESCE(SUM(${hourBankTransactions.hours}), 0)`.as('hours'),
      amountCents: sql<number>`COALESCE(SUM(${hourBankTransactions.amountCents}), 0)`.as(
        'amountCents',
      ),
    })
    .from(hourBankTransactions)
    .where(
      and(
        eq(hourBankTransactions.hourBankId, bankId),
        sql`${hourBankTransactions.type} IN ('DEBIT', 'EXPIRE', 'FORFEIT')`,
      ),
    );
  const balanceHours = openingHours + Number(pur?.hours ?? 0) - Number(neg?.hours ?? 0);
  const balanceAmountCents =
    openingAmountCents + Number(pur?.amountCents ?? 0) - Number(neg?.amountCents ?? 0);
  return { balanceHours, balanceAmountCents };
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}
