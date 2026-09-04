// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0235 — engagement video expiry sweep.
//
// engagement_video.expires_at is materialised by the API (earlier of
// uploaded_at + delete_after_days and first_played_at +
// delete_days_after_first_play). This tick deletes the storage object
// for every AVAILABLE video whose clock has run out and flips the row to
// EXPIRED. The row — title, dates, play log, replies — is kept so staff
// still see what was sent and whether it was watched (D10).
//
// Runs hourly: the play clock can be as short as one day, so a nightly
// sweep would leave a "deleted" video streamable for most of a day.
// Storage delete is best-effort and idempotent; a failure is logged and
// the row still expires (the object is unreachable anyway once the
// portal stops presigning it).

import { and, eq, isNotNull, lte } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import { auditLog, engagementVideos } from '@vibe/db/schema';
import type { StorageClient } from '@vibe/storage';

const DEFAULT_BATCH_SIZE = 500;

export interface VideoExpiryResult {
  scanned: number;
  expired: number;
  storageErrors: number;
}

export async function runEngagementVideoExpiry(
  db: Database,
  storage: StorageClient | null,
  log: Logger,
  now = new Date(),
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<VideoExpiryResult> {
  const due = await db
    .select({
      id: engagementVideos.id,
      firmId: engagementVideos.firmId,
      storageKey: engagementVideos.storageKey,
      expiresAt: engagementVideos.expiresAt,
    })
    .from(engagementVideos)
    .where(
      and(
        eq(engagementVideos.status, 'AVAILABLE'),
        isNotNull(engagementVideos.expiresAt),
        lte(engagementVideos.expiresAt, now),
      ),
    )
    .limit(batchSize);

  let expired = 0;
  let storageErrors = 0;
  let reprieved = 0;
  const expiredIds: string[] = [];
  for (const row of due) {
    // Flip FIRST, and re-check the clock in the predicate. Staff can extend
    // retention between our SELECT and this row's turn; deleting the object
    // before checking destroyed a video they had just extended, and the old
    // status-only guard still marked it EXPIRED with a future expires_at.
    const flipped = await db
      .update(engagementVideos)
      .set({ status: 'EXPIRED', expiredAt: now, updatedAt: now })
      .where(
        and(
          eq(engagementVideos.id, row.id),
          eq(engagementVideos.status, 'AVAILABLE'),
          lte(engagementVideos.expiresAt, now),
        ),
      )
      .returning({ id: engagementVideos.id });
    if (flipped.length === 0) {
      reprieved += 1;
      continue;
    }
    expired += 1;
    expiredIds.push(row.id);
    // Best-effort: the row is already EXPIRED so the portal will 410 even
    // if the object outlives it.
    if (storage) {
      try {
        await storage.delete(row.storageKey);
      } catch (err) {
        storageErrors += 1;
        log.warn(
          { err, videoId: row.id, storageKey: row.storageKey },
          'engagement-video-expiry: storage delete failed; row already expired',
        );
      }
    }
  }

  if (expiredIds.length > 0) {
    // One audit row per tick (batched) — 500 individual inserts on a busy
    // firm would be noise; the ids are in after_json.
    await db
      .insert(auditLog)
      .values({
        action: 'ARCHIVE',
        entityType: 'engagement_video',
        entityId: null,
        beforeJson: { status: 'AVAILABLE' },
        afterJson: { status: 'EXPIRED', videoIds: expiredIds, at: now.toISOString() },
      })
      .catch((err: unknown) => log.error({ err }, 'engagement-video-expiry: audit emit failed'));
  }

  log.info(
    { scanned: due.length, expired, reprieved, storageErrors, at: now.toISOString() },
    'engagement-video-expiry tick complete',
  );
  return { scanned: due.length, expired, storageErrors };
}
