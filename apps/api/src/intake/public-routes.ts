// SPDX-License-Identifier: Elastic-2.0
//
// Public, anonymous document-intake API. Mounted at /api/public/intake/*
// OUTSIDE the /api/staff auth+csrf chain and the portal chain — isolated
// like /api/shared so a bug in authed middleware can't gate (or expose)
// this surface, and so the intake Caddy site can safely proxy ONLY this
// prefix.
//
// Surface (all gated on isIntakeEnabled for the single appliance firm):
//   GET  /health                     — reachability probe (no firm leak)
//   GET  /staff                      — visible, upload-accepting cards
//   GET  /staff/:id/headshot         — streamed headshot (404 if none)
//   POST /session                    — start a session (PII MFK-encrypted)
//   POST /session/:id/files          — raw-body upload → quarantine prefix
//   POST /session/:id/complete       — enqueue the worker pipeline
//
// Anonymous clients hold no key — PII columns + stored objects are
// encrypted at rest under the firm MFK (per-record DEK), not E2EE.

import express, { type Request, type Response, type Router, type NextFunction } from 'express';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appUsers,
  firmSettings,
  intakeFiles,
  intakeSessions,
  intakeStaffCards,
} from '@vibe/db/schema';
import { buildStorageClient, type StorageClient } from '@vibe/storage';
import { checkAndIncrement } from '@vibe/core/auth';

import { logger } from '../logger';
import { getApplianceLockState } from '../crypto/boot';
import { isIntakeEnabled } from './feature-flag';
import { resolveApplianceFirmId } from './firm';
import { newIntakeRecordKey, unwrapIntakeRecordKey, encField } from './crypto';
import { enqueueIntakeProcess, type IntakeProcessJob } from './queue';
import { resolveIntakeLink, markLinkUsed } from './links';
import { decryptTurnstileSecret } from './turnstile-config';

export interface IntakePublicDeps {
  db: Database | null;
  redis: Redis;
  storageClient?: StorageClient;
  /** Override the worker enqueue (tests stub this to avoid a live queue). */
  enqueue?: (job: IntakeProcessJob) => Promise<void>;
  /** Override Turnstile token verification in tests (default: live siteverify).
   *  Receives the firm's decrypted secret + the submitted token. */
  verifyCaptcha?: (secret: string, token: string, ip: string) => Promise<boolean>;
}

// Cloudflare Turnstile server-side verification. Fail-closed: any error or a
// falsey result rejects (a CAPTCHA that fails open is no CAPTCHA).
async function verifyTurnstile(secret: string, token: string, ip: string): Promise<boolean> {
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set('remoteip', ip);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = (await r.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

// ── limits ──────────────────────────────────────────────────────────────
const IP_WINDOW_SECONDS = 60;
const IP_MAX_PER_WINDOW = 120;
const SESSION_CREATE_WINDOW_SECONDS = 60 * 60;
const SESSION_CREATE_MAX_PER_IP = 10;
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB per file
const MAX_FILES_PER_SESSION = 30;
const QUARANTINE_PREFIX = 'intake/quarantine';

// Accepted upload types — documents + images the worker can assemble. The
// extension blocklist is belt-and-suspenders over the allowlist.
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/tiff',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
]);
const BLOCKED_EXT =
  /\.(exe|com|bat|cmd|msi|scr|pif|cpl|js|jse|vbs|vbe|wsf|wsh|ps1|sh|jar|app|dll|sys|reg)$/i;

function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0];
  return (first ?? req.ip ?? '0.0.0.0').trim();
}

function getStorage(deps: IntakePublicDeps): StorageClient | null {
  if (deps.storageClient) return deps.storageClient;
  try {
    return buildStorageClient(process.env);
  } catch {
    return null;
  }
}

// Resolve the firm's Turnstile config (admin-managed). Returns null when not
// fully configured (CAPTCHA off) or the secret can't be decrypted.
async function loadTurnstile(
  db: Database,
  firmId: string,
): Promise<{ siteKey: string; secret: string } | null> {
  const [s] = await db
    .select({
      siteKey: firmSettings.turnstileSiteKey,
      secretEnc: firmSettings.turnstileSecretEnc,
    })
    .from(firmSettings)
    .where(eq(firmSettings.firmId, firmId))
    .limit(1);
  if (!s?.siteKey || !s.secretEnc) return null;
  try {
    return { siteKey: s.siteKey, secret: decryptTurnstileSecret(s.secretEnc) };
  } catch {
    return null;
  }
}

// ── validation ──────────────────────────────────────────────────────────
const SessionSchema = z
  .object({
    targetStaffId: z.string().uuid(),
    clientName: z.string().trim().min(1).max(200),
    clientEmail: z.string().trim().email().max(320).optional(),
    clientPhone: z.string().trim().min(7).max(40).optional(),
    message: z.string().trim().max(2000).optional(),
    linkToken: z.string().max(200).optional(),
    captchaToken: z.string().max(4000).optional(),
  })
  .refine((d) => Boolean(d.clientEmail || d.clientPhone), {
    message: 'an email or phone is required',
    path: ['clientEmail'],
  });

export function createIntakePublicRouter(deps: IntakePublicDeps): Router {
  const router = express.Router();

  // CORS: anonymous, cookie-less surface served same-origin. Reflect the
  // request origin and explicitly forbid credentials.
  router.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Credentials', 'false');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Per-IP rate limit on every public intake route. Fail open on limiter
  // errors so a Redis hiccup can't take the surface down.
  router.use((req: Request, res: Response, next: NextFunction) => {
    const ip = clientIp(req);
    void checkAndIncrement(deps.redis, {
      key: `rl:intake:ip:${ip}`,
      windowSeconds: IP_WINDOW_SECONDS,
      max: IP_MAX_PER_WINDOW,
    })
      .then((limit) => {
        if (!limit.allowed) {
          res.setHeader('Retry-After', String(limit.retryAfterSeconds));
          res.status(429).json({ error: 'rate_limited' });
          return;
        }
        next();
      })
      .catch((err: unknown) => {
        logger.warn({ err }, 'intake rate limiter error; allowing request');
        next();
      });
  });

  // Reachability probe — reveals nothing about the firm or feature state.
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  // Resolve the appliance firm + confirm the feature is on. Returns the
  // firmId, or null after having already sent a 404 (so callers just bail).
  async function requireEnabledFirm(res: Response): Promise<string | null> {
    const firmId = await resolveApplianceFirmId(deps.db);
    if (!firmId || !(await isIntakeEnabled(deps.db, firmId))) {
      res.status(404).json({ error: 'not_found' });
      return null;
    }
    return firmId;
  }

  function cryptoReady(firmId: string): boolean {
    const lock = getApplianceLockState();
    return lock.kind === 'unlocked' && lock.firmId === firmId;
  }

  // ── GET /config — public form config (Turnstile site key when enabled) ─
  router.get('/config', async (_req: Request, res: Response) => {
    const firmId = await requireEnabledFirm(res);
    if (!firmId || !deps.db) return;
    const ts = await loadTurnstile(deps.db, firmId);
    res.json({ turnstileSiteKey: ts?.siteKey ?? null });
  });

  // ── GET /staff — visible, upload-accepting cards ──────────────────────
  router.get('/staff', async (_req: Request, res: Response) => {
    const firmId = await requireEnabledFirm(res);
    if (!firmId || !deps.db) return;
    const rows = await deps.db
      .select({
        userId: intakeStaffCards.userId,
        displayTitle: intakeStaffCards.displayTitle,
        displayOrder: intakeStaffCards.displayOrder,
        headshotObjectKey: intakeStaffCards.headshotObjectKey,
        fullName: appUsers.fullName,
      })
      .from(intakeStaffCards)
      .innerJoin(appUsers, eq(appUsers.id, intakeStaffCards.userId))
      .where(
        and(
          eq(intakeStaffCards.firmId, firmId),
          eq(intakeStaffCards.isVisible, true),
          eq(intakeStaffCards.acceptingUploads, true),
          eq(appUsers.status, 'ACTIVE'),
        ),
      )
      .orderBy(intakeStaffCards.displayOrder, appUsers.fullName);

    res.json({
      staff: rows.map((r) => ({
        id: r.userId,
        name: r.fullName,
        title: r.displayTitle,
        hasHeadshot: Boolean(r.headshotObjectKey),
      })),
    });
  });

  // ── GET /staff/:id/headshot — streamed image (404 if none) ────────────
  router.get('/staff/:id/headshot', async (req: Request, res: Response) => {
    const firmId = await requireEnabledFirm(res);
    if (!firmId || !deps.db) return;
    const [card] = await deps.db
      .select({ key: intakeStaffCards.headshotObjectKey })
      .from(intakeStaffCards)
      .where(
        and(
          eq(intakeStaffCards.firmId, firmId),
          eq(intakeStaffCards.userId, req.params['id']!),
          eq(intakeStaffCards.isVisible, true),
        ),
      )
      .limit(1);
    if (!card?.key) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const storage = getStorage(deps);
    if (!storage) {
      res.status(503).json({ error: 'storage_unavailable' });
      return;
    }
    try {
      const obj = await storage.get(card.key);
      res.setHeader('Content-Type', obj.meta.contentType ?? 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=300');
      obj.body.pipe(res);
    } catch (err) {
      logger.warn({ err }, 'intake headshot stream failed');
      res.status(404).json({ error: 'not_found' });
    }
  });

  // ── POST /session — start a session (PII encrypted at rest) ───────────
  router.post('/session', async (req: Request, res: Response) => {
    const firmId = await requireEnabledFirm(res);
    if (!firmId || !deps.db) return;

    const ipLimit = await checkAndIncrement(deps.redis, {
      key: `rl:intake:session:ip:${clientIp(req)}`,
      windowSeconds: SESSION_CREATE_WINDOW_SECONDS,
      max: SESSION_CREATE_MAX_PER_IP,
    }).catch(() => ({ allowed: true, retryAfterSeconds: 0 }));
    if (!ipLimit.allowed) {
      res.setHeader('Retry-After', String(ipLimit.retryAfterSeconds));
      res.status(429).json({ error: 'rate_limited' });
      return;
    }

    const parsed = SessionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
      return;
    }

    // CAPTCHA — only enforced when the firm has configured Turnstile.
    const turnstile = await loadTurnstile(deps.db, firmId);
    if (turnstile) {
      const token = parsed.data.captchaToken;
      const verify = deps.verifyCaptcha ?? verifyTurnstile;
      const ok = token ? await verify(turnstile.secret, token, clientIp(req)) : false;
      if (!ok) {
        res.status(400).json({ error: 'captcha_failed' });
        return;
      }
    }

    // Resolve the target. A valid tokenized link binds the staff member
    // (and works even if their public card is hidden); otherwise the
    // chosen staff member must have a visible, upload-accepting card.
    let targetStaffId = parsed.data.targetStaffId;
    let source: 'public' | 'tokenized_link' = 'public';
    let linkTokenId: string | null = null;
    if (parsed.data.linkToken) {
      const link = await resolveIntakeLink(deps.db, firmId, parsed.data.linkToken);
      if (!link) {
        res.status(400).json({ error: 'invalid_link' });
        return;
      }
      targetStaffId = link.targetStaffId;
      source = 'tokenized_link';
      linkTokenId = link.linkId;
    } else {
      const [card] = await deps.db
        .select({ userId: intakeStaffCards.userId })
        .from(intakeStaffCards)
        .where(
          and(
            eq(intakeStaffCards.firmId, firmId),
            eq(intakeStaffCards.userId, parsed.data.targetStaffId),
            eq(intakeStaffCards.isVisible, true),
            eq(intakeStaffCards.acceptingUploads, true),
          ),
        )
        .limit(1);
      if (!card) {
        res.status(400).json({ error: 'staff_unavailable' });
        return;
      }
    }

    if (!cryptoReady(firmId)) {
      res.status(503).json({ error: 'service_unavailable' });
      return;
    }

    let sessionId: string;
    try {
      const { dek, wrappedDek } = newIntakeRecordKey(deps.db, firmId);
      const [row] = await deps.db
        .insert(intakeSessions)
        .values({
          firmId,
          targetStaffId,
          wrappedDek: Buffer.from(wrappedDek),
          clientNameEnc: encField(dek, parsed.data.clientName),
          clientEmailEnc: encField(dek, parsed.data.clientEmail ?? null),
          clientPhoneEnc: encField(dek, parsed.data.clientPhone ?? null),
          messageEnc: encField(dek, parsed.data.message ?? null),
          hasMessage: Boolean(parsed.data.message?.trim()),
          source,
          linkTokenId,
          status: 'pending_scan',
        })
        .returning({ id: intakeSessions.id });
      sessionId = row!.id;
      if (linkTokenId) await markLinkUsed(deps.db, linkTokenId);
    } catch (err) {
      logger.error({ err }, 'intake session create failed');
      res.status(503).json({ error: 'service_unavailable' });
      return;
    }

    res.status(201).json({ sessionId });
  });

  // ── GET /link/:token — resolve a send-a-link token (pre-bind staff) ───
  router.get('/link/:token', async (req: Request, res: Response) => {
    const firmId = await requireEnabledFirm(res);
    if (!firmId || !deps.db) return;
    const link = await resolveIntakeLink(deps.db, firmId, req.params['token']!);
    if (!link) {
      res.status(404).json({ error: 'invalid_link' });
      return;
    }
    const [staff] = await deps.db
      .select({ name: appUsers.fullName })
      .from(appUsers)
      .where(eq(appUsers.id, link.targetStaffId))
      .limit(1);
    res.json({ targetStaffId: link.targetStaffId, staffName: staff?.name ?? null });
  });

  // Load a session that is still open for uploads (pending_scan, this firm).
  async function loadOpenSession(
    db: Database,
    firmId: string,
    sessionId: string,
  ): Promise<{ id: string; wrappedDek: Uint8Array; hasMessage: boolean } | null> {
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
    const [row] = await db
      .select({
        id: intakeSessions.id,
        wrappedDek: intakeSessions.wrappedDek,
        hasMessage: intakeSessions.hasMessage,
      })
      .from(intakeSessions)
      .where(
        and(
          eq(intakeSessions.id, sessionId),
          eq(intakeSessions.firmId, firmId),
          eq(intakeSessions.status, 'pending_scan'),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  // ── POST /session/:id/files — raw-body upload → quarantine prefix ─────
  // Raw body (octet-stream) so the global express.json() (1 MB cap, JSON
  // only) ignores it; filename + mimeType ride in the query string.
  router.post(
    '/session/:id/files',
    express.raw({ type: () => true, limit: MAX_FILE_BYTES + 1024 }),
    async (req: Request, res: Response) => {
      const firmId = await requireEnabledFirm(res);
      if (!firmId || !deps.db) return;

      const sessionId = req.params['id']!;
      const session = await loadOpenSession(deps.db, firmId, sessionId);
      if (!session) {
        res.status(404).json({ error: 'session_not_found' });
        return;
      }

      const filename =
        String(req.query['filename'] ?? '')
          .trim()
          .slice(0, 255) || 'upload';
      const mimeType = String(req.query['mimeType'] ?? 'application/octet-stream').slice(0, 200);

      if (BLOCKED_EXT.test(filename) || !ALLOWED_MIME.has(mimeType)) {
        res.status(415).json({ error: 'unsupported_type' });
        return;
      }

      const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (body.byteLength === 0) {
        res.status(400).json({ error: 'empty_body' });
        return;
      }
      if (body.byteLength > MAX_FILE_BYTES) {
        res.status(413).json({ error: 'file_too_large' });
        return;
      }

      // Cap files per session.
      const countRows = await deps.db
        .select({ n: sql<number>`count(*)::int` })
        .from(intakeFiles)
        .where(eq(intakeFiles.sessionId, session.id));
      if (Number(countRows[0]?.n ?? 0) >= MAX_FILES_PER_SESSION) {
        res.status(409).json({ error: 'too_many_files' });
        return;
      }

      if (!cryptoReady(firmId)) {
        res.status(503).json({ error: 'service_unavailable' });
        return;
      }

      const storage = getStorage(deps);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }

      let fileId: string;
      try {
        const dek = unwrapIntakeRecordKey(deps.db, firmId, session.wrappedDek);
        const [row] = await deps.db
          .insert(intakeFiles)
          .values({
            sessionId: session.id,
            originalFilenameEnc: encField(dek, filename),
            objectKey: 'pending',
            mimeType,
            byteSize: body.byteLength,
            kind: 'upload',
            scanStatus: 'pending',
          })
          .returning({ id: intakeFiles.id });
        fileId = row!.id;

        const objectKey = `${QUARANTINE_PREFIX}/${session.id}/${fileId}`;
        await storage.put(objectKey, body, { contentType: mimeType });
        await deps.db.update(intakeFiles).set({ objectKey }).where(eq(intakeFiles.id, fileId));
      } catch (err) {
        logger.error({ err }, 'intake file upload failed');
        res.status(502).json({ error: 'upload_failed' });
        return;
      }

      res.status(201).json({ fileId });
    },
  );

  // ── POST /session/:id/complete — enqueue the worker pipeline ──────────
  router.post('/session/:id/complete', async (req: Request, res: Response) => {
    const firmId = await requireEnabledFirm(res);
    if (!firmId || !deps.db) return;

    const sessionId = req.params['id']!;
    const session = await loadOpenSession(deps.db, firmId, sessionId);
    if (!session) {
      res.status(404).json({ error: 'session_not_found' });
      return;
    }

    const fileCountRows = await deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(intakeFiles)
      .where(eq(intakeFiles.sessionId, session.id));
    // Require at least a file OR a message — a message-only submission is fine.
    if (Number(fileCountRows[0]?.n ?? 0) === 0 && !session.hasMessage) {
      res.status(400).json({ error: 'no_files' });
      return;
    }

    try {
      await (deps.enqueue ?? enqueueIntakeProcess)({ sessionId: session.id, firmId });
    } catch (err) {
      logger.error({ err }, 'intake enqueue failed');
      res.status(503).json({ error: 'service_unavailable' });
      return;
    }

    res.json({ ok: true });
  });

  return router;
}
