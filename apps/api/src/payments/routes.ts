// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Staff-side payment endpoints (Phase 14). Most payments arrive via the
// portal or the Stripe webhook; the staff surface here covers manual
// entry (e.g., a check that was mailed in) and auto-apply-to-oldest for
// a lump sum payment received against a client.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, asc, eq, inArray } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clients, invoices, payments } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';

export interface PaymentRoutesDeps extends RbacDeps {
  db: Database | null;
}

const AutoApplySchema = z.object({
  clientId: z.string().uuid(),
  amountCents: z.number().int().positive(),
  receivedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}/)
    .optional(),
  provider: z.enum(['STRIPE', 'CPACHARGE', 'MANUAL']).default('MANUAL'),
  reference: z.string().max(200).optional(),
});

export function createPaymentRouter(deps: PaymentRoutesDeps): Router {
  const router = express.Router();

  router.post(
    '/auto-apply',
    requirePermission(deps, 'payment:write'),
    async (req: Request, res: Response) => {
      const parsed = AutoApplySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true, applied: [] });
        return;
      }
      const [client] = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.id, parsed.data.clientId), eq(clients.firmId, session.firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }

      // Pull open invoices, oldest first.
      const open = await deps.db
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.firmId, session.firmId),
            eq(invoices.clientId, parsed.data.clientId),
            inArray(invoices.status, ['SENT', 'PARTIALLY_PAID', 'OVERDUE']),
          ),
        )
        .orderBy(asc(invoices.dueDate));

      let remaining = parsed.data.amountCents;
      const applied: { invoiceId: string; invoiceNumber: string; amountCents: number }[] = [];
      const receivedAt = parsed.data.receivedAt ? new Date(parsed.data.receivedAt) : new Date();

      await deps.db.transaction(async (tx) => {
        for (const inv of open) {
          if (remaining <= 0) break;
          const balance = Number(inv.totalCents) - Number(inv.paidCents);
          if (balance <= 0) continue;
          const apply = Math.min(remaining, balance);
          await tx.insert(payments).values({
            invoiceId: inv.id,
            amountCents: apply,
            feeCents: 0,
            provider: parsed.data.provider,
            providerChargeId: parsed.data.reference ?? null,
            status: 'SUCCEEDED',
            receivedAt,
          });
          const newPaid = Number(inv.paidCents) + apply;
          const newStatus = newPaid >= Number(inv.totalCents) ? 'PAID' : 'PARTIALLY_PAID';
          await tx
            .update(invoices)
            .set({
              paidCents: newPaid,
              status: newStatus,
              paidAt: newStatus === 'PAID' ? new Date() : null,
            })
            .where(eq(invoices.id, inv.id));
          applied.push({
            invoiceId: inv.id,
            invoiceNumber: inv.invoiceNumber,
            amountCents: apply,
          });
          remaining -= apply;
        }
      });

      await emitAudit(deps.db, {
        action: 'PAYMENT',
        entityType: 'client',
        entityId: parsed.data.clientId,
        actorAppUserId: session.appUserId,
        after: {
          kind: 'auto_apply',
          totalCents: parsed.data.amountCents,
          unappliedCents: remaining,
          appliedCount: applied.length,
          appliedInvoiceIds: applied.map((a) => a.invoiceId),
        },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

      res.json({
        ok: true,
        applied,
        unappliedCents: remaining,
      });
    },
  );

  return router;
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}
