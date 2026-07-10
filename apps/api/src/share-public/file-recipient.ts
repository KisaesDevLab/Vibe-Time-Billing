// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0150 — gated file-share recipient API (public internet surface),
// backing the portal landing page at /shared/file/:token.
//
// Routes (all unauthenticated; the share token IS the credential, and
// gated shares additionally require an access-code grant):
//   GET  /api/shared-file/:token/meta       — safe metadata for the page
//   POST /api/shared-file/:token/send-code  — email/SMS a 6-digit code
//   POST /api/shared-file/:token/verify     — exchange code for a grant
//                                             cookie (30 min)
//   GET  /api/shared-file/:token/content    — inline bytes / presign
//   GET  /api/shared-file/:token/download   — attachment (download-level
//                                             shares only)
//
// Enumeration posture: unknown/malformed tokens always get the same
// `404 {error:'not_found'}`; holders of a VALID token may learn the
// link is revoked/expired (friendly landing-page states). Codes and
// grants are never logged or echoed. Per-IP rate limits mirror the
// tax-recipient surface (fail OPEN on Redis errors — an infra hiccup
// must not take the public surface down).
//
// Grant cookie: `__vibe_fs_<shareIdNoDashes>` — HttpOnly, SameSite=
// Strict, Path=/api/shared-file, 30-min Max-Age. Path-scoping keeps it
// off the portal/staff realms (it is NOT a session in either; cross-
// realm isolation holds). DB-backed opaque value, sha256 at rest.

import express, { type Request, type Response, type Router, type NextFunction } from 'express';
import { parse as parseCookies, serialize as serializeCookie } from 'cookie';
import type { Redis } from 'ioredis';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { files } from '@vibe/db/schema';
import { buildStorageClient, type StorageClient } from '@vibe/storage';
import { checkAndIncrement } from '@vibe/core/auth';

import { logger } from '../logger';
import {
  fileShareFileIds,
  resolveFileShareToken,
  revokeFileShare,
  type ResolvedFileShare,
} from '../sharing/file-share-helper';
import {
  createOtpChallenge,
  verifyOtpChallenge,
  verifyGrant,
  maskEmail,
  maskPhone,
  GRANT_TTL_MS,
} from '../sharing/file-share-otp';
import { isPdf, logShareEvent, serveSharedFile } from '../sharing/serve-shared-file';
import { emitAudit } from '../auth/audit';
import { loadConfig } from '../config';

export interface FileRecipientDeps {
  db: Database | null;
  storage?: StorageClient | null;
  redis?: Redis;
  sendEmail?: (m: { to: string; subject: string; body: string }) => Promise<unknown>;
  sendSms?: (m: { to: string; body: string }) => Promise<unknown>;
}

function resolveStorage(deps: FileRecipientDeps): StorageClient | null {
  if (deps.storage) return deps.storage;
  try {
    return buildStorageClient(process.env);
  } catch {
    return null;
  }
}

function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0];
  return (first ?? req.ip ?? '0.0.0.0').trim();
}

const IP_WINDOW_SECONDS = 60;
const IP_MAX_PER_WINDOW = 60;
const SEND_MAX_PER_WINDOW = 10;
const VERIFY_MAX_PER_WINDOW = 20;
const CONTENT_MAX_PER_WINDOW = 20;

async function withinIpLimit(
  redis: Redis | undefined,
  req: Request,
  res: Response,
  scope: string,
  windowSeconds: number,
  max: number,
): Promise<boolean> {
  if (!redis) return true;
  try {
    const limit = await checkAndIncrement(redis, {
      key: `rl:shared-file:${scope}:${clientIp(req)}`,
      windowSeconds,
      max,
    });
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      res.status(429).json({ error: 'rate_limited' });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err }, 'file-recipient rate limiter error; allowing request');
    return true;
  }
}

const TOKEN_RE = /^[A-Za-z0-9._-]{20,400}$/;
const VerifyBody = z.object({ code: z.string().regex(/^\d{6}$/) });

function grantCookieName(shareId: string): string {
  return `__vibe_fs_${shareId.replace(/-/g, '')}`;
}

function readGrantCookie(req: Request, shareId: string): string | null {
  const header = req.headers['cookie'];
  if (!header) return null;
  return parseCookies(header)[grantCookieName(shareId)] ?? null;
}

function cookieSecure(): boolean {
  const cfg = loadConfig();
  const base = cfg.PORTAL_BASE_URL ?? cfg.APP_BASE_URL ?? '';
  return base.toLowerCase().startsWith('https://');
}

interface ResolvedContext {
  share: ResolvedFileShare;
  ip: string;
  userAgent: string | null;
}

export function createFileRecipientRouter(deps: FileRecipientDeps): Router {
  const router = express.Router();

  // Baseline limiter + no-store on everything.
  router.use(async (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!(await withinIpLimit(deps.redis, req, res, 'base', IP_WINDOW_SECONDS, IP_MAX_PER_WINDOW)))
      return;
    next();
  });

  // Shared resolve step: uniform 404 for unknown/malformed; 503 no db.
  async function resolve(req: Request, res: Response): Promise<ResolvedContext | null> {
    const token = req.params['token'] ?? '';
    const ip = clientIp(req);
    const userAgent = req.get('user-agent') ?? null;
    if (!TOKEN_RE.test(token)) {
      res.status(404).json({ error: 'not_found' });
      return null;
    }
    if (!deps.db) {
      res.status(503).json({ error: 'unavailable' });
      return null;
    }
    let share: ResolvedFileShare | null;
    try {
      share = await resolveFileShareToken(deps.db, token);
    } catch (err) {
      logger.error({ err }, 'file-recipient token resolve failed');
      res.status(500).json({ error: 'internal' });
      return null;
    }
    if (!share) {
      res.status(404).json({ error: 'not_found' });
      return null;
    }
    return { share, ip, userAgent };
  }

  type ShareState = 'ok' | 'revoked' | 'expired';
  function shareState(share: ResolvedFileShare, now = Date.now()): ShareState {
    if (share.revokedAt || share.status === 'REVOKED') return 'revoked';
    if (share.expiresAt && share.expiresAt.getTime() < now) return 'expired';
    return 'ok';
  }

  // The live (non-deleted) files behind a share — one for a single share,
  // many for a 0154 bundle.
  async function loadShareFiles(
    share: ResolvedFileShare,
  ): Promise<{ fileId: string; fileName: string; mimeType: string | null; isPdf: boolean }[]> {
    const db = deps.db!;
    const ids = await fileShareFileIds(db, share);
    if (ids.length === 0) return [];
    const rows = await db
      .select({
        id: files.id,
        originalFilename: files.originalFilename,
        mimeType: files.mimeType,
        deletedAt: files.deletedAt,
        pendingUpload: files.pendingUpload,
      })
      .from(files)
      .where(inArray(files.id, ids));
    return rows
      .filter((r) => r.deletedAt == null && !r.pendingUpload)
      .map((r) => ({
        fileId: r.id,
        fileName: r.originalFilename,
        mimeType: r.mimeType,
        isPdf: isPdf(r.mimeType, r.originalFilename),
      }));
  }

  // ----------------------------------------------------------------
  router.get('/:token/meta', async (req: Request, res: Response) => {
    const ctx = await resolve(req, res);
    if (!ctx) return;
    const db = deps.db!;
    const { share } = ctx;
    const state = shareState(share);
    if (state !== 'ok') {
      res.json({ state });
      return;
    }
    const shareFiles = await loadShareFiles(share);
    if (shareFiles.length === 0) {
      res.json({ state: 'revoked' });
      return;
    }
    const grant = readGrantCookie(req, share.id);
    const verified = !share.gated || (grant ? await verifyGrant(db, share.id, grant) : false);
    // Destination preview without creating a challenge (mask only).
    const channel = share.verifyChannel === 'SMS' && share.recipientPhone ? 'SMS' : 'EMAIL';
    const destination = channel === 'SMS' ? share.recipientPhone : share.recipientEmail;
    const first = shareFiles[0]!;
    res.json({
      state: 'ok',
      gated: share.gated,
      verified,
      // Back-compat single-file fields (first file) + the full list. A
      // bundle has bundle:true and files.length > 1.
      bundle: shareFiles.length > 1,
      fileName: first.fileName,
      isPdf: first.isPdf,
      files: shareFiles.map((f) => ({ fileId: f.fileId, fileName: f.fileName, isPdf: f.isPdf })),
      accessLevel: share.accessLevel,
      watermark: share.watermark,
      expiresAt: share.expiresAt?.toISOString() ?? null,
      organization: share.organization,
      channel,
      maskedDestination: destination
        ? channel === 'SMS'
          ? maskPhone(destination)
          : maskEmail(destination)
        : null,
    });
  });

  // ----------------------------------------------------------------
  router.post('/:token/send-code', async (req: Request, res: Response) => {
    if (
      !(await withinIpLimit(deps.redis, req, res, 'send', IP_WINDOW_SECONDS, SEND_MAX_PER_WINDOW))
    )
      return;
    const ctx = await resolve(req, res);
    if (!ctx) return;
    const db = deps.db!;
    const { share, ip, userAgent } = ctx;
    if (shareState(share) !== 'ok' || !share.gated) {
      res.status(409).json({ error: 'not_applicable' });
      return;
    }
    const challenge = await createOtpChallenge(db, share);
    if (!challenge.ok) {
      if (challenge.error === 'cooldown') {
        res.setHeader('Retry-After', String(challenge.retryAfterSeconds));
        res.status(429).json({ error: 'cooldown', retryAfterSeconds: challenge.retryAfterSeconds });
        return;
      }
      if (challenge.error === 'send_quota') {
        res.status(429).json({ error: 'too_many_codes' });
        return;
      }
      res.status(409).json({ error: 'no_destination' });
      return;
    }
    // Dispatch — best-effort; the code is never logged or echoed.
    try {
      if (challenge.channel === 'SMS' && deps.sendSms) {
        await deps.sendSms({
          to: challenge.destination,
          body: `Your document access code is ${challenge.code}. It expires in 10 minutes.`,
        });
      } else if (deps.sendEmail) {
        await deps.sendEmail({
          to: challenge.destination,
          subject: 'Your document access code',
          body:
            `Your access code is: ${challenge.code}\n\n` +
            `Enter it on the secure document page to view the file. ` +
            `The code expires in 10 minutes.\n\n` +
            `If you did not request this, you can ignore this message.`,
        });
      } else {
        res.status(503).json({ error: 'delivery_unavailable' });
        return;
      }
    } catch (err) {
      logger.error({ err, shareId: share.id }, 'access code delivery failed');
      res.status(502).json({ error: 'delivery_failed' });
      return;
    }
    await logShareEvent(db, share.id, 'otp_sent', ip, userAgent);
    res.json({
      ok: true,
      channel: challenge.channel,
      maskedDestination: challenge.maskedDestination,
      cooldownSeconds: 60,
    });
  });

  // ----------------------------------------------------------------
  router.post('/:token/verify', async (req: Request, res: Response) => {
    if (
      !(await withinIpLimit(
        deps.redis,
        req,
        res,
        'verify',
        IP_WINDOW_SECONDS,
        VERIFY_MAX_PER_WINDOW,
      ))
    )
      return;
    const ctx = await resolve(req, res);
    if (!ctx) return;
    const db = deps.db!;
    const { share, ip, userAgent } = ctx;
    if (shareState(share) !== 'ok' || !share.gated) {
      res.status(409).json({ error: 'not_applicable' });
      return;
    }
    const parsed = VerifyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const result = await verifyOtpChallenge(db, share.id, parsed.data.code);
    if (!result.ok) {
      if (result.error === 'invalid_code') {
        await logShareEvent(db, share.id, 'otp_failed', ip, userAgent);
        res
          .status(401)
          .json({ error: 'invalid_code', attemptsRemaining: result.attemptsRemaining });
        return;
      }
      if (result.error === 'locked') {
        await logShareEvent(db, share.id, 'otp_locked', ip, userAgent);
        if (result.shouldRevoke) {
          await revokeFileShare(db, share.id);
          await logShareEvent(db, share.id, 'revoked_lockout', ip, userAgent);
          // System actor — sustained guessing burned the link.
          await emitAudit(db, {
            action: 'UPDATE',
            entityType: 'file_share',
            entityId: share.id,
            after: { revoked: true, reason: 'otp_lockout' },
            ip,
            userAgent,
          }).catch(() => undefined);
        }
        res.status(403).json({ error: 'locked' });
        return;
      }
      res.status(409).json({ error: 'no_active_code' });
      return;
    }
    await logShareEvent(db, share.id, 'otp_verified', ip, userAgent);
    res.setHeader(
      'Set-Cookie',
      serializeCookie(grantCookieName(share.id), result.grant, {
        httpOnly: true,
        sameSite: 'strict',
        path: '/api/shared-file',
        maxAge: Math.floor(GRANT_TTL_MS / 1000),
        secure: cookieSecure(),
      }),
    );
    res.json({ ok: true });
  });

  // ----------------------------------------------------------------
  // Shared access path for /content and /download.
  async function access(req: Request, res: Response, mode: 'content' | 'download'): Promise<void> {
    if (
      !(await withinIpLimit(deps.redis, req, res, mode, IP_WINDOW_SECONDS, CONTENT_MAX_PER_WINDOW))
    )
      return;
    const ctx = await resolve(req, res);
    if (!ctx) return;
    const db = deps.db!;
    const { share, ip, userAgent } = ctx;
    const state = shareState(share);
    if (state === 'revoked') {
      await logShareEvent(db, share.id, 'denied_revoked', ip, userAgent);
      res.status(410).json({ error: 'revoked' });
      return;
    }
    if (state === 'expired') {
      await logShareEvent(db, share.id, 'denied_expired', ip, userAgent);
      res.status(410).json({ error: 'expired' });
      return;
    }
    if (share.gated) {
      const grant = readGrantCookie(req, share.id);
      const verified = grant ? await verifyGrant(db, share.id, grant) : false;
      if (!verified) {
        await logShareEvent(db, share.id, 'denied_not_verified', ip, userAgent);
        res.status(403).json({ error: 'verification_required' });
        return;
      }
    }
    if (mode === 'download' && share.accessLevel !== 'download') {
      res.status(403).json({ error: 'view_only' });
      return;
    }
    // Pick the requested file, authorized against the share's file set
    // (the single file_id, or any file in a 0154 bundle). A bundle must
    // name a fileId; a single share defaults to its one file.
    const allowedIds = new Set(await fileShareFileIds(db, share));
    const requestedId =
      typeof req.query['fileId'] === 'string' ? req.query['fileId'] : (share.fileId ?? null);
    if (!requestedId || !allowedIds.has(requestedId)) {
      await logShareEvent(db, share.id, 'denied_file_gone', ip, userAgent);
      res.status(404).json({ error: 'file_not_found' });
      return;
    }
    const [file] = await db
      .select({
        storageKey: files.storageKey,
        originalFilename: files.originalFilename,
        mimeType: files.mimeType,
        deletedAt: files.deletedAt,
        pendingUpload: files.pendingUpload,
      })
      .from(files)
      .where(eq(files.id, requestedId))
      .limit(1);
    if (!file || file.deletedAt != null || file.pendingUpload) {
      await logShareEvent(db, share.id, 'denied_file_gone', ip, userAgent);
      res.status(410).json({ error: 'file_gone' });
      return;
    }
    const storage = resolveStorage(deps);
    if (!storage) {
      res.status(503).json({ error: 'storage_unavailable' });
      return;
    }
    await serveSharedFile({
      db,
      storage,
      share,
      file,
      res,
      disposition: mode === 'download' ? 'attachment' : 'inline',
      ip,
      userAgent,
      // PDFs stream in both modes: the same-origin canvas viewer needs
      // bytes, and a post-gate presigned URL would be an ungated leak.
      forceStreamPdf: true,
    });
  }

  router.get('/:token/content', (req, res) => void access(req, res, 'content'));
  router.get('/:token/download', (req, res) => void access(req, res, 'download'));

  return router;
}
