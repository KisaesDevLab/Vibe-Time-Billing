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
/** Row status observed at the moment storage.delete was called. */
let statusAtDelete: Array<string | undefined>;

function storage(): StorageClient {
  return {
    kind: 'mock',
    delete: async (key: string) => {
      const [row] = await harness.db
        .select({ status: engagementVideos.status })
        .from(engagementVideos)
        .where(eq(engagementVideos.storageKey, key));
      statusAtDelete.push(row?.status);
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
  statusAtDelete = [];
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

  it('flips the row to EXPIRED before deleting the object', async () => {
    // Ordering matters: deleting first meant a retention extension landing
    // mid-tick destroyed a video staff had just extended, while the
    // status-only guard still marked it EXPIRED with a future expires_at.
    await insertVideo({ expiresAt: new Date(Date.now() - 1000) });
    const r = await runEngagementVideoExpiry(harness.db, storage(), silent);
    expect(r.expired).toBe(1);
    expect(statusAtDelete).toEqual(['EXPIRED']);
  });

  it('leaves a video alone when its clock moved into the future', async () => {
    const v = await insertVideo({ expiresAt: new Date(Date.now() - 1000) });
    // Model the extension by moving the clock out before the tick runs; the
    // update predicate re-checks expires_at, not just the status.
    await harness.db
      .update(engagementVideos)
      .set({ expiresAt: new Date(Date.now() + 30 * DAY) })
      .where(eq(engagementVideos.id, v.id));
    const r = await runEngagementVideoExpiry(harness.db, storage(), silent);
    expect(r.expired).toBe(0);
    expect(deleted).toEqual([]);
    const [row] = await harness.db
      .select()
      .from(engagementVideos)
      .where(eq(engagementVideos.id, v.id));
    expect(row?.status).toBe('AVAILABLE');
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
  it('hard-deletes abandoned reservations only', async () => {
    const stale = await insertVideo({
      status: 'PENDING_UPLOAD',
      uploadedAt: new Date(Date.now() - 13 * 3600 * 1000),
    });
    const fresh = await insertVideo({
      status: 'PENDING_UPLOAD',
      uploadedAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    const live = await insertVideo({
      status: 'AVAILABLE',
      uploadedAt: new Date(Date.now() - 13 * 3600 * 1000),
    });
    const r = await runPendingVideoUploadSweep(harness.db, storage(), silent);
    expect(r.deleted).toBe(1);
    expect(deleted).toEqual([stale.storageKey]);
    const ids = (await harness.db.select({ id: engagementVideos.id }).from(engagementVideos)).map(
      (x) => x.id,
    );
    expect(ids.sort()).toEqual([fresh.id, live.id].sort());
  });

  it('never sweeps an upload that could still be streaming', async () => {
    // uploaded_at is stamped when the PUT STARTS and a signed PUT keeps
    // going past its 60-minute expiry, so a 2 GB upload on a slow uplink is
    // still in flight hours later. The old 60-minute cutoff deleted the row
    // mid-transfer and orphaned the object.
    for (const hours of [1.5, 3, 8]) {
      const inFlight = await insertVideo({
        status: 'PENDING_UPLOAD',
        uploadedAt: new Date(Date.now() - hours * 3600 * 1000),
      });
      const r = await runPendingVideoUploadSweep(harness.db, storage(), silent);
      expect(r.deleted).toBe(0);
      const [row] = await harness.db
        .select()
        .from(engagementVideos)
        .where(eq(engagementVideos.id, inFlight.id));
      expect(row?.status).toBe('PENDING_UPLOAD');
      await harness.db.delete(engagementVideos).where(eq(engagementVideos.id, inFlight.id));
    }
    expect(deleted).toEqual([]);
  });
});
