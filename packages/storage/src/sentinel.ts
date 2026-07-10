// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Sentinel file (_Vibe/client.json) helpers.
//
// The sentinel is the source of truth for "which client does this
// folder belong to". The sync worker uses it to re-bind a folder
// after a File-Explorer rename, and to detect orphans (sentinel
// pointing at a client that's not in this firm) or conflicts
// (two folders carrying the same client_id).
//
// Invariants enforced here:
//   - `version` is locked to 1 — bumps require a code-level migration.
//   - `client_id` is immutable through updateSentinel(); attempts to
//     change it via a partial payload are rejected. Re-binding to a
//     different client must go through the onboarding/bind flow,
//     which deletes the old sentinel before writing a fresh one.
//   - `firm_id` is captured at creation time so the worker can detect
//     a sentinel that was copied in from a different firm (orphan).
//
// See FILE_MANAGER_ADDENDUM.md §3.1 for the schema and §4 Phase 2 for
// the helper contract.

import type { Readable } from 'node:stream';

import { z } from 'zod';

import type { StorageClient } from './client';
import { joinPath } from './paths';

export const SENTINEL_FOLDER_DEFAULT = '_Vibe';
export const SENTINEL_FILE_DEFAULT = 'client.json';

/**
 * v1 sentinel payload. `created_by` is nullable because the
 * onboarding path may bind a folder before any user has claimed it
 * (system-driven match).
 */
export const SentinelV1 = z.object({
  version: z.literal(1),
  client_id: z.string().uuid(),
  firm_id: z.string().uuid(),
  tax_software_id: z.string().nullable(),
  display_name_at_creation: z.string(),
  created_at: z.string().datetime(),
  created_by: z.string().uuid().nullable(),
});

export type SentinelV1 = z.infer<typeof SentinelV1>;

export interface SentinelLocation {
  /** Sentinel folder name (e.g. `_Vibe`). */
  folder?: string;
  /** Sentinel file name (e.g. `client.json`). */
  file?: string;
}

/** Returns the storage key for a sentinel inside the given client folder. */
export function sentinelKey(folderPath: string, loc: SentinelLocation = {}): string {
  const folder = loc.folder ?? SENTINEL_FOLDER_DEFAULT;
  const file = loc.file ?? SENTINEL_FILE_DEFAULT;
  return joinPath(folderPath, folder, file);
}

export type ReadSentinelResult =
  | { ok: true; payload: SentinelV1; etag: string }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'unparseable'; error: string }
  | { ok: false; reason: 'schema_invalid'; error: string }
  | { ok: false; reason: 'wrong_firm'; payload: SentinelV1 };

/**
 * Reads and validates the sentinel at `folderPath/_Vibe/client.json`.
 *
 * Returns a discriminated union so the sync worker can map each case
 * to a state-machine transition without throwing on the hot path:
 *   - missing → `sentinel_lost` event
 *   - unparseable / schema_invalid → `sentinel_changed` event
 *   - wrong_firm → `orphan` event (sentinel valid but firm_id mismatch)
 *   - ok → `discovered` / `renamed` / `restored` per the state machine
 */
export async function readSentinel(
  client: StorageClient,
  folderPath: string,
  opts: SentinelLocation & { expectedFirmId?: string } = {},
): Promise<ReadSentinelResult> {
  const key = sentinelKey(folderPath, opts);
  let body: Buffer;
  let etag: string;
  try {
    const result = await client.get(key);
    etag = result.meta.etag;
    body = await streamToBuffer(result.body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The mock + B2 clients both surface "not found" via a thrown
    // error rather than a sentinel return value, so we can't be more
    // precise than this without leaking provider semantics.
    if (/not found|NoSuchKey|ENOENT/i.test(message)) {
      return { ok: false, reason: 'missing' };
    }
    throw err;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(body.toString('utf8'));
  } catch (err) {
    return {
      ok: false,
      reason: 'unparseable',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const parsed = SentinelV1.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'schema_invalid',
      error: parsed.error.message,
    };
  }

  if (opts.expectedFirmId && parsed.data.firm_id !== opts.expectedFirmId) {
    return { ok: false, reason: 'wrong_firm', payload: parsed.data };
  }

  return { ok: true, payload: parsed.data, etag };
}

/**
 * Writes a sentinel. Used by the onboarding bind flow when a folder
 * is first attached to a client.
 *
 * Caller is responsible for ensuring there is no existing sentinel
 * with a *different* `client_id` — that's a conflict the bind path
 * resolves at the DB level (unique constraint on client_folders).
 */
export async function writeSentinel(
  client: StorageClient,
  folderPath: string,
  payload: SentinelV1,
  opts: SentinelLocation = {},
): Promise<{ etag: string }> {
  const validated = SentinelV1.parse(payload);
  const key = sentinelKey(folderPath, opts);
  const body = Buffer.from(`${JSON.stringify(validated, null, 2)}\n`, 'utf8');
  return client.put(key, body, {
    contentType: 'application/json',
    metadata: { 'vibe-sentinel-version': String(validated.version) },
  });
}

/**
 * Partial update of an existing sentinel. Used by folder-rename to
 * refresh `display_name_at_creation` without re-binding identity, and
 * by future migrations that want to add a field.
 *
 * `client_id` is immutable here — any attempt to mutate it throws
 * before touching storage, so a buggy caller can't silently re-point
 * a folder at a different client.
 */
export async function updateSentinel(
  client: StorageClient,
  folderPath: string,
  partial: Partial<Omit<SentinelV1, 'client_id'>> & { client_id?: never },
  opts: SentinelLocation & { expectedFirmId?: string } = {},
): Promise<{ etag: string; payload: SentinelV1 }> {
  if ('client_id' in partial && partial.client_id !== undefined) {
    throw new Error(
      'updateSentinel: client_id is immutable — use writeSentinel to bind a fresh folder.',
    );
  }
  const current = await readSentinel(client, folderPath, opts);
  if (!current.ok) {
    throw new Error(`updateSentinel: cannot update — sentinel state is ${current.reason}`);
  }
  const next: SentinelV1 = {
    ...current.payload,
    ...partial,
    client_id: current.payload.client_id, // explicit re-pin for safety
  };
  const result = await writeSentinel(client, folderPath, next, opts);
  return { etag: result.etag, payload: next };
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
