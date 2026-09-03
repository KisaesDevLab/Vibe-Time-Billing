// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Engagement-video retention clocks. A video expires on the EARLIER of
//   - uploadedAt   + deleteAfterDays
//   - firstPlayedAt + deleteDaysAfterFirstPlay   (only once it has been played)
// Either clock may be disabled (null). The result is stored on
// engagement_video.expires_at and recomputed at upload-complete, first
// play, and staff edit — never derived at query time, so the worker's
// expiry sweep is a plain indexed `expires_at <= now()` scan.
//
// Kept zod-free and dependency-free: the worker imports it too.

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface VideoExpiryInput {
  uploadedAt: Date;
  firstPlayedAt: Date | null;
  deleteAfterDays: number | null;
  deleteDaysAfterFirstPlay: number | null;
}

export function computeVideoExpiresAt(input: VideoExpiryInput): Date | null {
  const candidates: number[] = [];
  if (input.deleteAfterDays != null && input.deleteAfterDays > 0) {
    candidates.push(input.uploadedAt.getTime() + input.deleteAfterDays * DAY_MS);
  }
  if (
    input.firstPlayedAt &&
    input.deleteDaysAfterFirstPlay != null &&
    input.deleteDaysAfterFirstPlay > 0
  ) {
    candidates.push(input.firstPlayedAt.getTime() + input.deleteDaysAfterFirstPlay * DAY_MS);
  }
  if (candidates.length === 0) return null;
  return new Date(Math.min(...candidates));
}

/** Furthest point watched as a whole percentage, clamped to 0..100. */
export function videoProgressPct(
  furthestSeconds: number | null | undefined,
  durationSeconds: number | null | undefined,
): number | null {
  if (furthestSeconds == null || durationSeconds == null || durationSeconds <= 0) return null;
  const pct = Math.round((furthestSeconds / durationSeconds) * 100);
  return Math.max(0, Math.min(100, pct));
}
