// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// TR-7 — 3rd-party share recipient page (public internet surface).
//
// Routes (all unauthenticated; the share token IS the credential):
//   GET  /shared/tax/:token            — resolve + return meta
//                                        (sections + display info)
//   POST /shared/tax/:token/2fa/verify — submit a 6-digit OTP. For
//                                        verify_channel='NONE' (2FA
//                                        opted out) any code passes; the
//                                        SMS/EMAIL dispatcher is not yet
//                                        wired, so those channels 503.
//   GET  /shared/tax/:token/pdf        — derived, watermarked PDF bytes
//                                        (blocked for require_2fa shares
//                                        until the dispatcher is wired)
//
// Authorization is re-derived on every request: resolveShareToken joins
// the parent release, so revoking the release (or the share) immediately
// kills the link. The token comparison is argon2 verify (constant-time)
// in share-helper — we never compare tokens lexically, and never log the
// token.
//
// NOT YET WIRED (ops/follow-up): per-IP rate limiting on this surface,
// and the 2FA code dispatcher/cookie. Brute-forcing a token is bounded
// by the argon2 verify cost + the 40+ char high-entropy secret, but a
// dedicated limiter is still wanted before this is internet-facing at
// scale.

import express, { type Request, type Response, type Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { files, taxReturns, taxReturnSections } from '@vibe/db/schema';
import { planExtraction, type SectionPageRange } from '@vibe/core/tax-returns';
import { buildStorageClient, type StorageClient } from '@vibe/storage';

import { logger } from '../logger';
import {
  bumpFailed2fa,
  markShareViewed,
  resolveShareToken,
  ShareError,
} from '../tax-returns/share-helper';
import { appendAccessLog } from '../tax-returns/access-log';
import { renderScopedReturnPdf, RenderError } from '../tax-returns/render';

export interface ShareRecipientDeps {
  db: Database | null;
  // Tests inject a fake; production resolves lazily per-request (B2
  // creds land in process.env after boot). /pdf renders the scoped,
  // watermarked subset; with no storage it falls closed to 503.
  storage?: StorageClient | null;
}

function resolveStorage(deps: ShareRecipientDeps): StorageClient | null {
  if (deps.storage) return deps.storage;
  try {
    return buildStorageClient(process.env);
  } catch {
    return null;
  }
}

const VerifyBody = z.object({
  code: z.string().regex(/^\d{6}$/),
});

// Generic recipient-facing error response. We use the SAME shape and
// status (404) for every failure case the recipient could probe —
// unknown token, expired, revoked, malformed — so an attacker can't
// distinguish causes. The actual failure code is logged server-side.
function notFound(res: Response): void {
  res.status(404).json({ error: 'not_found' });
}

export function createShareRecipientRouter(deps: ShareRecipientDeps): Router {
  const router = express.Router();

  // Resolve + return meta. No 2FA gate yet — the meta endpoint reveals
  // the bare minimum so the recipient page can render the verification
  // prompt with channel hints.
  router.get('/:token', async (req: Request, res: Response) => {
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const token = req.params['token']!;
    let share;
    try {
      share = await resolveShareToken(deps.db, token);
    } catch (err) {
      if (err instanceof ShareError) {
        logger.info({ code: err.code }, 'recipient resolve failed');
        notFound(res);
        return;
      }
      throw err;
    }
    // Hint for the 2FA prompt — channel-shape only, never the full
    // identifier. Email → domain; phone → last 4.
    let channelHint: string | null = null;
    if (share.require2fa) {
      if (share.verifyChannel === 'EMAIL') {
        const at = share.recipientEmail.indexOf('@');
        channelHint = at >= 0 ? `… ${share.recipientEmail.slice(at)}` : null;
      } else if (share.verifyChannel === 'SMS' && share.recipientPhone) {
        channelHint = `… ${share.recipientPhone.slice(-4)}`;
      }
    }
    res.json({
      shareId: share.id,
      organization: share.organization,
      // For the page chrome — never the full recipient email.
      recipientEmailDomain: share.recipientEmail.replace(/^.+@/, '@'),
      requires2fa: share.require2fa,
      verifyChannel: share.verifyChannel,
      channelHint,
      accessLevel: share.accessLevel,
      watermark: share.watermark,
    });
  });

  // Submit a 6-digit code. Implementation note: in v1 we accept any
  // 6 digits when verify_channel='NONE' (i.e. firm explicitly opted
  // out of 2FA), and otherwise check against a Redis-stored code.
  // Since the Redis sender wiring is ops work, the route returns 503
  // for the SMS/EMAIL channels when no Redis is wired. The failure
  // counter still bumps on bad codes regardless.
  router.post('/:token/2fa/verify', async (req: Request, res: Response) => {
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = VerifyBody.safeParse(req.body);
    if (!parsed.success) {
      notFound(res);
      return;
    }
    const token = req.params['token']!;
    let share;
    try {
      share = await resolveShareToken(deps.db, token);
    } catch {
      notFound(res);
      return;
    }
    // NONE channel = no 2FA required. Always passes.
    if (share.verifyChannel === 'NONE' || !share.require2fa) {
      await markShareViewed(deps.db, share.id);
      await appendAccessLog({
        db: deps.db,
        returnId: share.returnId,
        event: '2FA_PASSED',
        actorKind: 'RECIPIENT',
        actorRef: share.id,
        actorIp: req.ip ?? null,
        actorUserAgent: req.get('user-agent') ?? null,
        shareId: share.id,
        metadata: { channel: 'NONE' },
      }).catch(() => undefined);
      res.json({ ok: true });
      return;
    }
    // Code verification is wired by ops to Redis. We surface a 503
    // for now — never silently pass. The failure counter still
    // increments to keep the lockout semantics honest.
    const bumped = await bumpFailed2fa(deps.db, share.id);
    await appendAccessLog({
      db: deps.db,
      returnId: share.returnId,
      event: '2FA_FAILED',
      actorKind: 'RECIPIENT',
      actorRef: share.id,
      actorIp: req.ip ?? null,
      actorUserAgent: req.get('user-agent') ?? null,
      shareId: share.id,
      metadata: { channel: share.verifyChannel, count: bumped.count },
    }).catch(() => undefined);
    if (bumped.revoked) {
      await appendAccessLog({
        db: deps.db,
        returnId: share.returnId,
        event: 'REVOKED',
        actorKind: 'SYSTEM',
        shareId: share.id,
        metadata: { reason: '2fa_lockout' },
      }).catch(() => undefined);
      res.status(403).json({ error: '2fa_locked' });
      return;
    }
    res.status(503).json({ error: '2fa_dispatcher_unavailable' });
  });

  // PDF endpoint — extraction plan only (renderer not wired yet, per
  // TR-2/P14). Source bytes are NEVER served.
  router.get('/:token/pdf', async (req: Request, res: Response) => {
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const token = req.params['token']!;
    let share;
    try {
      share = await resolveShareToken(deps.db, token);
    } catch {
      notFound(res);
      return;
    }
    // For shares with require_2fa, the recipient must have a valid
    // verification cookie. The cookie verification is wired in by ops
    // alongside the 2FA dispatcher; until then, the route requires
    // require_2fa=false to render.
    if (share.require2fa) {
      res.status(403).json({ error: '2fa_required' });
      return;
    }
    const sections = await deps.db
      .select({
        id: taxReturnSections.id,
        ordinal: taxReturnSections.ordinal,
        startPage: taxReturnSections.startPage,
        endPage: taxReturnSections.endPage,
      })
      .from(taxReturnSections)
      .where(eq(taxReturnSections.returnId, share.returnId));
    const catalog: SectionPageRange[] = sections.map((s) => ({
      id: s.id,
      ordinal: s.ordinal,
      startPage: s.startPage,
      endPage: s.endPage,
    }));
    let plan;
    try {
      plan = planExtraction({
        returnId: share.returnId,
        anchorId: share.id,
        scope: share.scope,
        sectionIds: share.scope === 'FULL' ? [] : share.sectionIds,
        sectionCatalog: catalog,
        totalPages: sections.reduce((max, s) => Math.max(max, s.endPage), 0) || 1,
        watermark: {
          audience: 'RECIPIENT',
          timestamp: new Date().toISOString(),
          primary: share.recipientEmail,
          secondary: share.organization,
        },
      });
    } catch (err) {
      logger.warn({ err }, 'recipient plan failed');
      notFound(res);
      return;
    }
    // Resolve the source PDF for this return (skip deleted files).
    const [src] = await deps.db
      .select({ storageKey: files.storageKey, deletedAt: files.deletedAt })
      .from(taxReturns)
      .leftJoin(files, eq(files.id, taxReturns.sourceFileId))
      .where(eq(taxReturns.id, share.returnId))
      .limit(1);
    const sourceStorageKey = src && !src.deletedAt ? src.storageKey : null;

    // Fall closed when there's no renderer/source: never serve originals.
    // We deliberately do NOT mark-viewed or audit a VIEW here — nothing
    // was delivered, so a 503 must not inflate the view count the client
    // sees or the access history.
    const storage = resolveStorage(deps);
    if (!storage || !sourceStorageKey) {
      res.status(503).json({
        error: 'pdf_renderer_unavailable',
        pages: plan.pageIndices1Based.length,
        cacheKey: plan.cacheKey,
        watermark: plan.watermarkText,
      });
      return;
    }
    let pdf: Buffer;
    try {
      pdf = await renderScopedReturnPdf({
        storage,
        sourceStorageKey,
        pageIndices1Based: plan.pageIndices1Based,
        watermarkText: plan.watermarkText,
      });
    } catch (err) {
      const code = err instanceof RenderError ? err.code : 'render_failed';
      logger.warn({ err, returnId: share.returnId }, 'recipient tax-return render failed');
      res.status(502).json({ error: 'pdf_render_failed', detail: code });
      return;
    }
    // Record the view only once bytes are actually being delivered.
    await markShareViewed(deps.db, share.id);
    await appendAccessLog({
      db: deps.db,
      returnId: share.returnId,
      event: 'VIEW',
      actorKind: 'RECIPIENT',
      actorRef: share.id,
      actorIp: req.ip ?? null,
      actorUserAgent: req.get('user-agent') ?? null,
      shareId: share.id,
      metadata: { pages: plan.pageIndices1Based.length },
    }).catch(() => undefined);
    res.status(200);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="tax-return.pdf"');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(pdf);
  });

  return router;
}
