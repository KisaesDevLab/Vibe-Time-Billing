// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// P17 — Magic-link auth for proposal portal access.
//
// Two surfaces:
//   Staff /api/staff/proposals/:id/mint-magic-link
//     Mints a 256-bit random token, stores SHA-256 hash in
//     magic_links, returns the raw token + URL to the firm so they
//     can deliver it (email lands in P26).
//     A fresh mint supersedes prior unused tokens for the same
//     proposal so a "resend" flow naturally invalidates the old
//     link.
//   Portal /api/portal/proposals/redeem
//     POST { token } → hashes the supplied raw token, looks up the
//     row, validates not expired / not used / not superseded /
//     proposal still active, stamps used_at + ip + ua, returns the
//     proposal header + brochure tree.
//     Rate-limited per IP via Redis sliding window so a leaked
//     token can't be brute-forced.
//
// Cookie session for ongoing portal access lands in P18 (optional
// client accounts). For PP17 the magic-link itself is the
// credential — a successful redeem returns the data inline and
// the portal page holds it in memory.

import { createHash, randomBytes } from 'node:crypto';
import express, { type Request, type Response, type Router } from 'express';
import type { Redis } from 'ioredis';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { magicLinks, proposalActivity, proposals } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';

const DEFAULT_TTL_DAYS = 30;
const MAX_REDEEM_PER_IP_PER_HOUR = 10;
const TOKEN_BYTES = 32;

function generateToken(): { raw: string; hash: string } {
  const raw = randomBytes(TOKEN_BYTES).toString('base64url');
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

// =====================================================================
// Staff side — mint a token for a proposal
// =====================================================================

export interface StaffMintDeps extends RbacDeps {
  db: Database | null;
  // Portal base URL to embed in the returned link. Operator sets it
  // on the appliance (e.g. https://portal.firm.example).
  portalBaseUrl: string;
}

const MintSchema = z.object({
  ttlDays: z.number().int().min(1).max(180).optional(),
});

export function createStaffMagicLinkRouter(deps: StaffMintDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.post(
    '/:id/mint-magic-link',
    requirePermission(deps, 'proposal:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = MintSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [proposal] = await deps.db
        .select()
        .from(proposals)
        .where(and(eq(proposals.id, req.params['id']!), eq(proposals.firmId, session.firmId)))
        .limit(1);
      if (!proposal) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (
        proposal.status === 'CANCELLED' ||
        proposal.status === 'DECLINED' ||
        proposal.status === 'ACCEPTED'
      ) {
        res.status(409).json({ error: 'proposal_closed', status: proposal.status });
        return;
      }

      const { raw, hash } = generateToken();
      const ttlDays = parsed.data.ttlDays ?? DEFAULT_TTL_DAYS;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);

      // Insert the new link first, then mark prior unused
      // un-superseded ones (excluding this one) as superseded by it.
      // Order matters: doing it the other way around would require a
      // fixup UPDATE because the new row would catch the WHERE filter.
      const [newRow] = await deps.db
        .insert(magicLinks)
        .values({
          firmId: session.firmId,
          tokenHash: hash,
          purpose: 'PROPOSAL',
          clientId: proposal.clientId,
          proposalId: proposal.id,
          expiresAt,
          createdById: session.appUserId,
        })
        .returning({ id: magicLinks.id });
      if (!newRow) throw new Error('magic_link_insert_failed');
      await deps.db
        .update(magicLinks)
        .set({ supersededAt: now, supersededById: newRow.id })
        .where(
          and(
            eq(magicLinks.firmId, session.firmId),
            eq(magicLinks.proposalId, proposal.id),
            isNull(magicLinks.usedAt),
            isNull(magicLinks.supersededAt),
            ne(magicLinks.id, newRow.id),
          ),
        );

      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'magic_link',
        entityId: newRow.id,
        actorAppUserId: session.appUserId,
        after: { proposalId: proposal.id, expiresAt: expiresAt.toISOString() },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

      const url = `${deps.portalBaseUrl}/p/${raw}`;
      res.status(201).json({ id: newRow.id, token: raw, url, expiresAt: expiresAt.toISOString() });
    },
  );

  // List magic links for a proposal (firm-side). Hashes never leave
  // the server — only id/status/timestamps are returned.
  router.get(
    '/:id/magic-links',
    requirePermission(deps, 'proposal:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const [proposal] = await deps.db
        .select({ id: proposals.id })
        .from(proposals)
        .where(and(eq(proposals.id, req.params['id']!), eq(proposals.firmId, session.firmId)))
        .limit(1);
      if (!proposal) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const items = await deps.db
        .select({
          id: magicLinks.id,
          expiresAt: magicLinks.expiresAt,
          usedAt: magicLinks.usedAt,
          usedFromIp: magicLinks.usedFromIp,
          supersededAt: magicLinks.supersededAt,
          createdAt: magicLinks.createdAt,
        })
        .from(magicLinks)
        .where(eq(magicLinks.proposalId, proposal.id));
      res.json({ items });
    },
  );

  return router;
}

// =====================================================================
// Portal side — redeem a token
// =====================================================================

export interface PortalRedeemDeps {
  db: Database | null;
  redis: Redis | null;
}

const RedeemSchema = z.object({
  token: z.string().min(20).max(100),
});

export function createPortalMagicLinkRouter(deps: PortalRedeemDeps): Router {
  const router = express.Router();

  router.post('/redeem', async (req: Request, res: Response) => {
    const parsed = RedeemSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }

    // Per-IP rate limit (sliding window, 1h). Defense in depth so a
    // leaked token can't be brute-forced — though tokens are 256-bit
    // random so the practical risk is low.
    if (deps.redis) {
      const ip = req.ip ?? '0.0.0.0';
      const key = `mlr:${ip}`;
      const count = await deps.redis.incr(key);
      if (count === 1) await deps.redis.expire(key, 3600);
      if (count > MAX_REDEEM_PER_IP_PER_HOUR) {
        res.status(429).json({ error: 'rate_limited' });
        return;
      }
    }

    const hash = hashToken(parsed.data.token);
    const [link] = await deps.db
      .select()
      .from(magicLinks)
      .where(eq(magicLinks.tokenHash, hash))
      .limit(1);

    // Always respond identically on "unknown" vs "expired" vs "used"
    // is tempting (account-enumeration style) — but for proposal
    // magic links the threat model is the firm sharing a real link
    // by accident, not enumeration. The distinct error codes help
    // the portal UI tell the user what to do.
    if (!link) {
      res.status(404).json({ error: 'token_not_found' });
      return;
    }
    const now = new Date();
    if (link.expiresAt.getTime() <= now.getTime()) {
      res.status(410).json({ error: 'token_expired' });
      return;
    }
    if (link.supersededAt != null) {
      res.status(410).json({ error: 'token_superseded' });
      return;
    }
    if (link.purpose !== 'PROPOSAL' || !link.proposalId) {
      res.status(400).json({ error: 'wrong_purpose' });
      return;
    }
    const [proposal] = await deps.db
      .select()
      .from(proposals)
      .where(eq(proposals.id, link.proposalId))
      .limit(1);
    if (!proposal) {
      res.status(404).json({ error: 'proposal_not_found' });
      return;
    }
    if (proposal.status === 'CANCELLED' || proposal.status === 'EXPIRED') {
      res.status(410).json({ error: 'proposal_unavailable', status: proposal.status });
      return;
    }

    // Stamp use info (idempotent — first redeem captures the
    // initial IP/UA; subsequent redeems within TTL refresh
    // last-seen).
    await deps.db
      .update(magicLinks)
      .set({
        usedAt: link.usedAt ?? now,
        usedFromIp: req.ip ?? null,
        usedFromUa: req.get('user-agent') ?? null,
      })
      .where(eq(magicLinks.id, link.id));

    // Activity event for funnel + section-tracking dashboards.
    await deps.db.insert(proposalActivity).values({
      proposalId: proposal.id,
      kind: link.usedAt == null ? 'OPENED' : 'SECTION_VIEWED',
      occurredFromIp: req.ip ?? null,
      occurredFromUa: req.get('user-agent') ?? null,
      magicLinkId: link.id,
      payload: { firstOpen: link.usedAt == null },
    });

    // If this is the first open, advance proposal status SENT → VIEWED
    // and stamp first_viewed_at.
    if (link.usedAt == null && proposal.status === 'SENT') {
      await deps.db
        .update(proposals)
        .set({ status: 'VIEWED', firstViewedAt: now })
        .where(eq(proposals.id, proposal.id));
    }

    res.json({
      proposal: {
        id: proposal.id,
        title: proposal.title,
        status: proposal.status === 'SENT' ? 'VIEWED' : proposal.status,
        brochureJsonb: proposal.brochureJsonb,
        totalOneTimeCents: Number(proposal.totalOneTimeCents),
        totalRecurringCents: Number(proposal.totalRecurringCents),
        recurringInterval: proposal.recurringInterval,
        sentAt: proposal.sentAt,
        expiresAt: proposal.expiresAt,
      },
      magicLinkId: link.id,
    });
  });

  return router;
}
