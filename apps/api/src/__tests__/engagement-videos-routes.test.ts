// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditLog, engagementVideos, firmSettings } from '@vibe/db/schema';
import type { RoleSlug } from '@vibe/core/rbac';
import type { StorageClient, StorageObjectMeta } from '@vibe/storage';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import {
  MAX_VIDEO_BYTES,
  createEngagementVideoRouters,
  type VideoReadyEvent,
} from '../engagements/videos';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let objects: Map<string, StorageObjectMeta>;
let deleted: string[];
let ready: VideoReadyEvent[];
let onReadyThrows = false;

function fakeStorage(): StorageClient {
  return {
    kind: 'mock',
    head: async (key: string) => objects.get(key) ?? null,
    delete: async (key: string) => {
      deleted.push(key);
      objects.delete(key);
    },
    presignPut: async (key: string) => `https://storage.example/put/${encodeURIComponent(key)}`,
    presignGet: async (key: string) => `https://storage.example/get/${encodeURIComponent(key)}`,
  } as unknown as StorageClient;
}

function app(userId = seed.appUserId, roles: RoleSlug[] = ['admin']) {
  const a = express();
  a.use(express.json());
  a.use((req: Request, _res: Response, next: NextFunction) => {
    req.staffSession = { firmId: seed.firmId, appUserId: userId } as never;
    next();
  });
  const r = createEngagementVideoRouters({
    db: harness.db,
    storageClient: fakeStorage(),
    fakeUserRoles: new Map([[userId, roles]]),
    onVideoReady: async (e) => {
      if (onReadyThrows) throw new Error('redis_down');
      ready.push(e);
    },
  });
  a.use('/engagements', r.engagementScoped);
  a.use('/videos', r.byId);
  a.use('/clients', r.clientScoped);
  return a;
}

const reserveBody = {
  title: 'Your 2025 return walkthrough',
  message: 'Watch before our call.',
  originalFilename: 'walkthrough.mp4',
  mimeType: 'video/mp4',
  sizeBytes: 1024 * 1024,
};

async function reserve(extra: Record<string, unknown> = {}) {
  const res = await request(app())
    .post(`/engagements/${seed.engagementId}/videos`)
    .send({ ...reserveBody, ...extra });
  expect(res.status).toBe(201);
  return res.body as { videoId: string; storageKey: string; uploadUrl: string };
}

async function land(storageKey: string, sizeBytes = reserveBody.sizeBytes) {
  objects.set(storageKey, { key: storageKey, sizeBytes, etag: 'etag-1', lastModified: new Date() });
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  await harness.db.execute(sql`INSERT INTO firm_settings (firm_id) VALUES (${seed.firmId})`);
  objects = new Map();
  deleted = [];
  ready = [];
  onReadyThrows = false;
});

afterEach(async () => {
  await harness.close();
});

describe('engagement videos — staff routes', () => {
  it('reserves a pending upload with firm default clocks and a presigned URL', async () => {
    const r = await reserve();
    expect(r.uploadUrl).toContain('https://storage.example/put/');
    expect(r.storageKey).toMatch(
      new RegExp(
        `^system/engagement-videos/${seed.firmId}/${seed.engagementId}/${r.videoId}/walkthrough.mp4$`,
      ),
    );
    const [row] = await harness.db
      .select()
      .from(engagementVideos)
      .where(eq(engagementVideos.id, r.videoId));
    expect(row?.status).toBe('PENDING_UPLOAD');
    expect(row?.clientId).toBe(seed.clientId);
    expect(row?.deleteAfterDays).toBe(30);
    expect(row?.deleteDaysAfterFirstPlay).toBe(3);
    expect(row?.notifyClient).toBe(true);
    expect(row?.expiresAt).toBeNull();
  });

  it('honours explicit per-video clocks including null (disabled)', async () => {
    const r = await reserve({ deleteAfterDays: 7, deleteDaysAfterFirstPlay: null });
    const [row] = await harness.db
      .select()
      .from(engagementVideos)
      .where(eq(engagementVideos.id, r.videoId));
    expect(row?.deleteAfterDays).toBe(7);
    expect(row?.deleteDaysAfterFirstPlay).toBeNull();
  });

  it('rejects unsupported mime types and oversize files', async () => {
    const bad = await request(app())
      .post(`/engagements/${seed.engagementId}/videos`)
      .send({ ...reserveBody, mimeType: 'video/x-msvideo' });
    expect(bad.status).toBe(400);
    const big = await request(app())
      .post(`/engagements/${seed.engagementId}/videos`)
      .send({ ...reserveBody, sizeBytes: MAX_VIDEO_BYTES + 1 });
    expect(big.status).toBe(400);
  });

  it('404s for an engagement outside the firm', async () => {
    const res = await request(app())
      .post(`/engagements/00000000-0000-4000-8000-000000000000/videos`)
      .send(reserveBody);
    expect(res.status).toBe(404);
  });

  it('complete: 409 until the object lands, then AVAILABLE with expires_at = upload + N', async () => {
    const r = await reserve();
    const early = await request(app()).post(`/videos/${r.videoId}/complete`).send({});
    expect(early.status).toBe(409);
    expect(early.body.error).toBe('object_not_yet_landed');

    await land(r.storageKey, 2048);
    const done = await request(app()).post(`/videos/${r.videoId}/complete`).send({});
    expect(done.status).toBe(200);
    expect(done.body.video.status).toBe('AVAILABLE');
    expect(done.body.video.sizeBytes).toBe(2048);
    const uploadedAt = new Date(done.body.video.uploadedAt).getTime();
    const expiresAt = new Date(done.body.video.expiresAt).getTime();
    expect(expiresAt - uploadedAt).toBe(30 * 24 * 3600 * 1000);

    // Notification hook fired exactly once and notified_at is stamped.
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({
      videoId: r.videoId,
      engagementId: seed.engagementId,
      clientId: seed.clientId,
      title: reserveBody.title,
    });
    expect(done.body.video.notifiedAt).not.toBeNull();

    // Idempotent.
    const again = await request(app()).post(`/videos/${r.videoId}/complete`).send({});
    expect(again.status).toBe(200);
    expect(again.body.alreadyComplete).toBe(true);
    expect(ready).toHaveLength(1);
  });

  it('complete: does not notify when notifyClient is false', async () => {
    const r = await reserve({ notifyClient: false });
    await land(r.storageKey);
    const done = await request(app()).post(`/videos/${r.videoId}/complete`).send({});
    expect(done.status).toBe(200);
    expect(ready).toHaveLength(0);
    expect(done.body.video.notifiedAt).toBeNull();
  });

  it('complete: rejects an object larger than the cap and removes it', async () => {
    const r = await reserve();
    await land(r.storageKey, MAX_VIDEO_BYTES + 1);
    const done = await request(app()).post(`/videos/${r.videoId}/complete`).send({});
    expect(done.status).toBe(413);
    expect(deleted).toContain(r.storageKey);
    const rows = await harness.db
      .select()
      .from(engagementVideos)
      .where(eq(engagementVideos.id, r.videoId));
    expect(rows).toHaveLength(0);
  });

  it('lists videos for the engagement and the client roll-up, newest first', async () => {
    const a = await reserve({ title: 'First' });
    await land(a.storageKey);
    await request(app()).post(`/videos/${a.videoId}/complete`).send({});
    const b = await reserve({ title: 'Second' });

    const list = await request(app()).get(`/engagements/${seed.engagementId}/videos`);
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: { title: string }) => i.title)).toEqual(['Second', 'First']);
    expect(list.body.items[1].replyCount).toBe(0);

    const roll = await request(app()).get(`/clients/${seed.clientId}/videos`);
    expect(roll.status).toBe(200);
    expect(roll.body.items).toHaveLength(2);
    expect(roll.body.items[0].engagementName).toBe('Test Engagement');
    expect(roll.body.items[0].id).toBe(b.videoId);
  });

  it('patch recomputes expires_at and refuses expired videos', async () => {
    const r = await reserve();
    await land(r.storageKey);
    await request(app()).post(`/videos/${r.videoId}/complete`).send({});

    const patched = await request(app())
      .patch(`/videos/${r.videoId}`)
      .send({ title: 'Renamed', deleteAfterDays: 60 });
    expect(patched.status).toBe(200);
    expect(patched.body.video.title).toBe('Renamed');
    const uploadedAt = new Date(patched.body.video.uploadedAt).getTime();
    expect(new Date(patched.body.video.expiresAt).getTime() - uploadedAt).toBe(
      60 * 24 * 3600 * 1000,
    );

    const off = await request(app()).patch(`/videos/${r.videoId}`).send({ deleteAfterDays: null });
    expect(off.body.video.expiresAt).toBeNull();

    await harness.db
      .update(engagementVideos)
      .set({ status: 'EXPIRED' })
      .where(eq(engagementVideos.id, r.videoId));
    const blocked = await request(app()).patch(`/videos/${r.videoId}`).send({ title: 'x' });
    expect(blocked.status).toBe(409);
  });

  it('delete removes the object, keeps the row as DELETED, and requires video:delete', async () => {
    const r = await reserve();
    await land(r.storageKey);
    await request(app()).post(`/videos/${r.videoId}/complete`).send({});

    const forbidden = await request(app(seed.appUserId, ['staff'])).delete(`/videos/${r.videoId}`);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.required).toBe('video:delete');

    const ok = await request(app()).delete(`/videos/${r.videoId}`);
    expect(ok.status).toBe(200);
    expect(deleted).toContain(r.storageKey);
    const [row] = await harness.db
      .select()
      .from(engagementVideos)
      .where(eq(engagementVideos.id, r.videoId));
    expect(row?.status).toBe('DELETED');
    expect(row?.deletedBy).toBe(seed.appUserId);

    const list = await request(app()).get(`/engagements/${seed.engagementId}/videos`);
    expect(list.body.items).toHaveLength(0);

    const audits = await harness.db
      .select({ action: auditLog.action, entityType: auditLog.entityType })
      .from(auditLog)
      .where(eq(auditLog.entityId, r.videoId));
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(['CREATE', 'UPDATE', 'ARCHIVE']),
    );
  });

  it('delete on a pending reservation hard-removes the row', async () => {
    const r = await reserve();
    const ok = await request(app()).delete(`/videos/${r.videoId}`);
    expect(ok.status).toBe(200);
    const rows = await harness.db
      .select()
      .from(engagementVideos)
      .where(eq(engagementVideos.id, r.videoId));
    expect(rows).toHaveLength(0);
  });

  it('staff role can upload but a reserve with an unknown firm default falls back to null', async () => {
    await harness.db
      .update(firmSettings)
      .set({ videoDefaultDeleteAfterDays: null })
      .where(eq(firmSettings.firmId, seed.firmId));
    const res = await request(app(seed.appUserId, ['staff']))
      .post(`/engagements/${seed.engagementId}/videos`)
      .send(reserveBody);
    expect(res.status).toBe(201);
    expect(res.body.deleteAfterDays).toBeNull();
    expect(res.body.deleteDaysAfterFirstPlay).toBe(3);
  });

  it('leaves notified_at unset and reports notifyFailed when staging throws', async () => {
    const r = await reserve();
    await land(r.storageKey);
    onReadyThrows = true;
    const done = await request(app()).post(`/videos/${r.videoId}/complete`).send({});
    expect(done.status).toBe(200);
    expect(done.body.notifyFailed).toBe(true);
    expect(done.body.video.status).toBe('AVAILABLE');
    // Stamping notified_at up front made a transient Redis failure look
    // like a delivered notification, forever.
    expect(done.body.video.notifiedAt).toBeNull();
  });

  it('plays endpoint returns the video summary and an empty log', async () => {
    const r = await reserve();
    const res = await request(app()).get(`/videos/${r.videoId}/plays`);
    expect(res.status).toBe(200);
    expect(res.body.video.id).toBe(r.videoId);
    expect(res.body.items).toEqual([]);
  });
});

describe('engagement videos — restricted clients (0165)', () => {
  let blockedUserId: string;

  beforeEach(async () => {
    const r = (await harness.db.execute(
      sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
          VALUES (${seed.firmId}, 'blocked@t.example', 'Blocked', 'B', 'K') RETURNING id`,
    )) as unknown as { rows: { id: string }[] };
    blockedUserId = r.rows[0]!.id;
    await harness.db.execute(sql`UPDATE client SET restricted = true WHERE id = ${seed.clientId}`);
  });

  function blocked() {
    return request(app(blockedUserId, ['staff']));
  }

  it('403s every staff video surface for a staffer without access', async () => {
    // Seeded as an admin so the fixture itself is not blocked.
    const v = await reserve();
    await land(v.storageKey);
    await request(app()).post(`/videos/${v.videoId}/complete`).send({});

    const list = await blocked().get(`/engagements/${seed.engagementId}/videos`);
    expect(list.status).toBe(403);
    expect(list.body.error).toBe('client_restricted');

    const rollup = await blocked().get(`/clients/${seed.clientId}/videos`);
    expect(rollup.status).toBe(403);

    // The play log names viewers and their email addresses.
    const plays = await blocked().get(`/videos/${v.videoId}/plays`);
    expect(plays.status).toBe(403);

    const upload = await blocked()
      .post(`/engagements/${seed.engagementId}/videos`)
      .send(reserveBody);
    expect(upload.status).toBe(403);

    const patched = await blocked().patch(`/videos/${v.videoId}`).send({ title: 'x' });
    expect(patched.status).toBe(403);

    const removed = await blocked().delete(`/videos/${v.videoId}`);
    expect(removed.status).toBe(403);
  });

  it('still allows the partner-in-charge of the restricted client', async () => {
    const partner = request(app(seed.appUserId, ['partner']));
    const list = await partner.get(`/engagements/${seed.engagementId}/videos`);
    expect(list.status).toBe(200);
  });
});
