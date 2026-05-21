// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Engagement letter endpoints (Phase 8 #17, Phase 23 #28). Versioned per
// engagement. The DRAFT->SENT->ACCEPTED lifecycle gives the firm a single
// source of truth for "the client agreed to these terms on this date."

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clients, engagementLetters, engagements } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { getBillingContact } from '../clients/billing-contact';
import { recordOutbound } from '../clients/communications';
import { logger } from '../logger';

export interface EngagementLetterDeps extends RbacDeps {
  db: Database | null;
  sendEmail?: (args: { to: string; subject: string; body: string }) => Promise<void>;
  portalBaseUrl?: string;
}

const CreateSchema = z.object({
  engagementId: z.string().uuid(),
  bodyHtml: z.string().min(1).max(200_000),
});

export function createEngagementLetterRouter(deps: EngagementLetterDeps): Router {
  const router = express.Router();

  router.get(
    '/',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const status = typeof req.query['status'] === 'string' ? req.query['status'] : null;
      const allowed = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'VOIDED'];
      const firmEngs = await deps.db
        .select({ id: engagements.id })
        .from(engagements)
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(eq(clients.firmId, session.firmId));
      const engIds = firmEngs.map((e) => e.id);
      if (engIds.length === 0) {
        res.json({ items: [] });
        return;
      }
      const { inArray: ina } = await import('drizzle-orm');
      const conds = [ina(engagementLetters.engagementId, engIds)];
      if (status && allowed.includes(status)) {
        conds.push(eq(engagementLetters.status, status));
      }
      const items = await deps.db
        .select()
        .from(engagementLetters)
        .where(and(...conds))
        .orderBy(desc(engagementLetters.createdAt))
        .limit(500);
      res.json({ items });
    },
  );

  router.get(
    '/by-engagement/:engagementId',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      if (!(await engagementInFirm(deps.db, session.firmId, req.params['engagementId']!))) {
        res.status(404).json({ error: 'engagement_not_found' });
        return;
      }
      const items = await deps.db
        .select({
          id: engagementLetters.id,
          version: engagementLetters.version,
          status: engagementLetters.status,
          sentAt: engagementLetters.sentAt,
          sentToEmail: engagementLetters.sentToEmail,
          acceptedAt: engagementLetters.acceptedAt,
          createdAt: engagementLetters.createdAt,
        })
        .from(engagementLetters)
        .where(eq(engagementLetters.engagementId, req.params['engagementId']!))
        .orderBy(desc(engagementLetters.version));
      res.json({ items });
    },
  );

  router.post(
    '/',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      if (!(await engagementInFirm(deps.db, session.firmId, parsed.data.engagementId))) {
        res.status(404).json({ error: 'engagement_not_found' });
        return;
      }
      const [maxV] = await deps.db
        .select({ v: sql<number>`COALESCE(MAX(${engagementLetters.version}), 0)` })
        .from(engagementLetters)
        .where(eq(engagementLetters.engagementId, parsed.data.engagementId));
      const version = Number(maxV?.v ?? 0) + 1;
      const [row] = await deps.db
        .insert(engagementLetters)
        .values({
          engagementId: parsed.data.engagementId,
          version,
          status: 'DRAFT',
          bodyHtml: parsed.data.bodyHtml,
          createdById: session.appUserId,
        })
        .returning({ id: engagementLetters.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'engagement_letter',
        entityId: row?.id,
        actorAppUserId: session.appUserId,
        after: { engagementId: parsed.data.engagementId, version },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ id: row?.id, version });
    },
  );

  router.get(
    '/:id',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ letter: null });
        return;
      }
      const letter = await letterForFirm(deps.db, session.firmId, req.params['id']!);
      if (!letter) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ letter });
    },
  );

  router.post(
    '/:id/send',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const letter = await letterForFirm(deps.db, session.firmId, req.params['id']!);
      if (!letter) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (letter.status !== 'DRAFT') {
        res.status(409).json({ error: 'not_draft', status: letter.status });
        return;
      }
      const [eng] = await deps.db
        .select({ clientId: engagements.clientId })
        .from(engagements)
        .where(eq(engagements.id, letter.engagementId))
        .limit(1);
      // v2 0027 — billing email lives on client_contact (isBilling=true).
      const billingContact = eng ? await getBillingContact(deps.db, eng.clientId) : null;
      const to =
        typeof req.body?.to === 'string' ? req.body.to : (billingContact?.email ?? undefined);
      if (!to) {
        res.status(400).json({ error: 'to_address_required' });
        return;
      }
      if (deps.sendEmail) {
        const link = deps.portalBaseUrl ? `${deps.portalBaseUrl}/letters/${letter.id}` : '';
        const subject = `Engagement letter (v${letter.version}) — ${billingContact?.fullName ?? ''}`;
        const body =
          `Please review and accept the engagement letter.\n\n` +
          (link ? `View online: ${link}\n\n` : '') +
          `Thank you.`;
        await deps
          .sendEmail({ to, subject, body })
          .catch((err: unknown) => logger.error({ err }, 'engagement letter send failed'));
        if (eng) {
          await recordOutbound({
            db: deps.db,
            firmId: session.firmId,
            clientId: eng.clientId,
            channel: 'EMAIL',
            subject,
            body,
            relatedEntityType: 'engagement_letter',
            relatedEntityId: letter.id,
          }).catch((err) => logger.warn({ err }, 'comms record failed'));
        }
      }
      await deps.db
        .update(engagementLetters)
        .set({ status: 'SENT', sentAt: new Date(), sentToEmail: to })
        .where(eq(engagementLetters.id, letter.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'engagement_letter',
        entityId: letter.id,
        actorAppUserId: session.appUserId,
        after: { status: 'SENT', sentTo: to },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/accept',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const letter = await letterForFirm(deps.db, session.firmId, req.params['id']!);
      if (!letter) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (letter.status !== 'SENT') {
        res.status(409).json({ error: 'not_sent', status: letter.status });
        return;
      }
      await deps.db
        .update(engagementLetters)
        .set({ status: 'ACCEPTED', acceptedAt: new Date(), acceptedIp: clientIp(req) })
        .where(eq(engagementLetters.id, letter.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'engagement_letter',
        entityId: letter.id,
        actorAppUserId: session.appUserId,
        after: { status: 'ACCEPTED' },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/void',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const letter = await letterForFirm(deps.db, session.firmId, req.params['id']!);
      if (!letter) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 400) : null;
      await deps.db
        .update(engagementLetters)
        .set({ status: 'VOIDED', voidedAt: new Date(), voidedReason: reason })
        .where(eq(engagementLetters.id, letter.id));
      res.json({ ok: true });
    },
  );

  // Unused asc import — silence warning.
  void asc;

  router.get(
    '/:id/render.html',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const letter = await letterForFirm(deps.db, session.firmId, req.params['id']!);
      if (!letter) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const html = `<!doctype html>
<html><head><meta charset="utf-8"/><title>Engagement letter v${letter.version}</title>
<style>
  body { font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: #111; margin: 48px; max-width: 720px; }
  h1, h2 { color: #111; }
  .meta { font-size: 11px; color: #666; margin-bottom: 24px; }
  .footer { margin-top: 48px; font-size: 11px; color: #666; }
</style></head>
<body>
  <div class="meta">Engagement letter · version ${letter.version} · status ${letter.status}</div>
  ${letter.bodyHtml}
  <div class="footer">${letter.acceptedAt ? `Accepted ${new Date(letter.acceptedAt).toISOString().slice(0, 10)} from ${letter.acceptedIp ?? 'unknown IP'}` : 'Not yet accepted.'}</div>
</body></html>`;
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    },
  );

  return router;
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

async function letterForFirm(
  db: Database,
  firmId: string,
  letterId: string,
): Promise<typeof engagementLetters.$inferSelect | null> {
  const [letter] = await db
    .select()
    .from(engagementLetters)
    .where(eq(engagementLetters.id, letterId))
    .limit(1);
  if (!letter) return null;
  if (!(await engagementInFirm(db, firmId, letter.engagementId))) return null;
  return letter;
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}
