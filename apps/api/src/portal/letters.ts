// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Portal-side engagement letter endpoints. Clients can list letters
// awaiting acceptance on their active client and accept them via the
// portal session. Acceptance records the portal identity id, IP, and
// timestamp into the audit-immutable engagement_letter row.

import express, { type Request, type Response, type Router } from 'express';
import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clientPortalAccess, engagementLetters, engagements, invoices } from '@vibe/db/schema';
import { sql } from 'drizzle-orm';

import { logger } from '../logger';

/**
 * Phase 13 #24, 14 #13, 16 #20 — pay-to-unlock client-side gate.
 * Returns true when the active client has any unpaid invoice flagged
 * `pay_to_unlock_attachments`. Engagement-letter render and any other
 * attachment download must call this and 402 when locked.
 */
async function isClientLocked(db: Database, clientId: string): Promise<boolean> {
  const [row] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(invoices)
    .where(
      and(
        eq(invoices.clientId, clientId),
        eq(invoices.payToUnlockAttachments, true),
        sql`${invoices.status} IN ('SENT', 'OVERDUE', 'PARTIALLY_PAID')`,
        sql`${invoices.totalCents} > ${invoices.paidCents}`,
      ),
    );
  return Number(row?.count ?? 0) > 0;
}

export interface PortalLetterDeps {
  db: Database | null;
  requireAuth: (req: Request, res: Response, next: () => void) => Promise<void> | void;
}

export function createPortalLetterRouter(deps: PortalLetterDeps): Router {
  const router = express.Router();

  router.get('/awaiting', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    if (!session.activeClientId) {
      res.status(400).json({ error: 'no_active_client' });
      return;
    }
    const [access] = await deps.db
      .select({ id: clientPortalAccess.id })
      .from(clientPortalAccess)
      .where(
        and(
          eq(clientPortalAccess.portalIdentityId, session.portalIdentityId),
          eq(clientPortalAccess.clientId, session.activeClientId),
          eq(clientPortalAccess.status, 'ACTIVE'),
        ),
      )
      .limit(1);
    if (!access) {
      res.status(403).json({ error: 'no_access' });
      return;
    }
    const rows = await deps.db
      .select({
        id: engagementLetters.id,
        version: engagementLetters.version,
        status: engagementLetters.status,
        sentAt: engagementLetters.sentAt,
        engagementId: engagementLetters.engagementId,
        engagementName: engagements.name,
      })
      .from(engagementLetters)
      .innerJoin(engagements, eq(engagements.id, engagementLetters.engagementId))
      .where(
        and(eq(engagements.clientId, session.activeClientId), eq(engagementLetters.status, 'SENT')),
      );
    res.json({ items: rows });
  });

  router.get('/:id/render.html', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const [letter] = await deps.db
      .select({
        id: engagementLetters.id,
        version: engagementLetters.version,
        status: engagementLetters.status,
        bodyHtml: engagementLetters.bodyHtml,
        engagementId: engagementLetters.engagementId,
        clientId: engagements.clientId,
      })
      .from(engagementLetters)
      .innerJoin(engagements, eq(engagements.id, engagementLetters.engagementId))
      .where(eq(engagementLetters.id, req.params['id']!))
      .limit(1);
    if (!letter || letter.clientId !== session.activeClientId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // Pay-to-unlock gate: refuse render when the client has any unpaid
    // pay-to-unlock invoice. The portal surfaces this on the Letters
    // page; the gate here defends against direct-URL bypass.
    if (await isClientLocked(deps.db, letter.clientId)) {
      res.status(402).json({ error: 'pay_to_unlock_locked' });
      return;
    }
    const html = `<!doctype html><html><head><meta charset="utf-8"/><title>Engagement letter v${letter.version}</title>
<style>body { font: 14px -apple-system, BlinkMacSystemFont, sans-serif; color: #111; margin: 32px; max-width: 720px; }</style>
</head><body>${letter.bodyHtml}</body></html>`;
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  });

  router.post('/:id/accept', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ ok: true });
      return;
    }
    const [letter] = await deps.db
      .select({
        id: engagementLetters.id,
        status: engagementLetters.status,
        engagementId: engagementLetters.engagementId,
        clientId: engagements.clientId,
      })
      .from(engagementLetters)
      .innerJoin(engagements, eq(engagements.id, engagementLetters.engagementId))
      .where(eq(engagementLetters.id, req.params['id']!))
      .limit(1);
    if (!letter || letter.clientId !== session.activeClientId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (letter.status !== 'SENT') {
      res.status(409).json({ error: 'not_sent', status: letter.status });
      return;
    }
    await deps.db
      .update(engagementLetters)
      .set({
        status: 'ACCEPTED',
        acceptedAt: new Date(),
        acceptedIp: req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? null,
      })
      .where(eq(engagementLetters.id, letter.id));
    logger.info(
      { letterId: letter.id, portalIdentityId: session.portalIdentityId },
      'engagement letter accepted via portal',
    );
    res.json({ ok: true });
  });

  return router;
}
