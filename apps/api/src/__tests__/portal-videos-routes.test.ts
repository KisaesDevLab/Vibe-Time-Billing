// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express from 'express';
import type { Redis } from 'ioredis';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PortalSession } from '@vibe/core/auth';
import {
  clientCommunications,
  engagementThreadLinks,
  engagementVideoPlays,
  engagementVideos,
  messages,
  staffNotifications,
  threadMembers,
} from '@vibe/db/schema';
import type { StorageClient } from '@vibe/storage';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { setApplianceLockState } from '../crypto/boot';
import { getFirmKeyManager, resetFirmKeyManagerForTests } from '../crypto/manager';
import { createPortalVideoRouter, deviceKindFromUserAgent } from '../portal/videos';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let identityId: string;
let otherIdentityId: string;
let sealDir: string;

const DAY = 24 * 3600 * 1000;

function fakeStorage(): StorageClient {
  return {
    kind: 'mock',
    presignGet: async (key: string) => `https://storage.example/get/${encodeURIComponent(key)}`,
  } as unknown as StorageClient;
}

function fakeRedis(): unknown {
  const zsets = new Map<string, Map<string, number>>();
  const get = (k: string): Map<string, number> => {
    if (!zsets.has(k)) zsets.set(k, new Map());
    return zsets.get(k)!;
  };
  return {
    async zremrangebyscore(k: string, a: number, b: number) {
      const z = get(k);
      for (const [m, s] of z) if (s >= a && s <= b) z.delete(m);
      return 0;
    },
    async zcard(k: string) {
      return get(k).size;
    },
    async zadd(k: string, score: number, member: string) {
      get(k).set(member, score);
      return 1;
    },
    async expire() {
      return 1;
    },
  };
}

function app(opts: { identity?: string; impersonation?: boolean; redis?: unknown } = {}) {
  const a = express();
  a.use(express.json());
  const session: PortalSession = {
    realm: 'portal',
    sid: 'sid-1',
    portalIdentityId: opts.identity ?? identityId,
    firmId: seed.firmId,
    activeClientId: seed.clientId,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    csrfToken: 'csrf',
    ip: null,
    userAgent: null,
    ...(opts.impersonation ? { isImpersonation: true } : {}),
  } as PortalSession;
  a.use(
    '/videos',
    createPortalVideoRouter({
      db: harness.db,
      storageClient: fakeStorage(),
      redis: (opts.redis ?? null) as Redis | null,
      requireAuth: (req, _res, next) => {
        req.portalSession = session;
        next();
      },
    }),
  );
  return a;
}

async function insertVideo(
  extra: Partial<typeof engagementVideos.$inferInsert> = {},
): Promise<string> {
  const uploadedAt = extra.uploadedAt ?? new Date();
  const [v] = await harness.db
    .insert(engagementVideos)
    .values({
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      clientId: seed.clientId,
      title: 'Return walkthrough',
      message: 'Watch before our call.',
      originalFilename: 'walkthrough.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 5000,
      storageKey: `system/engagement-videos/${seed.firmId}/${seed.engagementId}/${crypto.randomUUID()}/walkthrough.mp4`,
      status: 'AVAILABLE',
      uploadedBy: seed.appUserId,
      uploadedAt,
      deleteAfterDays: 30,
      deleteDaysAfterFirstPlay: 3,
      expiresAt: new Date(uploadedAt.getTime() + 30 * DAY),
      ...extra,
    })
    .returning({ id: engagementVideos.id });
  return v!.id;
}

async function insertIdentity(name: string, email: string): Promise<string> {
  const idRow = await harness.db.execute(
    sql`INSERT INTO portal_identity (firm_id, full_name, primary_email)
        VALUES (${seed.firmId}, ${name}, ${email}) RETURNING id`,
  );
  const id = (idRow as unknown as { rows: { id: string }[] }).rows[0]!.id;
  await harness.db.execute(
    sql`INSERT INTO client_portal_access (portal_identity_id, client_id, status)
        VALUES (${id}, ${seed.clientId}, 'ACTIVE')`,
  );
  return id;
}

beforeEach(async () => {
  sealDir = await mkdtemp(join(tmpdir(), 'vibe-pvid-'));
  process.env['FIRM_KEY_SEAL_PATH'] = join(sealDir, '.firm-key.seal');
  resetFirmKeyManagerForTests();
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  identityId = await insertIdentity('Client Tom', 'tom@client.example');
  otherIdentityId = await insertIdentity('Client Ann', 'ann@client.example');
  const mgr = getFirmKeyManager(harness.db);
  await mgr.bootstrap({ firmId: seed.firmId, mode: 'sealed-on-disk' });
  setApplianceLockState({ kind: 'unlocked', firmId: seed.firmId });
});

afterEach(async () => {
  resetFirmKeyManagerForTests();
  await harness.close();
  await rm(sealDir, { recursive: true, force: true });
});

describe('portal videos', () => {
  it('lists only AVAILABLE videos in scope with a per-identity played flag', async () => {
    const shown = await insertVideo();
    await insertVideo({ status: 'EXPIRED', title: 'Old' });
    await insertVideo({ status: 'PENDING_UPLOAD', title: 'Pending' });
    await insertVideo({ status: 'DELETED', title: 'Gone', deletedAt: new Date() });

    const res = await request(app()).get('/videos');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      id: shown,
      engagementName: 'Test Engagement',
      playedByMe: false,
      title: 'Return walkthrough',
    });
    expect(res.body.items[0].clientName).toBeUndefined();
    expect(res.body.items[0].storageKey).toBeUndefined();

    await request(app()).post(`/videos/${shown}/plays`).send({});
    const after = await request(app()).get('/videos');
    expect(after.body.items[0].playedByMe).toBe(true);
    const other = await request(app({ identity: otherIdentityId })).get('/videos');
    expect(other.body.items[0].playedByMe).toBe(false);
  });

  it('metadata: 404 outside scope, 410 when expired', async () => {
    const id = await insertVideo();
    const ok = await request(app()).get(`/videos/${id}`);
    expect(ok.status).toBe(200);
    expect(ok.body.video.id).toBe(id);

    await harness.db
      .update(engagementVideos)
      .set({ status: 'EXPIRED' })
      .where(eq(engagementVideos.id, id));
    const gone = await request(app()).get(`/videos/${id}`);
    expect(gone.status).toBe(410);

    const missing = await request(app()).get('/videos/00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBe(404);
  });

  it('stream: inline presigned URL, 410 once expired, rate limited', async () => {
    const id = await insertVideo();
    const res = await request(app()).get(`/videos/${id}/stream`);
    expect(res.status).toBe(200);
    expect(res.body.url).toContain('https://storage.example/get/');
    expect(res.body.mimeType).toBe('video/mp4');
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 5 * 3600 * 1000);

    await harness.db
      .update(engagementVideos)
      .set({ status: 'EXPIRED' })
      .where(eq(engagementVideos.id, id));
    const gone = await request(app()).get(`/videos/${id}/stream`);
    expect(gone.status).toBe(410);
  });

  it('stream: 429 after the hourly budget', async () => {
    const id = await insertVideo();
    const redis = fakeRedis();
    let last = 0;
    for (let i = 0; i < 61; i++) {
      last = (await request(app({ redis })).get(`/videos/${id}/stream`)).status;
    }
    expect(last).toBe(429);
  });

  it('first play stamps first_played_at, shortens expires_at, logs timeline; later plays do not', async () => {
    const uploadedAt = new Date(Date.now() - 2 * DAY);
    const id = await insertVideo({
      uploadedAt,
      expiresAt: new Date(uploadedAt.getTime() + 30 * DAY),
    });

    const first = await request(app())
      .post(`/videos/${id}/plays`)
      .set('user-agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile Safari')
      .send({ durationSeconds: 300 });
    expect(first.status).toBe(201);
    expect(first.body.firstPlay).toBe(true);
    const [v1] = await harness.db
      .select()
      .from(engagementVideos)
      .where(eq(engagementVideos.id, id));
    expect(v1?.firstPlayedAt).not.toBeNull();
    expect(v1?.playCount).toBe(1);
    const expectedExpiry = v1!.firstPlayedAt!.getTime() + 3 * DAY;
    expect(Math.abs(v1!.expiresAt!.getTime() - expectedExpiry)).toBeLessThan(1000);

    const [play] = await harness.db
      .select()
      .from(engagementVideoPlays)
      .where(eq(engagementVideoPlays.id, first.body.playId));
    expect(play?.portalIdentityId).toBe(identityId);
    expect(play?.deviceKind).toBe('mobile');
    expect(play?.durationSeconds).toBe(300);

    const timeline = await harness.db
      .select()
      .from(clientCommunications)
      .where(eq(clientCommunications.clientId, seed.clientId));
    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.channel).toBe('PORTAL');
    expect(timeline[0]?.relatedEntityId).toBe(id);
    expect(timeline[0]?.body).toContain('Client Tom');

    const second = await request(app({ identity: otherIdentityId }))
      .post(`/videos/${id}/plays`)
      .send({ deviceKind: 'desktop' });
    expect(second.status).toBe(201);
    expect(second.body.firstPlay).toBe(false);
    const [v2] = await harness.db
      .select()
      .from(engagementVideos)
      .where(eq(engagementVideos.id, id));
    expect(v2?.firstPlayedAt?.getTime()).toBe(v1?.firstPlayedAt?.getTime());
    expect(v2?.expiresAt?.getTime()).toBe(v1?.expiresAt?.getTime());
    expect(v2?.playCount).toBe(2);
    const timeline2 = await harness.db.select().from(clientCommunications);
    expect(timeline2).toHaveLength(1);
  });

  it('first play keeps the upload clock when it is still the earlier one', async () => {
    const uploadedAt = new Date(Date.now() - 29 * DAY);
    const id = await insertVideo({
      uploadedAt,
      expiresAt: new Date(uploadedAt.getTime() + 30 * DAY),
    });
    await request(app()).post(`/videos/${id}/plays`).send({});
    const [v] = await harness.db.select().from(engagementVideos).where(eq(engagementVideos.id, id));
    expect(v?.expiresAt?.getTime()).toBe(uploadedAt.getTime() + 30 * DAY);
  });

  it('impersonation sessions cannot log plays or reply', async () => {
    const id = await insertVideo();
    const play = await request(app({ impersonation: true }))
      .post(`/videos/${id}/plays`)
      .send({});
    expect(play.status).toBe(403);
    const reply = await request(app({ impersonation: true }))
      .post(`/videos/${id}/reply`)
      .send({ body: 'hi' });
    expect(reply.status).toBe(403);
    const stream = await request(app({ impersonation: true })).get(`/videos/${id}/stream`);
    expect(stream.status).toBe(200);
  });

  it('heartbeat: owner only, monotonic furthest, throttled, completion always lands', async () => {
    const id = await insertVideo();
    const start = await request(app()).post(`/videos/${id}/plays`).send({ durationSeconds: 100 });
    const playId = start.body.playId as string;

    const foreign = await request(app({ identity: otherIdentityId }))
      .patch(`/videos/${id}/plays/${playId}`)
      .send({ furthestSeconds: 10 });
    expect(foreign.status).toBe(404);

    // Within 3s of start → throttled.
    const early = await request(app())
      .patch(`/videos/${id}/plays/${playId}`)
      .send({ furthestSeconds: 10 });
    expect(early.body.throttled).toBe(true);

    await harness.db
      .update(engagementVideoPlays)
      .set({ lastHeartbeatAt: new Date(Date.now() - 10_000) })
      .where(eq(engagementVideoPlays.id, playId));
    const hb = await request(app())
      .patch(`/videos/${id}/plays/${playId}`)
      .send({ furthestSeconds: 40 });
    expect(hb.status).toBe(200);
    expect(hb.body.furthestSeconds).toBe(40);
    expect(hb.body.progressPct).toBe(40);

    await harness.db
      .update(engagementVideoPlays)
      .set({ lastHeartbeatAt: new Date(Date.now() - 10_000) })
      .where(eq(engagementVideoPlays.id, playId));
    const back = await request(app())
      .patch(`/videos/${id}/plays/${playId}`)
      .send({ furthestSeconds: 20 });
    expect(back.body.furthestSeconds).toBe(40);

    const done = await request(app())
      .patch(`/videos/${id}/plays/${playId}`)
      .send({ furthestSeconds: 95, completed: true });
    expect(done.body.completed).toBe(true);
    expect(done.body.progressPct).toBe(100);
    const [v] = await harness.db
      .select({ maxProgressPct: engagementVideos.maxProgressPct })
      .from(engagementVideos)
      .where(eq(engagementVideos.id, id));
    expect(v?.maxProgressPct).toBe(100);
  });

  it('reply creates the engagement thread on first use, tags the message, notifies staff; second reply reuses it', async () => {
    const id = await insertVideo();
    const before = await request(app()).get(`/videos/${id}/messages`);
    expect(before.body).toEqual({ threadId: null, items: [] });

    const r1 = await request(app())
      .post(`/videos/${id}/reply`)
      .send({ body: 'Thanks — one question about line 12.' });
    expect(r1.status).toBe(201);
    const threadId = r1.body.threadId as string;

    const [link] = await harness.db
      .select()
      .from(engagementThreadLinks)
      .where(eq(engagementThreadLinks.engagementId, seed.engagementId));
    expect(link?.threadId).toBe(threadId);

    const members = await harness.db
      .select()
      .from(threadMembers)
      .where(eq(threadMembers.threadId, threadId));
    const portalMembers = members.filter((m) => m.portalIdentityId).map((m) => m.portalIdentityId);
    expect(portalMembers.sort()).toEqual([identityId, otherIdentityId].sort());
    // Fallback routing: partner-in-charge (seed user) gets the thread.
    expect(members.some((m) => m.appUserId === seed.appUserId)).toBe(true);

    const [msg] = await harness.db
      .select()
      .from(messages)
      .where(eq(messages.id, r1.body.messageId));
    expect(msg?.engagementVideoId).toBe(id);
    expect(msg?.senderPortalIdentityId).toBe(identityId);

    const notes = await harness.db
      .select()
      .from(staffNotifications)
      .where(eq(staffNotifications.entityId, threadId));
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0]?.title).toContain('Return walkthrough');
    expect(notes[0]?.actionUrl).toBe(`/engagements/${seed.engagementId}`);

    const r2 = await request(app({ identity: otherIdentityId }))
      .post(`/videos/${id}/reply`)
      .send({ body: 'Same question here.' });
    expect(r2.status).toBe(201);
    expect(r2.body.threadId).toBe(threadId);

    const convo = await request(app()).get(`/videos/${id}/messages`);
    expect(convo.status).toBe(200);
    expect(convo.body.threadId).toBe(threadId);
    expect(convo.body.items).toHaveLength(2);
    expect(convo.body.items[0]).toMatchObject({
      body: 'Thanks — one question about line 12.',
      senderName: 'Client Tom',
      senderKind: 'client',
      mine: true,
      aboutThisVideo: true,
    });
    expect(convo.body.items[1].mine).toBe(false);
  });

  it('reply is refused on deleted videos and validates the body', async () => {
    const id = await insertVideo({ status: 'DELETED', deletedAt: new Date() });
    const res = await request(app()).post(`/videos/${id}/reply`).send({ body: 'x' });
    expect(res.status).toBe(404);
    const live = await insertVideo();
    const empty = await request(app()).post(`/videos/${live}/reply`).send({ body: '   ' });
    expect(empty.status).toBe(400);
  });
});

describe('deviceKindFromUserAgent', () => {
  it('classifies common agents', () => {
    expect(deviceKindFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile Safari')).toBe(
      'mobile',
    );
    expect(deviceKindFromUserAgent('Mozilla/5.0 (iPad; CPU OS 17_0) Safari')).toBe('tablet');
    expect(deviceKindFromUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Chrome')).toBe(
      'mobile',
    );
    expect(deviceKindFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome')).toBe(
      'desktop',
    );
    expect(deviceKindFromUserAgent(null)).toBe('unknown');
  });
});
