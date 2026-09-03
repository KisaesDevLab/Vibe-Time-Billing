// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0235 — engagement videos, portal side. The client's engagement videos
// are listed on the home page, streamed through a short-lived inline
// presigned URL (never proxied, never downloadable from the UI), and
// every real playback is logged per portal identity. The first play
// starts the "delete M days after first play" clock. A client can reply
// to a video straight from the player; the reply lands in the
// engagement's client thread tagged with the video (D11).
//
// Scope: every list goes through resolveScope (consolidated identities
// see all their clients' videos); single-video routes re-check that the
// video's client is inside the scope before doing anything.

import express, { type Request, type Response, type Router } from 'express';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import { checkAndIncrement } from '@vibe/core/auth';
import { videos as coreVideos } from '@vibe/core';
import type { Database } from '@vibe/db';
import {
  appUsers,
  clientCommunications,
  clients,
  engagementThreadLinks,
  engagementVideoPlays,
  engagementVideos,
  engagements,
  messages,
  portalIdentity,
  staffNotifications,
  threads,
} from '@vibe/db/schema';
import { buildStorageClient, type StorageClient } from '@vibe/storage';

import type { Redis } from 'ioredis';

import { emitAudit } from '../auth/audit';
import { ensureEngagementClientThread } from '../engagement-messaging/client-thread';
import { isMember } from '../engagement-messaging/lifecycle';
import { batchDecryptForThread, encryptForThread } from '../engagement-messaging/thread-crypto';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';
import { resolveScope } from './scope';

export interface PortalVideoRoutesDeps {
  db: Database | null;
  /** Sliding-window limiter surface; fails open when absent/erroring. */
  redis?: Redis | null;
  requireAuth: (req: Request, res: Response, next: () => void) => Promise<void> | void;
  storageClient?: StorageClient;
}

/** Long enough to scrub through a feature-length video on a slow link;
 *  short enough that a leaked link dies the same day. */
export const STREAM_TTL_SECONDS = 6 * 60 * 60;
const STREAM_RATE_LIMIT = { max: 60, windowSeconds: 60 * 60 };
const REPLY_RATE_LIMIT = { max: 30, windowSeconds: 60 * 60 };
/** Heartbeats closer together than this are dropped server-side. */
const HEARTBEAT_MIN_INTERVAL_MS = 3000;
const CONVERSATION_LIMIT = 30;

const DEVICE_KINDS = ['desktop', 'mobile', 'tablet', 'unknown'] as const;

const PlayStartSchema = z.object({
  deviceKind: z.enum(DEVICE_KINDS).optional(),
  durationSeconds: z
    .number()
    .nonnegative()
    .max(24 * 3600)
    .optional(),
});

const HeartbeatSchema = z.object({
  furthestSeconds: z
    .number()
    .nonnegative()
    .max(24 * 3600),
  durationSeconds: z
    .number()
    .nonnegative()
    .max(24 * 3600)
    .optional(),
  completed: z.boolean().optional(),
});

const ReplySchema = z.object({
  body: z.string().trim().min(1).max(10_000),
});

function getStorage(deps: PortalVideoRoutesDeps): StorageClient | null {
  if (deps.storageClient) return deps.storageClient;
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

/** Best-effort device class from the UA when the player didn't say. */
export function deviceKindFromUserAgent(ua: string | null | undefined): string {
  if (!ua) return 'unknown';
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua)) return 'tablet';
  if (/Android.*Mobile|iPhone|iPod|Windows Phone|Mobile Safari|Opera Mini/i.test(ua))
    return 'mobile';
  if (/Android/i.test(ua)) return 'tablet';
  return 'desktop';
}

async function rateLimited(
  deps: PortalVideoRoutesDeps,
  key: string,
  limit: { max: number; windowSeconds: number },
): Promise<{ limited: boolean; retryAfterSeconds?: number }> {
  if (!deps.redis) return { limited: false };
  try {
    const r = await checkAndIncrement(deps.redis, { key, ...limit });
    return r.allowed
      ? { limited: false }
      : { limited: true, retryAfterSeconds: r.retryAfterSeconds };
  } catch (err) {
    logger.warn({ err, key }, 'portal video rate limiter error; allowing');
    return { limited: false };
  }
}

const VIDEO_COLUMNS = {
  id: engagementVideos.id,
  firmId: engagementVideos.firmId,
  engagementId: engagementVideos.engagementId,
  engagementName: engagements.name,
  clientId: engagementVideos.clientId,
  clientName: clients.name,
  title: engagementVideos.title,
  message: engagementVideos.message,
  mimeType: engagementVideos.mimeType,
  sizeBytes: engagementVideos.sizeBytes,
  storageKey: engagementVideos.storageKey,
  status: engagementVideos.status,
  uploadedAt: engagementVideos.uploadedAt,
  expiresAt: engagementVideos.expiresAt,
  firstPlayedAt: engagementVideos.firstPlayedAt,
  deleteAfterDays: engagementVideos.deleteAfterDays,
  deleteDaysAfterFirstPlay: engagementVideos.deleteDaysAfterFirstPlay,
};

function videoQuery(db: Database) {
  return db
    .select(VIDEO_COLUMNS)
    .from(engagementVideos)
    .innerJoin(engagements, eq(engagements.id, engagementVideos.engagementId))
    .innerJoin(clients, eq(clients.id, engagementVideos.clientId))
    .$dynamic();
}

type VideoRow = Awaited<ReturnType<typeof videoQuery>>[number];

function toPortalVideo(v: VideoRow, playedByMe: boolean, isConsolidated: boolean) {
  return {
    id: v.id,
    engagementId: v.engagementId,
    engagementName: v.engagementName,
    ...(isConsolidated ? { clientName: v.clientName } : {}),
    title: v.title,
    message: v.message,
    mimeType: v.mimeType,
    sizeBytes: Number(v.sizeBytes),
    status: v.status,
    uploadedAt: v.uploadedAt.toISOString(),
    expiresAt: v.expiresAt ? v.expiresAt.toISOString() : null,
    firstPlayedAt: v.firstPlayedAt ? v.firstPlayedAt.toISOString() : null,
    playedByMe,
  };
}

export function createPortalVideoRouter(deps: PortalVideoRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router, ['playId']);
  router.use(deps.requireAuth);

  /** Load one video the caller's scope may see (any status but DELETED). */
  async function loadScoped(
    db: Database,
    req: Request,
  ): Promise<{ video: VideoRow; clientIds: string[]; isConsolidated: boolean } | null> {
    const session = req.portalSession!;
    const scope = await resolveScope(db, session, req);
    const [video] = await videoQuery(db)
      .where(
        and(
          eq(engagementVideos.id, req.params['id']!),
          eq(engagementVideos.firmId, session.firmId),
          inArray(engagementVideos.clientId, scope.clientIds),
          isNull(engagementVideos.deletedAt),
        ),
      )
      .limit(1);
    if (!video || video.status === 'DELETED' || video.status === 'PENDING_UPLOAD') return null;
    return { video, clientIds: scope.clientIds, isConsolidated: scope.isConsolidated };
  }

  async function playedByMe(db: Database, videoId: string, identityId: string): Promise<boolean> {
    const [row] = await db
      .select({ id: engagementVideoPlays.id })
      .from(engagementVideoPlays)
      .where(
        and(
          eq(engagementVideoPlays.videoId, videoId),
          eq(engagementVideoPlays.portalIdentityId, identityId),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  // ---- list ------------------------------------------------------------
  router.get('/', async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const db = deps.db;
    const scope = await resolveScope(db, session, req);
    const rows = await db
      .select({
        ...VIDEO_COLUMNS,
        playedByMe: sql<boolean>`EXISTS (
          SELECT 1 FROM ${engagementVideoPlays} p
          WHERE p.video_id = ${engagementVideos.id}
            AND p.portal_identity_id = ${session.portalIdentityId}::uuid
        )`,
      })
      .from(engagementVideos)
      .innerJoin(engagements, eq(engagements.id, engagementVideos.engagementId))
      .innerJoin(clients, eq(clients.id, engagementVideos.clientId))
      .where(
        and(
          eq(engagementVideos.firmId, session.firmId),
          inArray(engagementVideos.clientId, scope.clientIds),
          eq(engagementVideos.status, 'AVAILABLE'),
        ),
      )
      .orderBy(desc(engagementVideos.uploadedAt))
      .limit(100);
    res.json({
      items: rows.map((r) => toPortalVideo(r, Boolean(r.playedByMe), scope.isConsolidated)),
    });
  });

  // ---- metadata ----------------------------------------------------------
  router.get('/:id', async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const found = await loadScoped(deps.db, req);
    if (!found) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (found.video.status === 'EXPIRED') {
      res.status(410).json({ error: 'video_expired', title: found.video.title });
      return;
    }
    const mine = await playedByMe(deps.db, found.video.id, session.portalIdentityId);
    res.json({ video: toPortalVideo(found.video, mine, found.isConsolidated) });
  });

  // ---- stream URL ----------------------------------------------------------
  router.get('/:id/stream', async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const storage = getStorage(deps);
    if (!storage) {
      res.status(503).json({ error: 'storage_unavailable' });
      return;
    }
    const rl = await rateLimited(
      deps,
      `portal:video-stream:${session.portalIdentityId}`,
      STREAM_RATE_LIMIT,
    );
    if (rl.limited) {
      res.status(429).json({ error: 'rate_limited', retryAfterSeconds: rl.retryAfterSeconds });
      return;
    }
    const found = await loadScoped(deps.db, req);
    if (!found) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (found.video.status !== 'AVAILABLE') {
      res.status(410).json({ error: 'video_expired' });
      return;
    }
    let url: string;
    try {
      url = await storage.presignGet(found.video.storageKey, STREAM_TTL_SECONDS, {
        responseContentType: found.video.mimeType,
        responseContentDisposition: 'inline',
      });
    } catch (err) {
      logger.error({ err, videoId: found.video.id }, 'video presign failed');
      res.status(502).json({ error: 'presign_failed' });
      return;
    }
    res.json({
      url,
      expiresAt: new Date(Date.now() + STREAM_TTL_SECONDS * 1000).toISOString(),
      mimeType: found.video.mimeType,
    });
  });

  // ---- play start ------------------------------------------------------------
  router.post('/:id/plays', async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (session.isImpersonation) {
      res.status(403).json({ error: 'impersonation_is_read_only' });
      return;
    }
    const parsed = PlayStartSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    if (!deps.db) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const db = deps.db;
    const found = await loadScoped(db, req);
    if (!found || found.video.status !== 'AVAILABLE') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const v = found.video;
    const now = new Date();
    const ip = clientIp(req);
    const userAgent = req.get('user-agent') ?? null;
    const deviceKind = parsed.data.deviceKind ?? deviceKindFromUserAgent(userAgent);

    let playId = '';
    let firstPlay = false;
    let expiresAt = v.expiresAt;
    await db.transaction(async (tx) => {
      const [play] = await tx
        .insert(engagementVideoPlays)
        .values({
          videoId: v.id,
          portalIdentityId: session.portalIdentityId,
          startedAt: now,
          lastHeartbeatAt: now,
          durationSeconds: parsed.data.durationSeconds ?? null,
          ip,
          userAgent,
          deviceKind,
        })
        .returning({ id: engagementVideoPlays.id });
      playId = play!.id;

      // Claim "first play" with a CONDITIONAL update, not a read-then-write.
      // READ COMMITTED gives a statement snapshot, not mutual exclusion:
      // two identities pressing play in the same second would both read
      // NULL, both believe they were first, and both write a timeline row.
      // Only the transaction whose UPDATE matches the IS NULL predicate
      // wins, and the loser leaves the winner's clock intact.
      const claimedFirst = await tx
        .update(engagementVideos)
        .set({
          firstPlayedAt: now,
          lastPlayedAt: now,
          playCount: sql`${engagementVideos.playCount} + 1`,
          expiresAt: coreVideos.computeVideoExpiresAt({
            uploadedAt: v.uploadedAt,
            firstPlayedAt: now,
            deleteAfterDays: v.deleteAfterDays,
            deleteDaysAfterFirstPlay: v.deleteDaysAfterFirstPlay,
          }),
          updatedAt: now,
        })
        .where(and(eq(engagementVideos.id, v.id), isNull(engagementVideos.firstPlayedAt)))
        .returning({ expiresAt: engagementVideos.expiresAt });
      firstPlay = claimedFirst.length > 0;
      if (firstPlay) {
        expiresAt = claimedFirst[0]?.expiresAt ?? null;
      } else {
        const [after] = await tx
          .update(engagementVideos)
          .set({
            lastPlayedAt: now,
            playCount: sql`${engagementVideos.playCount} + 1`,
            updatedAt: now,
          })
          .where(eq(engagementVideos.id, v.id))
          .returning({ expiresAt: engagementVideos.expiresAt });
        expiresAt = after?.expiresAt ?? null;
      }

      if (firstPlay) {
        const [me] = await tx
          .select({ name: portalIdentity.fullName })
          .from(portalIdentity)
          .where(eq(portalIdentity.id, session.portalIdentityId))
          .limit(1);
        await tx.insert(clientCommunications).values({
          firmId: v.firmId,
          clientId: v.clientId,
          channel: 'PORTAL',
          direction: 'INBOUND',
          subject: `Watched video: ${v.title}`,
          body: `${me?.name ?? 'A client contact'} started watching "${v.title}" (${v.engagementName}) in the portal.`,
          occurredAt: now,
          relatedEntityType: 'engagement_video',
          relatedEntityId: v.id,
        });
      }
    });

    await emitAudit(db, {
      action: 'CREATE',
      entityType: 'engagement_video_play',
      entityId: playId,
      actorPortalIdentityId: session.portalIdentityId,
      activeClientId: session.activeClientId,
      after: { videoId: v.id, firstPlay, deviceKind, expiresAt },
      ip,
      userAgent,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

    res.status(201).json({
      playId,
      firstPlay,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
    });
  });

  // ---- heartbeat -------------------------------------------------------------
  router.patch('/:id/plays/:playId', async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (session.isImpersonation) {
      res.status(403).json({ error: 'impersonation_is_read_only' });
      return;
    }
    const parsed = HeartbeatSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    if (!deps.db) {
      res.json({ ok: true });
      return;
    }
    const db = deps.db;
    const [play] = await db
      .select({
        id: engagementVideoPlays.id,
        videoId: engagementVideoPlays.videoId,
        lastHeartbeatAt: engagementVideoPlays.lastHeartbeatAt,
        furthestSeconds: engagementVideoPlays.furthestSeconds,
        durationSeconds: engagementVideoPlays.durationSeconds,
        completed: engagementVideoPlays.completed,
      })
      .from(engagementVideoPlays)
      .where(
        and(
          eq(engagementVideoPlays.id, req.params['playId']!),
          eq(engagementVideoPlays.videoId, req.params['id']!),
          eq(engagementVideoPlays.portalIdentityId, session.portalIdentityId),
        ),
      )
      .limit(1);
    if (!play) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const now = new Date();
    const b = parsed.data;
    const completed = play.completed || Boolean(b.completed);
    // Throttle: drop chatty heartbeats, but never a completion signal.
    if (
      !b.completed &&
      now.getTime() - play.lastHeartbeatAt.getTime() < HEARTBEAT_MIN_INTERVAL_MS
    ) {
      res.json({ ok: true, throttled: true });
      return;
    }
    const furthest = Math.max(play.furthestSeconds, b.furthestSeconds);
    const duration = b.durationSeconds ?? play.durationSeconds;
    const pct = coreVideos.videoProgressPct(completed ? duration : furthest, duration);
    await db.transaction(async (tx) => {
      await tx
        .update(engagementVideoPlays)
        .set({
          furthestSeconds: furthest,
          durationSeconds: duration,
          completed,
          lastHeartbeatAt: now,
          updatedAt: now,
        })
        .where(eq(engagementVideoPlays.id, play.id));
      await tx
        .update(engagementVideos)
        .set({
          lastPlayedAt: now,
          ...(pct != null
            ? {
                maxProgressPct: sql`GREATEST(COALESCE(${engagementVideos.maxProgressPct}, 0), ${pct})`,
              }
            : {}),
          updatedAt: now,
        })
        .where(eq(engagementVideos.id, play.videoId));
    });
    res.json({ ok: true, furthestSeconds: furthest, completed, progressPct: pct });
  });

  // ---- conversation about this video ------------------------------------------
  router.get('/:id/messages', async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ threadId: null, items: [] });
      return;
    }
    const db = deps.db;
    const found = await loadScoped(db, req);
    if (!found) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const [link] = await db
      .select({ threadId: engagementThreadLinks.threadId })
      .from(engagementThreadLinks)
      .where(eq(engagementThreadLinks.engagementId, found.video.engagementId))
      .limit(1);
    if (
      !link ||
      !(await isMember(db, { threadId: link.threadId, portalIdentityId: session.portalIdentityId }))
    ) {
      res.json({ threadId: null, items: [] });
      return;
    }
    const rows = await db
      .select({
        id: messages.id,
        senderAppUserId: messages.senderAppUserId,
        senderPortalIdentityId: messages.senderPortalIdentityId,
        senderStaffName: appUsers.fullName,
        senderPortalName: portalIdentity.fullName,
        bodyCiphertext: messages.bodyCiphertext,
        createdAt: messages.createdAt,
        videoId: messages.engagementVideoId,
      })
      .from(messages)
      .leftJoin(appUsers, eq(appUsers.id, messages.senderAppUserId))
      .leftJoin(portalIdentity, eq(portalIdentity.id, messages.senderPortalIdentityId))
      .where(and(eq(messages.threadId, link.threadId), isNull(messages.deletedAt)))
      .orderBy(desc(messages.createdAt))
      .limit(CONVERSATION_LIMIT);
    rows.reverse();
    try {
      const plaintexts = await batchDecryptForThread(
        { db, firmId: session.firmId, threadId: link.threadId },
        rows.map((r) => r.bodyCiphertext),
      );
      res.json({
        threadId: link.threadId,
        items: rows.map((r, i) => ({
          id: r.id,
          senderName: r.senderStaffName ?? r.senderPortalName ?? null,
          senderKind: r.senderAppUserId ? 'staff' : 'client',
          mine: r.senderPortalIdentityId === session.portalIdentityId,
          body: plaintexts[i],
          createdAt: r.createdAt.toISOString(),
          aboutThisVideo: r.videoId === found.video.id,
          videoId: r.videoId,
        })),
      });
    } catch (err) {
      logger.error({ err, threadId: link.threadId }, 'video conversation decrypt failed');
      res.status(500).json({ error: 'decrypt_failed' });
    }
  });

  // ---- reply ------------------------------------------------------------------
  router.post('/:id/reply', async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (session.isImpersonation) {
      res.status(403).json({ error: 'impersonation_is_read_only' });
      return;
    }
    const parsed = ReplySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const db = deps.db;
    const rl = await rateLimited(
      deps,
      `portal:video-reply:${session.portalIdentityId}`,
      REPLY_RATE_LIMIT,
    );
    if (rl.limited) {
      res.status(429).json({ error: 'rate_limited', retryAfterSeconds: rl.retryAfterSeconds });
      return;
    }
    const found = await loadScoped(db, req);
    if (!found) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const v = found.video;
    // Check the archived state BEFORE touching membership. Ensuring the
    // thread inserts thread_member rows, so doing it first meant a reply
    // refused with 409 still permanently granted this client read access to
    // a closed engagement's conversation.
    const [existingLink] = await db
      .select({ threadId: engagementThreadLinks.threadId, status: threads.status })
      .from(engagementThreadLinks)
      .innerJoin(threads, eq(threads.id, engagementThreadLinks.threadId))
      .where(eq(engagementThreadLinks.engagementId, v.engagementId))
      .limit(1);
    if (existingLink?.status === 'ARCHIVED') {
      res.status(409).json({ error: 'thread_archived' });
      return;
    }
    const ensured = await ensureEngagementClientThread(db, {
      firmId: v.firmId,
      engagementId: v.engagementId,
      // Only the person replying joins the thread — not every contact.
      portalIdentityIds: [session.portalIdentityId],
    });
    if (!ensured) {
      res.status(500).json({ error: 'thread_create_failed' });
      return;
    }
    const { threadId, staffIds } = ensured;
    const body = parsed.data.body;
    let messageId: string | undefined;
    try {
      const ciphertext = await encryptForThread({ db, firmId: v.firmId, threadId }, body);
      const [row] = await db
        .insert(messages)
        .values({
          threadId,
          senderPortalIdentityId: session.portalIdentityId,
          bodyCiphertext: ciphertext,
          excerptPlaintext: body.slice(0, 80),
          engagementVideoId: v.id,
        })
        .returning({ id: messages.id });
      messageId = row?.id;
      await db.update(threads).set({ updatedAt: new Date() }).where(eq(threads.id, threadId));
    } catch (err) {
      logger.error({ err, threadId }, 'video reply encrypt failed');
      res.status(500).json({ error: 'encrypt_failed' });
      return;
    }

    const [me] = await db
      .select({ name: portalIdentity.fullName })
      .from(portalIdentity)
      .where(eq(portalIdentity.id, session.portalIdentityId))
      .limit(1);
    const senderName = me?.name ?? 'A client contact';
    if (staffIds.size > 0) {
      await db
        .insert(staffNotifications)
        .values(
          [...staffIds].map((sid) => ({
            firmId: v.firmId,
            recipientAppUserId: sid,
            type: 'client_message_thread',
            entityType: 'thread',
            entityId: threadId,
            title: `${senderName} replied to your video "${v.title}"`,
            body: body.slice(0, 160),
            actionUrl: `/engagements/${v.engagementId}`,
          })),
        )
        .catch((err: unknown) =>
          logger.error({ err, threadId }, 'video reply staff notify failed'),
        );
    }
    await emitAudit(db, {
      action: 'CREATE',
      entityType: 'message',
      entityId: messageId ?? null,
      actorPortalIdentityId: session.portalIdentityId,
      activeClientId: session.activeClientId,
      after: { threadId, engagementVideoId: v.id, excerpt: body.slice(0, 80) },
      ip: clientIp(req),
      userAgent: req.get('user-agent') ?? null,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

    res.status(201).json({ threadId, messageId });
  });

  return router;
}

/** Column shape the portal message-list endpoints add for video-tagged
 *  messages; exported so the staff endpoint can share the join. */
export const messageVideoColumns = {
  videoId: messages.engagementVideoId,
  videoTitle: engagementVideos.title,
};

export { asc };
