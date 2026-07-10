// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
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
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { magicLinks, proposalActivity, proposals, signatures } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { hydrateBrochureForPortal } from './portal-hydrate';
import { logger } from '../logger';

const DEFAULT_TTL_DAYS = 30;
const MAX_REDEEM_PER_IP_PER_HOUR = 10;
const TOKEN_BYTES = 32;

/**
 * Q34 — optional best-effort mail surface used to deliver per-signer
 * magic links. Wired in app.ts to the existing staff-mail provider when
 * available, else undefined. Mail failures never block the signing flow.
 */
export type SendProposalEmail = (args: {
  to: string;
  subject: string;
  body: string;
  html?: string;
}) => Promise<void>;

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
  // Q34 — optional best-effort per-signer mail delivery.
  sendProposalEmail?: SendProposalEmail;
}

const MintSchema = z.object({
  ttlDays: z.number().int().min(1).max(180).optional(),
  // Q34 — when set, the minted link is scoped to a single signer row
  // and the supersede filter only touches that signer's prior links.
  signatureId: z.string().uuid().optional(),
});

/**
 * Q34 — mint a magic link for a proposal (optionally scoped to one
 * signer) and supersede that signer's (or the proposal's) prior unused
 * links. Returns the raw token + URL. Caller owns audit + email.
 */
async function mintLink(
  db: Database,
  args: {
    firmId: string;
    clientId: string;
    proposalId: string;
    signatureId: string | null;
    ttlDays: number;
    createdById: string | null;
  },
): Promise<{ id: string; raw: string; url: string; expiresAt: Date }> {
  const { raw, hash } = generateToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + args.ttlDays * 24 * 60 * 60 * 1000);
  const [newRow] = await db
    .insert(magicLinks)
    .values({
      firmId: args.firmId,
      tokenHash: hash,
      purpose: 'PROPOSAL',
      clientId: args.clientId,
      proposalId: args.proposalId,
      signatureId: args.signatureId,
      expiresAt,
      createdById: args.createdById,
    })
    .returning({ id: magicLinks.id });
  if (!newRow) throw new Error('magic_link_insert_failed');
  // Supersede prior unused links. When scoped to a signer, only that
  // signer's links are superseded so resending to one signer never
  // invalidates the others.
  const scope = args.signatureId
    ? eq(magicLinks.signatureId, args.signatureId)
    : eq(magicLinks.proposalId, args.proposalId);
  await db
    .update(magicLinks)
    .set({ supersededAt: now, supersededById: newRow.id })
    .where(
      and(
        eq(magicLinks.firmId, args.firmId),
        scope,
        isNull(magicLinks.usedAt),
        isNull(magicLinks.supersededAt),
        ne(magicLinks.id, newRow.id),
      ),
    );
  return { id: newRow.id, raw, url: '', expiresAt };
}

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

      // Q34 — when scoped to a signer, validate the row belongs to this
      // proposal so a stray signatureId can't widen scope.
      const signatureId = parsed.data.signatureId ?? null;
      if (signatureId) {
        const [sig] = await deps.db
          .select({ id: signatures.id })
          .from(signatures)
          .where(and(eq(signatures.id, signatureId), eq(signatures.proposalId, proposal.id)))
          .limit(1);
        if (!sig) {
          res.status(404).json({ error: 'signer_not_found' });
          return;
        }
      }

      const ttlDays = parsed.data.ttlDays ?? DEFAULT_TTL_DAYS;
      const minted = await mintLink(deps.db, {
        firmId: session.firmId,
        clientId: proposal.clientId,
        proposalId: proposal.id,
        signatureId,
        ttlDays,
        createdById: session.appUserId,
      });

      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'magic_link',
        entityId: minted.id,
        actorAppUserId: session.appUserId,
        after: {
          proposalId: proposal.id,
          signatureId,
          expiresAt: minted.expiresAt.toISOString(),
        },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

      const url = `${deps.portalBaseUrl}/p/${minted.raw}`;
      res
        .status(201)
        .json({ id: minted.id, token: minted.raw, url, expiresAt: minted.expiresAt.toISOString() });
    },
  );

  // Q34 — mint links for the whole signer roster in one call. PARALLEL
  // mints a link for every PENDING required signer; SEQUENTIAL mints
  // only the lowest-sequence PENDING signer (the next gate). Each link
  // is auto-emailed best-effort. Returns the minted set so the staff UI
  // can copy/show links too.
  router.post(
    '/:id/mint-all-magic-links',
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

      const roster = await deps.db
        .select()
        .from(signatures)
        .where(eq(signatures.proposalId, proposal.id))
        .orderBy(asc(signatures.sequence));
      const pending = roster.filter((s) => s.state === 'PENDING' && s.required);
      if (pending.length === 0) {
        res.status(409).json({ error: 'no_pending_signers' });
        return;
      }
      const targets = proposal.signingOrderMode === 'SEQUENTIAL' ? [pending[0]!] : pending;

      const ttlDays = parsed.data.ttlDays ?? DEFAULT_TTL_DAYS;
      const out: Array<{ signatureId: string; signerEmail: string; url: string }> = [];
      for (const sig of targets) {
        const minted = await mintLink(deps.db, {
          firmId: session.firmId,
          clientId: proposal.clientId,
          proposalId: proposal.id,
          signatureId: sig.id,
          ttlDays,
          createdById: session.appUserId,
        });
        const url = `${deps.portalBaseUrl}/p/${minted.raw}`;
        out.push({ signatureId: sig.id, signerEmail: sig.signerEmail, url });
        await emitAudit(deps.db, {
          action: 'CREATE',
          entityType: 'magic_link',
          entityId: minted.id,
          actorAppUserId: session.appUserId,
          after: { proposalId: proposal.id, signatureId: sig.id },
          ip: req.ip ?? null,
          userAgent: req.get('user-agent') ?? null,
        }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
        if (deps.sendProposalEmail) {
          await deps
            .sendProposalEmail({
              to: sig.signerEmail,
              subject: `Please review and sign: ${proposal.title}`,
              body: `You have been asked to sign the proposal "${proposal.title}". Open this link to review and sign:\n\n${url}`,
              html: `<p>You have been asked to sign the proposal <strong>${proposal.title}</strong>.</p><p><a href="${url}">Review and sign</a></p>`,
            })
            .catch((err: unknown) =>
              logger.warn({ err, to: sig.signerEmail }, 'signer email failed'),
            );
        }
      }
      res.status(201).json({ links: out });
    },
  );

  // Q34 — replace/re-invite a signer (staff). Resets a DECLINED or
  // PENDING roster row back to PENDING with a new name/email/phone,
  // clears the declined fields, then re-mints + emails the link. Used to
  // recover from a declined required signer without killing the deal.
  const ReplaceSignerSchema = z.object({
    name: z.string().min(1).max(240),
    email: z.string().email().max(240),
    phone: z.string().max(40).nullable().optional(),
  });
  router.post(
    '/:id/signers/:signatureId/replace',
    requirePermission(deps, 'proposal:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = ReplaceSignerSchema.safeParse(req.body ?? {});
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
      const [sig] = await deps.db
        .select()
        .from(signatures)
        .where(
          and(
            eq(signatures.id, req.params['signatureId']!),
            eq(signatures.proposalId, proposal.id),
          ),
        )
        .limit(1);
      if (!sig) {
        res.status(404).json({ error: 'signer_not_found' });
        return;
      }
      if (sig.state === 'SIGNED') {
        res.status(409).json({ error: 'already_signed' });
        return;
      }
      await deps.db
        .update(signatures)
        .set({
          state: 'PENDING',
          method: null,
          signerName: parsed.data.name,
          signerEmail: parsed.data.email,
          signerPhone: parsed.data.phone ?? null,
          declinedAt: null,
          declinedReason: null,
          typedName: null,
          signatureSvg: null,
          signedAt: null,
          payloadHash: null,
          hmacSignature: null,
        })
        .where(eq(signatures.id, sig.id));

      const ttlDays = DEFAULT_TTL_DAYS;
      const minted = await mintLink(deps.db, {
        firmId: session.firmId,
        clientId: proposal.clientId,
        proposalId: proposal.id,
        signatureId: sig.id,
        ttlDays,
        createdById: session.appUserId,
      });
      const url = `${deps.portalBaseUrl}/p/${minted.raw}`;
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'signature.replaced',
        entityId: sig.id,
        actorAppUserId: session.appUserId,
        before: { signerEmail: sig.signerEmail, state: sig.state },
        after: { signerEmail: parsed.data.email, state: 'PENDING' },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      if (deps.sendProposalEmail) {
        await deps
          .sendProposalEmail({
            to: parsed.data.email,
            subject: `Please review and sign: ${proposal.title}`,
            body: `You have been asked to sign the proposal "${proposal.title}". Open this link to review and sign:\n\n${url}`,
            html: `<p>You have been asked to sign the proposal <strong>${proposal.title}</strong>.</p><p><a href="${url}">Review and sign</a></p>`,
          })
          .catch((err: unknown) =>
            logger.warn({ err, to: parsed.data.email }, 'replace signer email failed'),
          );
      }
      res.status(200).json({ ok: true, signatureId: sig.id, signerEmail: parsed.data.email, url });
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

    // Q34 — multi-signer: when the link is scoped to a roster row,
    // resolve this signer + the roster summary, and enforce per-signer
    // state and (for SEQUENTIAL) turn order before letting the portal in.
    let thisSigner: {
      id: string;
      name: string;
      email: string;
      role: string;
      sequence: number;
      state: string;
    } | null = null;
    let rosterSummary:
      | {
          signers: Array<{ name: string; role: string; state: string }>;
          signedCount: number;
          requiredCount: number;
          signingOrderMode: string;
        }
      | undefined;
    if (link.signatureId) {
      const roster = await deps.db
        .select()
        .from(signatures)
        .where(eq(signatures.proposalId, proposal.id))
        .orderBy(asc(signatures.sequence));
      const me = roster.find((s) => s.id === link.signatureId);
      if (!me) {
        res.status(404).json({ error: 'signer_not_found' });
        return;
      }
      if (me.state === 'SIGNED') {
        res.status(409).json({ error: 'already_signed' });
        return;
      }
      if (me.state === 'DECLINED') {
        res.status(409).json({ error: 'declined' });
        return;
      }
      if (proposal.signingOrderMode === 'SEQUENTIAL') {
        const earlierPending = roster.some(
          (s) => s.required && s.state === 'PENDING' && s.sequence < me.sequence,
        );
        if (earlierPending) {
          res.status(409).json({ error: 'not_your_turn' });
          return;
        }
      }
      thisSigner = {
        id: me.id,
        name: me.signerName,
        email: me.signerEmail,
        role: me.role,
        sequence: me.sequence,
        state: me.state,
      };
      rosterSummary = {
        signers: roster.map((s) => ({ name: s.signerName, role: s.role, state: s.state })),
        signedCount: roster.filter((s) => s.state === 'SIGNED').length,
        requiredCount: roster.filter((s) => s.required).length,
        signingOrderMode: proposal.signingOrderMode,
      };
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

    // Hydrate the brochure server-side so the portal renders the full block
    // set (service names/prices, package tiers, terms) without staff-API calls.
    const hydratedBrochure = await hydrateBrochureForPortal(deps.db, proposal).catch(
      () => proposal.brochureJsonb,
    );

    res.json({
      proposal: {
        id: proposal.id,
        title: proposal.title,
        status: proposal.status === 'SENT' ? 'VIEWED' : proposal.status,
        brochureJsonb: hydratedBrochure,
        totalOneTimeCents: Number(proposal.totalOneTimeCents),
        totalRecurringCents: Number(proposal.totalRecurringCents),
        recurringInterval: proposal.recurringInterval,
        sentAt: proposal.sentAt,
        expiresAt: proposal.expiresAt,
      },
      magicLinkId: link.id,
      ...(thisSigner ? { thisSigner } : {}),
      ...(rosterSummary ?? {}),
    });
  });

  return router;
}
