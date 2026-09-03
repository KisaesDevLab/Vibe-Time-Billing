// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0235 — engagement videos, staff side. Three routers share one deps
// object so app.ts can mount them at their natural prefixes:
//
//   engagementScoped  /api/staff/engagements/:engagementId/videos   list, reserve
//   byId              /api/staff/videos/:id                        complete, patch, delete, plays
//   clientScoped      /api/staff/clients/:clientId/videos          read-only roll-up
//
// Upload is reserve → browser PUT (presigned, straight to storage) →
// complete, mirroring clients/files.ts. Objects live under
// system/engagement-videos/… so they never appear in a client folder.
// Retention clocks are per video (falling back to firm_settings
// defaults) and materialised into expires_at by computeVideoExpiresAt.

import express, { type Request, type Response, type Router } from 'express';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';

import { videos as coreVideos } from '@vibe/core';
import type { Database } from '@vibe/db';
import {
  clients,
  engagementVideoPlays,
  engagementVideos,
  engagements,
  firmSettings,
  messages,
  portalIdentity,
  type EngagementVideoMime,
} from '@vibe/db/schema';
import { buildStorageClient, sanitizeForWindows, type StorageClient } from '@vibe/storage';

import { emitAudit } from '../auth/audit';
import { blockIfClientRestricted } from '../clients/access';
import { logger } from '../logger';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';

export const VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'] as const;
export const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB — single-part PUT (Q40)
/** Presigned PUT lifetime. Longer than client files (15 min): a 2 GB
 *  upload on a slow office connection must not outlive its URL. */
export const VIDEO_PRESIGN_PUT_TTL_SECONDS = 60 * 60;
export const VIDEO_STORAGE_PREFIX = 'system/engagement-videos';

export interface VideoReadyEvent {
  firmId: string;
  engagementId: string;
  clientId: string;
  videoId: string;
  title: string;
  message: string | null;
  actorAppUserId: string;
  ip: string | null;
  userAgent: string | null;
}

export interface EngagementVideoRoutesDeps extends RbacDeps {
  db: Database | null;
  /** Injected in tests; otherwise built from process.env per request. */
  storageClient?: StorageClient;
  /** Called once after a completed upload when notify_client is set.
   *  app.ts wires the staged-notification producer; tests pass a spy. */
  onVideoReady?: (event: VideoReadyEvent) => Promise<void>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const daysSchema = z.number().int().min(1).max(3650).nullable();

const ReserveSchema = z.object({
  title: z.string().trim().min(1).max(200),
  message: z.string().trim().max(2000).nullable().optional(),
  originalFilename: z.string().min(1).max(255),
  mimeType: z.enum(VIDEO_MIME_TYPES),
  sizeBytes: z.number().int().min(1).max(MAX_VIDEO_BYTES),
  /** Omitted ⇒ firm default; null ⇒ that clock is off for this video. */
  deleteAfterDays: daysSchema.optional(),
  deleteDaysAfterFirstPlay: daysSchema.optional(),
  notifyClient: z.boolean().optional(),
});

const PatchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    message: z.string().trim().max(2000).nullable().optional(),
    deleteAfterDays: daysSchema.optional(),
    deleteDaysAfterFirstPlay: daysSchema.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'empty_patch' });

export interface StaffVideoRow {
  id: string;
  engagementId: string;
  engagementName?: string;
  clientId: string;
  title: string;
  message: string | null;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  uploadedBy: string | null;
  uploadedAt: string;
  deleteAfterDays: number | null;
  deleteDaysAfterFirstPlay: number | null;
  expiresAt: string | null;
  notifyClient: boolean;
  notifiedAt: string | null;
  firstPlayedAt: string | null;
  lastPlayedAt: string | null;
  playCount: number;
  maxProgressPct: number | null;
  replyCount: number;
  expiredAt: string | null;
  deletedAt: string | null;
}

function getStorage(deps: EngagementVideoRoutesDeps): StorageClient | null {
  if (deps.storageClient) return deps.storageClient;
  try {
    return buildStorageClient(process.env);
  } catch {
    return null;
  }
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

const replyCountSql = sql<number>`(
  SELECT count(*)::int FROM ${messages} m
  WHERE m.engagement_video_id = ${engagementVideos.id} AND m.deleted_at IS NULL
)`;

const LIST_COLUMNS = {
  id: engagementVideos.id,
  engagementId: engagementVideos.engagementId,
  clientId: engagementVideos.clientId,
  title: engagementVideos.title,
  message: engagementVideos.message,
  originalFilename: engagementVideos.originalFilename,
  mimeType: engagementVideos.mimeType,
  sizeBytes: engagementVideos.sizeBytes,
  status: engagementVideos.status,
  uploadedBy: engagementVideos.uploadedBy,
  uploadedAt: engagementVideos.uploadedAt,
  deleteAfterDays: engagementVideos.deleteAfterDays,
  deleteDaysAfterFirstPlay: engagementVideos.deleteDaysAfterFirstPlay,
  expiresAt: engagementVideos.expiresAt,
  notifyClient: engagementVideos.notifyClient,
  notifiedAt: engagementVideos.notifiedAt,
  firstPlayedAt: engagementVideos.firstPlayedAt,
  lastPlayedAt: engagementVideos.lastPlayedAt,
  playCount: engagementVideos.playCount,
  maxProgressPct: engagementVideos.maxProgressPct,
  expiredAt: engagementVideos.expiredAt,
  deletedAt: engagementVideos.deletedAt,
  replyCount: replyCountSql,
};

type ListRow = NonNullable<Awaited<ReturnType<typeof loadVideoById>>> & {
  engagementName?: string;
};

function toRow(r: ListRow): StaffVideoRow {
  return {
    id: r.id,
    engagementId: r.engagementId,
    ...(r.engagementName !== undefined ? { engagementName: r.engagementName } : {}),
    clientId: r.clientId,
    title: r.title,
    message: r.message,
    originalFilename: r.originalFilename,
    mimeType: r.mimeType,
    sizeBytes: Number(r.sizeBytes),
    status: r.status,
    uploadedBy: r.uploadedBy,
    uploadedAt: r.uploadedAt.toISOString(),
    deleteAfterDays: r.deleteAfterDays,
    deleteDaysAfterFirstPlay: r.deleteDaysAfterFirstPlay,
    expiresAt: iso(r.expiresAt),
    notifyClient: r.notifyClient,
    notifiedAt: iso(r.notifiedAt),
    firstPlayedAt: iso(r.firstPlayedAt),
    lastPlayedAt: iso(r.lastPlayedAt),
    playCount: r.playCount,
    maxProgressPct: r.maxProgressPct,
    replyCount: Number(r.replyCount ?? 0),
    expiredAt: iso(r.expiredAt),
    deletedAt: iso(r.deletedAt),
  };
}

async function loadEngagementForFirm(
  db: Database,
  firmId: string,
  engagementId: string,
): Promise<{ id: string; clientId: string; name: string } | null> {
  const [row] = await db
    .select({ id: engagements.id, clientId: engagements.clientId, name: engagements.name })
    .from(engagements)
    .innerJoin(clients, eq(clients.id, engagements.clientId))
    .where(and(eq(engagements.id, engagementId), eq(clients.firmId, firmId)))
    .limit(1);
  return row ?? null;
}

async function loadVideoById(db: Database, firmId: string, id: string) {
  const [row] = await db
    .select(LIST_COLUMNS)
    .from(engagementVideos)
    .where(and(eq(engagementVideos.id, id), eq(engagementVideos.firmId, firmId)))
    .limit(1);
  return row ?? null;
}

export function buildVideoStorageKey(args: {
  firmId: string;
  engagementId: string;
  videoId: string;
  originalFilename: string;
}): string {
  const safe = sanitizeForWindows(args.originalFilename) || 'video';
  return `${VIDEO_STORAGE_PREFIX}/${args.firmId}/${args.engagementId}/${args.videoId}/${safe}`;
}

export function createEngagementVideoRouters(deps: EngagementVideoRoutesDeps): {
  engagementScoped: Router;
  byId: Router;
  clientScoped: Router;
} {
  const engagementScoped = express.Router();
  const byId = express.Router();
  const clientScoped = express.Router();

  const badId = (res: Response, value: string | undefined): boolean => {
    if (!value || !UUID_RE.test(value)) {
      res.status(404).json({ error: 'not_found' });
      return true;
    }
    return false;
  };

  // ---- list for one engagement ----------------------------------------
  engagementScoped.get(
    '/:engagementId/videos',
    requirePermission(deps, 'video:read'),
    async (req: Request, res: Response) => {
      const engagementId = req.params['engagementId'];
      if (badId(res, engagementId)) return;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const firmId = req.staffSession!.firmId;
      const eng = await loadEngagementForFirm(deps.db, firmId, engagementId!);
      if (!eng) {
        res.status(404).json({ error: 'engagement_not_found' });
        return;
      }
      if (await blockIfClientRestricted(deps, req, res, eng.clientId)) return;
      const rows = await deps.db
        .select(LIST_COLUMNS)
        .from(engagementVideos)
        .where(
          and(
            eq(engagementVideos.engagementId, eng.id),
            eq(engagementVideos.firmId, firmId),
            ne(engagementVideos.status, 'DELETED'),
          ),
        )
        .orderBy(desc(engagementVideos.uploadedAt));
      res.json({ items: rows.map(toRow) });
    },
  );

  // ---- reserve ---------------------------------------------------------
  engagementScoped.post(
    '/:engagementId/videos',
    requirePermission(deps, 'video:write'),
    async (req: Request, res: Response) => {
      const engagementId = req.params['engagementId'];
      if (badId(res, engagementId)) return;
      const parsed = ReserveSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const session = req.staffSession!;
      const firmId = session.firmId;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const storage = getStorage(deps);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }
      const eng = await loadEngagementForFirm(deps.db, firmId, engagementId!);
      if (!eng) {
        res.status(404).json({ error: 'engagement_not_found' });
        return;
      }
      if (await blockIfClientRestricted(deps, req, res, eng.clientId)) return;

      const body = parsed.data;
      let deleteAfterDays = body.deleteAfterDays;
      let deleteDaysAfterFirstPlay = body.deleteDaysAfterFirstPlay;
      if (deleteAfterDays === undefined || deleteDaysAfterFirstPlay === undefined) {
        const [fs] = await deps.db
          .select({
            upload: firmSettings.videoDefaultDeleteAfterDays,
            play: firmSettings.videoDefaultDeleteDaysAfterPlay,
          })
          .from(firmSettings)
          .where(eq(firmSettings.firmId, firmId))
          .limit(1);
        if (deleteAfterDays === undefined) deleteAfterDays = fs?.upload ?? null;
        if (deleteDaysAfterFirstPlay === undefined) deleteDaysAfterFirstPlay = fs?.play ?? null;
      }

      const videoId = crypto.randomUUID();
      const storageKey = buildVideoStorageKey({
        firmId,
        engagementId: eng.id,
        videoId,
        originalFilename: body.originalFilename,
      });

      let uploadUrl: string;
      try {
        uploadUrl = await storage.presignPut(
          storageKey,
          { contentType: body.mimeType, expectedSizeBytes: body.sizeBytes },
          VIDEO_PRESIGN_PUT_TTL_SECONDS,
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : 'presign_failed';
        res.status(502).json({ error: 'presign_failed', detail });
        return;
      }

      await deps.db.insert(engagementVideos).values({
        id: videoId,
        firmId,
        engagementId: eng.id,
        clientId: eng.clientId,
        title: body.title,
        message: body.message ?? null,
        originalFilename: sanitizeForWindows(body.originalFilename) || 'video',
        mimeType: body.mimeType as EngagementVideoMime,
        sizeBytes: body.sizeBytes,
        storageKey,
        status: 'PENDING_UPLOAD',
        uploadedBy: session.appUserId,
        deleteAfterDays,
        deleteDaysAfterFirstPlay,
        notifyClient: body.notifyClient ?? true,
      });

      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'engagement_video',
        entityId: videoId,
        actorAppUserId: session.appUserId,
        after: {
          engagementId: eng.id,
          clientId: eng.clientId,
          title: body.title,
          storageKey,
          deleteAfterDays,
          deleteDaysAfterFirstPlay,
          pending: true,
        },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch(() => undefined);

      res.status(201).json({
        videoId,
        storageKey,
        uploadUrl,
        expiresAt: new Date(Date.now() + VIDEO_PRESIGN_PUT_TTL_SECONDS * 1000).toISOString(),
        deleteAfterDays,
        deleteDaysAfterFirstPlay,
      });
    },
  );

  // ---- complete ---------------------------------------------------------
  byId.post(
    '/:id/complete',
    requirePermission(deps, 'video:write'),
    async (req: Request, res: Response) => {
      const id = req.params['id'];
      if (badId(res, id)) return;
      const session = req.staffSession!;
      const firmId = session.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const storage = getStorage(deps);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }
      const db = deps.db;
      const [row] = await db
        .select({
          id: engagementVideos.id,
          storageKey: engagementVideos.storageKey,
          status: engagementVideos.status,
          uploadedAt: engagementVideos.uploadedAt,
          deleteAfterDays: engagementVideos.deleteAfterDays,
          deleteDaysAfterFirstPlay: engagementVideos.deleteDaysAfterFirstPlay,
          notifyClient: engagementVideos.notifyClient,
          notifiedAt: engagementVideos.notifiedAt,
          engagementId: engagementVideos.engagementId,
          clientId: engagementVideos.clientId,
          title: engagementVideos.title,
          message: engagementVideos.message,
        })
        .from(engagementVideos)
        .where(and(eq(engagementVideos.id, id!), eq(engagementVideos.firmId, firmId)))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'video_not_found' });
        return;
      }
      if (await blockIfClientRestricted(deps, req, res, row.clientId)) return;
      if (row.status !== 'PENDING_UPLOAD') {
        const current = await loadVideoById(db, firmId, row.id);
        res.json({ ok: true, alreadyComplete: true, video: current ? toRow(current) : null });
        return;
      }
      const meta = await storage.head(row.storageKey);
      if (!meta) {
        res.status(409).json({ error: 'object_not_yet_landed', storageKey: row.storageKey });
        return;
      }
      if (meta.sizeBytes > MAX_VIDEO_BYTES) {
        await storage.delete(row.storageKey).catch(() => undefined);
        await db.delete(engagementVideos).where(eq(engagementVideos.id, row.id));
        res.status(413).json({ error: 'video_too_large', maxBytes: MAX_VIDEO_BYTES });
        return;
      }
      const uploadedAt = new Date();
      const expiresAt = coreVideos.computeVideoExpiresAt({
        uploadedAt,
        firstPlayedAt: null,
        deleteAfterDays: row.deleteAfterDays,
        deleteDaysAfterFirstPlay: row.deleteDaysAfterFirstPlay,
      });
      const shouldNotify = row.notifyClient && !row.notifiedAt && !!deps.onVideoReady;
      // Guarded on the pending status so two overlapping completes cannot
      // both go on to stage a notification.
      const flipped = await db
        .update(engagementVideos)
        .set({
          etag: meta.etag,
          sizeBytes: meta.sizeBytes,
          status: 'AVAILABLE',
          uploadedAt,
          expiresAt,
          updatedAt: uploadedAt,
        })
        .where(and(eq(engagementVideos.id, row.id), eq(engagementVideos.status, 'PENDING_UPLOAD')))
        .returning({ id: engagementVideos.id });
      if (flipped.length === 0) {
        const current = await loadVideoById(db, firmId, row.id);
        res.json({ ok: true, alreadyComplete: true, video: current ? toRow(current) : null });
        return;
      }

      await emitAudit(db, {
        action: 'UPDATE',
        entityType: 'engagement_video',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        after: { completed: true, etag: meta.etag, sizeBytes: meta.sizeBytes, expiresAt },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch(() => undefined);

      // Stamp notified_at only once the producer has actually staged the
      // send. Stamping it up front meant a Redis blip silently and
      // permanently suppressed the client's email/SMS/portal notice while
      // the row claimed it had gone out, with no retry and no error.
      let notifyFailed = false;
      if (shouldNotify) {
        try {
          await deps.onVideoReady!({
            firmId,
            engagementId: row.engagementId,
            clientId: row.clientId,
            videoId: row.id,
            title: row.title,
            message: row.message,
            actorAppUserId: session.appUserId,
            ip: req.ip ?? null,
            userAgent: req.get('user-agent') ?? null,
          });
          await db
            .update(engagementVideos)
            .set({ notifiedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(engagementVideos.id, row.id), isNull(engagementVideos.notifiedAt)));
        } catch (err) {
          notifyFailed = true;
          logger.error(
            { err, videoId: row.id, clientId: row.clientId },
            'video ready notification could not be staged; notified_at left unset',
          );
        }
      }

      const current = await loadVideoById(db, firmId, row.id);
      res.json({
        ok: true,
        ...(notifyFailed ? { notifyFailed: true } : {}),
        video: current ? toRow(current) : null,
      });
    },
  );

  // ---- patch (title / message / retention) ------------------------------
  byId.patch('/:id', requirePermission(deps, 'video:write'), async (req, res) => {
    const id = req.params['id'];
    if (badId(res, id)) return;
    const parsed = PatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
      return;
    }
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ ok: true });
      return;
    }
    const db = deps.db;
    const before = await loadVideoById(db, session.firmId, id!);
    if (!before) {
      res.status(404).json({ error: 'video_not_found' });
      return;
    }
    if (await blockIfClientRestricted(deps, req, res, before.clientId)) return;
    if (before.status === 'EXPIRED' || before.status === 'DELETED') {
      res.status(409).json({ error: 'video_not_editable', status: before.status });
      return;
    }
    const b = parsed.data;
    const deleteAfterDays =
      b.deleteAfterDays !== undefined ? b.deleteAfterDays : before.deleteAfterDays;
    const deleteDaysAfterFirstPlay =
      b.deleteDaysAfterFirstPlay !== undefined
        ? b.deleteDaysAfterFirstPlay
        : before.deleteDaysAfterFirstPlay;
    const expiresAt =
      before.status === 'AVAILABLE'
        ? coreVideos.computeVideoExpiresAt({
            uploadedAt: before.uploadedAt,
            firstPlayedAt: before.firstPlayedAt,
            deleteAfterDays,
            deleteDaysAfterFirstPlay,
          })
        : before.expiresAt;
    await db
      .update(engagementVideos)
      .set({
        ...(b.title !== undefined ? { title: b.title } : {}),
        ...(b.message !== undefined ? { message: b.message } : {}),
        deleteAfterDays,
        deleteDaysAfterFirstPlay,
        expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(engagementVideos.id, before.id));
    await emitAudit(db, {
      action: 'UPDATE',
      entityType: 'engagement_video',
      entityId: before.id,
      actorAppUserId: session.appUserId,
      before: {
        title: before.title,
        deleteAfterDays: before.deleteAfterDays,
        deleteDaysAfterFirstPlay: before.deleteDaysAfterFirstPlay,
        expiresAt: before.expiresAt,
      },
      after: { ...b, expiresAt },
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    }).catch(() => undefined);
    const after = await loadVideoById(db, session.firmId, before.id);
    res.json({ ok: true, video: after ? toRow(after) : null });
  });

  // ---- delete (early) ----------------------------------------------------
  byId.delete('/:id', requirePermission(deps, 'video:delete'), async (req, res) => {
    const id = req.params['id'];
    if (badId(res, id)) return;
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ ok: true });
      return;
    }
    const db = deps.db;
    const [row] = await db
      .select({
        id: engagementVideos.id,
        status: engagementVideos.status,
        storageKey: engagementVideos.storageKey,
        clientId: engagementVideos.clientId,
      })
      .from(engagementVideos)
      .where(and(eq(engagementVideos.id, id!), eq(engagementVideos.firmId, session.firmId)))
      .limit(1);
    if (!row) {
      res.status(404).json({ error: 'video_not_found' });
      return;
    }
    if (await blockIfClientRestricted(deps, req, res, row.clientId)) return;
    if (row.status === 'DELETED') {
      res.json({ ok: true, alreadyDeleted: true });
      return;
    }
    const storage = getStorage(deps);
    if (storage && row.status !== 'EXPIRED') {
      // Best-effort: a missing object must not block the row transition.
      await storage.delete(row.storageKey).catch(() => undefined);
    }
    if (row.status === 'PENDING_UPLOAD') {
      // Cancelled before the object landed — nothing worth keeping.
      await db.delete(engagementVideos).where(eq(engagementVideos.id, row.id));
    } else {
      await db
        .update(engagementVideos)
        .set({
          status: 'DELETED',
          deletedAt: new Date(),
          deletedBy: session.appUserId,
          updatedAt: new Date(),
        })
        .where(eq(engagementVideos.id, row.id));
    }
    await emitAudit(db, {
      action: 'ARCHIVE',
      entityType: 'engagement_video',
      entityId: row.id,
      actorAppUserId: session.appUserId,
      before: { status: row.status },
      after: { status: row.status === 'PENDING_UPLOAD' ? 'REMOVED' : 'DELETED' },
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    }).catch(() => undefined);
    res.json({ ok: true });
  });

  // ---- play log -----------------------------------------------------------
  byId.get('/:id/plays', requirePermission(deps, 'video:read'), async (req, res) => {
    const id = req.params['id'];
    if (badId(res, id)) return;
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const video = await loadVideoById(deps.db, session.firmId, id!);
    if (!video) {
      res.status(404).json({ error: 'video_not_found' });
      return;
    }
    if (await blockIfClientRestricted(deps, req, res, video.clientId)) return;
    const rows = await deps.db
      .select({
        id: engagementVideoPlays.id,
        portalIdentityId: engagementVideoPlays.portalIdentityId,
        viewerName: portalIdentity.fullName,
        viewerEmail: portalIdentity.primaryEmail,
        startedAt: engagementVideoPlays.startedAt,
        lastHeartbeatAt: engagementVideoPlays.lastHeartbeatAt,
        furthestSeconds: engagementVideoPlays.furthestSeconds,
        durationSeconds: engagementVideoPlays.durationSeconds,
        completed: engagementVideoPlays.completed,
        deviceKind: engagementVideoPlays.deviceKind,
        userAgent: engagementVideoPlays.userAgent,
      })
      .from(engagementVideoPlays)
      .leftJoin(portalIdentity, eq(portalIdentity.id, engagementVideoPlays.portalIdentityId))
      .where(eq(engagementVideoPlays.videoId, video.id))
      .orderBy(desc(engagementVideoPlays.startedAt));
    res.json({
      video: toRow(video),
      items: rows.map((r) => ({
        id: r.id,
        portalIdentityId: r.portalIdentityId,
        viewerName: r.viewerName ?? null,
        viewerEmail: r.viewerEmail ?? null,
        startedAt: r.startedAt.toISOString(),
        lastHeartbeatAt: r.lastHeartbeatAt.toISOString(),
        furthestSeconds: r.furthestSeconds,
        durationSeconds: r.durationSeconds,
        progressPct: coreVideos.videoProgressPct(r.furthestSeconds, r.durationSeconds),
        completed: r.completed,
        deviceKind: r.deviceKind,
        userAgent: r.userAgent,
      })),
    });
  });

  // ---- client roll-up ---------------------------------------------------
  clientScoped.get('/:clientId/videos', requirePermission(deps, 'video:read'), async (req, res) => {
    const clientId = req.params['clientId'];
    if (badId(res, clientId)) return;
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    if (await blockIfClientRestricted(deps, req, res, clientId!)) return;
    const rows = await deps.db
      .select({ ...LIST_COLUMNS, engagementName: engagements.name })
      .from(engagementVideos)
      .innerJoin(engagements, eq(engagements.id, engagementVideos.engagementId))
      .where(
        and(
          eq(engagementVideos.clientId, clientId!),
          eq(engagementVideos.firmId, session.firmId),
          ne(engagementVideos.status, 'DELETED'),
        ),
      )
      .orderBy(desc(engagementVideos.uploadedAt));
    res.json({ items: rows.map(toRow) });
  });

  return { engagementScoped, byId, clientScoped };
}
