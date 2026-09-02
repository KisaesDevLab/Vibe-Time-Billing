// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Twilio webhook signature validation, shared by the appointment
// reminder webhooks (0121) and the two-way SMS inbox (0233). Kept zod-free
// so the worker bundle can import it. No SDK: Twilio's scheme is
// base64(HMAC-SHA1(authToken, fullUrl + concat(sorted key+value))).
//
// Behind a reverse proxy the URL Twilio signed is the PUBLIC one, so
// callers reconstruct candidates from configured base URLs (never from
// the internal request host) and try each.

import crypto from 'node:crypto';

import type { Database } from '@vibe/db';
import { firmSettings } from '@vibe/db/schema';

import { crypto as core } from '@vibe/core';

interface StoredTwilioish {
  provider?: string;
  authToken?: string;
}

/** Decrypt every firm's stored SMS + VOICE configs and collect Twilio auth
 *  tokens for signature verification (both are configured in the DB, not
 *  env). Single-firm appliance → usually one of each. Best-effort; skips
 *  undecryptable rows. Zod-free decrypt so the worker can use it too. */
export async function loadFirmTwilioAuthTokens(db: Database): Promise<string[]> {
  const keyRaw = process.env['KMS_KEY'];
  if (!keyRaw) return [];
  let key: Buffer;
  try {
    key = core.resolveKey(keyRaw);
  } catch {
    return [];
  }
  const rows = await db
    .select({
      enc: firmSettings.smsConfigEncrypted,
      voiceEnc: firmSettings.voiceConfigEncrypted,
    })
    .from(firmSettings);
  const out: string[] = [];
  for (const r of rows) {
    for (const env of [r.enc, r.voiceEnc]) {
      if (!env) continue;
      try {
        const cfg = core.decryptJson<StoredTwilioish>(env, key);
        if (cfg.authToken && (cfg.provider === 'twilio' || cfg.provider === undefined)) {
          out.push(cfg.authToken);
        }
      } catch {
        /* skip rows we can't decrypt */
      }
    }
  }
  return out;
}

/** Twilio request validation: base64(HMAC-SHA1(token, fullUrl + sorted k+v of POST params)). */
export function twilioSignatureValid(
  tokens: string[],
  fullUrl: string,
  params: Record<string, string>,
  header: string | undefined,
): boolean {
  if (!header || tokens.length === 0) return false;
  const sorted = Object.keys(params).sort();
  let data = fullUrl;
  for (const k of sorted) data += k + params[k];
  for (const token of tokens) {
    if (!token) continue;
    const expected = crypto.createHmac('sha1', token).update(data, 'utf8').digest('base64');
    // Constant-time compare on equal-length buffers.
    const a = Buffer.from(expected);
    const b = Buffer.from(header);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

/** Sign the way Twilio does — for tests and fixtures. */
export function signTwilioRequest(
  token: string,
  fullUrl: string,
  params: Record<string, string>,
): string {
  const sorted = Object.keys(params).sort();
  let data = fullUrl;
  for (const k of sorted) data += k + params[k];
  return crypto.createHmac('sha1', token).update(data, 'utf8').digest('base64');
}

/**
 * Candidate public URLs for one request. Twilio signs exactly the URL the
 * firm pasted into the console, so we try each configured base (firm
 * override → PUBLIC_BASE_URL → APP_BASE_URL) with and without an explicit
 * default port — Twilio historically normalizes ports inconsistently.
 */
export function twilioUrlCandidates(
  bases: Array<string | null | undefined>,
  path: string,
): string[] {
  const out = new Set<string>();
  for (const raw of bases) {
    if (!raw) continue;
    const base = raw.trim().replace(/\/+$/, '');
    if (!base) continue;
    out.add(base + path);
    try {
      const u = new URL(base);
      const defaultPort = u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : '';
      if (u.port) {
        if (u.port === defaultPort) out.add(`${u.protocol}//${u.hostname}${path}`);
      } else if (defaultPort) {
        out.add(`${u.protocol}//${u.hostname}:${defaultPort}${path}`);
      }
    } catch {
      /* not a URL — keep the literal candidate only */
    }
  }
  return [...out];
}

/** Returns the matching candidate URL, or null when no (token, url) pair verifies. */
export function findValidTwilioUrl(
  tokens: string[],
  candidates: string[],
  params: Record<string, string>,
  header: string | undefined,
): string | null {
  for (const url of candidates) {
    if (twilioSignatureValid(tokens, url, params, header)) return url;
  }
  return null;
}

/**
 * Cached token resolver for a router: env tokens + the firm's DB tokens,
 * refreshed every 30 s so a credential change takes effect without a
 * restart but webhooks don't decrypt per request.
 */
export function createTwilioTokenResolver(opts: {
  db: Database | null;
  envTokens?: string[];
  /** test seam — bypasses env + DB entirely */
  authTokens?: string[];
  now?: () => number;
  ttlMs?: number;
}): () => Promise<string[]> {
  const envTokens = (
    opts.envTokens ?? [process.env['SMS_TWILIO_AUTH_TOKEN'], process.env['VOICE_TWILIO_AUTH_TOKEN']]
  ).filter((t): t is string => Boolean(t));
  const now = opts.now ?? ((): number => Date.now());
  const ttl = opts.ttlMs ?? 30_000;
  let cache: { at: number; tokens: string[] } | null = null;
  return async () => {
    if (opts.authTokens) return opts.authTokens;
    const t = now();
    if (!cache || t - cache.at > ttl) {
      cache = { at: t, tokens: opts.db ? await loadFirmTwilioAuthTokens(opts.db) : [] };
    }
    return [...envTokens, ...cache.tokens];
  };
}
