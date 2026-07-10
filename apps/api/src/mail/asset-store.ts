// SPDX-License-Identifier: Elastic-2.0
//
// In-memory store backing EmailIt URL attachments (opt-in via
// MAIL_EMAILIT_ATTACHMENT_MODE=url). A send stashes the rendered PDF /
// ICS bytes here and hands EmailIt a short-lived, unguessable URL
// (served by ./asset-routes on /api/mail-assets/:token) instead of a
// base64 body; EmailIt's servers fetch it at send time.
//
// The token is the credential — 32 random bytes hex — mirroring the
// pay-by-link (/api/pay/:token) pattern. Entries expire after a TTL
// generous enough to cover EmailIt's queueing, are NOT single-use
// (their fetcher may retry), and the store is capped so a runaway bulk
// loop can't hold the heap hostage: oldest entries evict first. Being
// process-memory, stashed assets don't survive an API restart — an
// acceptable trade for a mode whose worst case is a missing attachment
// on an email that still delivers.

import { randomBytes } from 'node:crypto';

import type { MailAttachment } from './provider';

export interface MailAssetStoreOptions {
  /** Public origin the route is reachable on (e.g. https://portal.firm.com). */
  baseUrl: string;
  /** How long a stashed asset stays fetchable. Default 30 minutes. */
  ttlMs?: number;
  /** Max concurrent entries; oldest evicted beyond this. Default 500. */
  maxEntries?: number;
  /** Injectable clock for tests. */
  nowImpl?: () => number;
}

export interface MailAsset {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface MailAssetStore {
  /** Stash attachment bytes; returns the absolute public URL. */
  stash(att: MailAttachment): string;
  /** Fetch a live (non-expired) asset, or null. Not single-use. */
  get(token: string): MailAsset | null;
  size(): number;
}

const DEFAULT_TTL_MS = 30 * 60_000;
const DEFAULT_MAX_ENTRIES = 500;

export function createMailAssetStore(opts: MailAssetStoreOptions): MailAssetStore {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = opts.nowImpl ?? Date.now;
  const base = opts.baseUrl.replace(/\/$/, '');
  const entries = new Map<string, MailAsset & { expiresAt: number }>();

  function sweep(): void {
    const t = now();
    for (const [token, e] of entries) {
      if (e.expiresAt <= t) entries.delete(token);
    }
  }

  return {
    stash(att) {
      sweep();
      // Map iteration is insertion-ordered, so the first key is the oldest.
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next().value as string | undefined;
        if (!oldest) break;
        entries.delete(oldest);
      }
      const token = randomBytes(32).toString('hex');
      entries.set(token, {
        filename: att.filename,
        contentType: att.contentType ?? 'application/octet-stream',
        content: att.content,
        expiresAt: now() + ttlMs,
      });
      return `${base}/api/mail-assets/${token}`;
    },
    get(token) {
      sweep();
      const e = entries.get(token);
      if (!e) return null;
      return { filename: e.filename, contentType: e.contentType, content: e.content };
    },
    size() {
      sweep();
      return entries.size;
    },
  };
}
