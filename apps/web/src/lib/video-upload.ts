// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Pure helpers for the engagement-video upload dialog. Kept DOM-free so
// they unit-test under vitest's node environment (repo convention: test
// the logic, not the rendered component).

export const VIDEO_ACCEPT = 'video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm,.m4v';
export const VIDEO_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB (matches the API cap)

const ACCEPTED_MIME = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
const EXT_TO_MIME: Record<string, 'video/mp4' | 'video/quicktime' | 'video/webm'> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

/** Backoff schedule for POST /complete while the object propagates. */
export const COMPLETE_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 4000, 4000] as const;

export type FileLike = Pick<File, 'name' | 'type' | 'size'>;

export function fileExtension(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

/**
 * The MIME type to send to the API. Browsers report an empty `type` for
 * .mov on some platforms and `video/x-m4v` for .m4v, so the extension is
 * the tie-breaker. Returns null when the file is not a supported video.
 */
export function resolveVideoMime(
  file: FileLike,
): 'video/mp4' | 'video/quicktime' | 'video/webm' | null {
  const byExt = EXT_TO_MIME[fileExtension(file.name)];
  if (byExt) return byExt;
  if (ACCEPTED_MIME.has(file.type))
    return file.type as 'video/mp4' | 'video/quicktime' | 'video/webm';
  return null;
}

export function validateVideoFile(file: FileLike): string | null {
  if (!resolveVideoMime(file)) return 'Pick an MP4, MOV, or WebM video file.';
  if (file.size <= 0) return 'That file is empty.';
  if (file.size > VIDEO_MAX_BYTES) return 'Videos must be 2 GB or smaller.';
  return null;
}

export function isMovFile(file: FileLike): boolean {
  return fileExtension(file.name) === '.mov' || file.type === 'video/quicktime';
}

/** "walkthrough.mp4" → "walkthrough"; used to prefill the title. */
export function titleFromFilename(name: string): string {
  const ext = fileExtension(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  return base.replace(/[_-]+/g, ' ').trim();
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatAvailableUntil(expiresAt: string | null): string {
  if (!expiresAt) return 'No expiry';
  const d = new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return 'No expiry';
  return `Until ${d.toLocaleDateString()}`;
}

/** Whole-percent progress, clamped; null when unknown. */
export function progressPct(
  furthestSeconds: number | null | undefined,
  durationSeconds: number | null | undefined,
): number | null {
  if (furthestSeconds == null || !durationSeconds || durationSeconds <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((furthestSeconds / durationSeconds) * 100)));
}

export type VideoStatus = 'PENDING_UPLOAD' | 'AVAILABLE' | 'EXPIRED' | 'DELETED';

export interface VideoStatusPill {
  label: string;
  tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
}

export function videoStatusPill(v: {
  status: VideoStatus | string;
  firstPlayedAt: string | null;
}): VideoStatusPill {
  if (v.status === 'EXPIRED') return { label: 'Expired', tone: 'neutral' };
  if (v.status === 'DELETED') return { label: 'Deleted', tone: 'neutral' };
  if (v.status === 'PENDING_UPLOAD') return { label: 'Uploading…', tone: 'accent' };
  if (v.firstPlayedAt) {
    return { label: `Played ${new Date(v.firstPlayedAt).toLocaleDateString()}`, tone: 'success' };
  }
  return { label: 'Not played', tone: 'warning' };
}
