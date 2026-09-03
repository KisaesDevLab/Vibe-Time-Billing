// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditLog, engagementVideos } from '@vibe/db/schema';
import type { StorageClient } from '@vibe/storage';

import {
  buildPgliteHarness,
  seedMinimalFirm,
  type PgliteHarness,
} from '../../../api/src/__tests__/_pglite-harness';
import { runEngagementVideoExpiry } from '../jobs/engagement-video-expiry';
import { runPendingVideoUploadSweep } from '../jobs/pending-upload-sweep';

const silent = pino({ enabled: false });
const DAY = 24 * 3600 * 1000;
let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let deleted: string[];
let failDelete: boolean;

function storage(): StorageClient {
  return {
    kind: 'mock',
    delete: async (key: string) => {
      if (failDelete) throw new Error('boom');
      deleted.push(key);
    },
  } as unknown as StorageClient;
}

async function insertVideo(opts: {
  status?: 'PENDING_UPLOAD' | 'AVAILABLE' | 'EXPIRED';
  expiresAt?: Date | null;
  uploadedAt?: Date;
  title?: string;
}): Promise<{ id: string; storageKey: string }> {
  const storageKey = `system/engagement-videos/${seed.firmId}/${seed.engagementId}/${crypto.randomUUID()}/v.mp4`;
  const [v] = await harness.db
    .insert(engagementVideos)
    .values({
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      clientId: seed.clientId,
      title: opts.title ?? 'Video',
      originalFilename: 'v.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 10,
      storageKey,
      status: opts.status ?? 'AVAILABLE',
      uploadedAt: opts.uploadedAt ?? new Date(),
      expiresAt: opts.expiresAt === undefined ? null : opts.expiresAt,
    })
    .returning({ id: engagementVideos.id });
  return { id: v!.id, storageKey };
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  deleted = [];
  failDelete = false;
});
afterEach(async () => {
  await harness.close();
});

describe('runEngagementVideoExpiry', () => {
  it('expires due videos, deletes their objects, leaves others alone, and audits once', async () => {
    const now = new Date();
    const due = await insertVideo({ expiresAt: new Date(now.getTime() - 1000), title: 'Due' });
    const future = await insertVideo({ expiresAt: new Date(now.getTime() + DAY), title: 'Future' });
    const noClock = await insertVideo({ expiresAt: null, title: 'NoClock' });
    const already = await insertVideo({
      status: 'EXPIRED',
      expiresAt: new Date(now.getTime() - DAY),
      title: 'Already',
    });

    const r = await runEngagementVideoExpiry(harness.db, storage(), silent, now);
    expect(r).toEqual({ scanned: 1, expired: 1, storageErrors: 0 });
    expect(deleted).toEqual([due.storageKey]);

    const rows = await harness.db.select().from(engagementVideos);
    const byId = new Map(rows.map((x) => [x.id, x]));
    expect(byId.get(due.id)?.status).toBe('EXPIRED');
    expect(byId.get(due.id)?.expiredAt).not.toBeNull();
    expect(byId.get(future.id)?.status).toBe('AVAILABLE');
    expect(byId.get(noClock.id)?.status).toBe('AVAILABLE');
    expect(byId.get(already.id)?.status).toBe('EXPIRED');

    const audits = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityType, 'engagement_video'));
    expect(audits).toHaveLength(1);
    expect((audits[0]?.afterJson as { videoIds: string[] }).videoIds).toEqual([due.id]);

    // Second tick is a no-op.
    const again = await runEngagementVideoExpiry(harness.db, storage(), silent, now);
    expect(again.expired).toBe(0);
  });

  it('still expires the row when the storage delete fails', async () => {
    failDelete = true;
    const due = await insertVideo({ expiresAt: new Date(Date.now() - 1000) });
    const r = await runEngagementVideoExpiry(harness.db, storage(), silent);
    expect(r.storageErrors).toBe(1);
    expect(r.expired).toBe(1);
    const [row] = await harness.db
      .select()
      .from(engagementVideos)
      .where(eq(engagementVideos.id, due.id));
    expect(row?.status).toBe('EXPIRED');
  });

  it('works without a storage client (row flips, nothing deleted)', async () => {
    await insertVideo({ expiresAt: new Date(Date.now() - 1000) });
    const r = await runEngagementVideoExpiry(harness.db, null, silent);
    expect(r.expired).toBe(1);
    expect(deleted).toEqual([]);
  });
});

describe('runPendingVideoUploadSweep', () => {
  it('hard-deletes stale reservations only', async () => {
    const stale = await insertVideo({
      status: 'PENDING_UPLOAD',
      uploadedAt: new Date(Date.now() - 3 * 3600 * 1000),
    });
    const fresh = await insertVideo({
      status: 'PENDING_UPLOAD',
      uploadedAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    const live = await insertVideo({
      status: 'AVAILABLE',
      uploadedAt: new Date(Date.now() - 3 * 3600 * 1000),
    });
    const r = await runPendingVideoUploadSweep(harness.db, storage(), silent);
    expect(r.deleted).toBe(1);
    expect(deleted).toEqual([stale.storageKey]);
    const ids = (await harness.db.select({ id: engagementVideos.id }).from(engagementVideos)).map(
      (x) => x.id,
    );
    expect(ids.sort()).toEqual([fresh.id, live.id].sort());
  });
});
