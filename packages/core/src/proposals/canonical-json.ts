// SPDX-License-Identifier: Elastic-2.0
//
// P06 — Canonical JSON serializer + SHA-256 content hasher.
//
// The canonical form sorts object keys lexicographically at every
// depth and emits without whitespace, so the same logical value
// always serializes byte-for-byte identically. That's what makes
// the content_hash on proposal_versions reproducible — what was
// served at SENT time hashes to the same string forever, even if
// the firm edits the draft post-send.
//
// Limitations (intentional):
//   • undefined inside objects is dropped (JSON.stringify behavior).
//   • Map/Set/Date/etc. are NOT supported — pass plain JSON values.
//     The block tree only stores plain JSON so this is fine in
//     practice; if a future block type stores a Date it must
//     pre-serialize.
//   • BigInt throws (no JSON representation).
//   • Cycles throw via the underlying serializer (we don't try to
//     break them).

import { createHash } from 'node:crypto';

export function canonicalize(value: unknown): string {
  return JSON.stringify(canonicalSort(value));
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function contentHash(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

function canonicalSort(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((v) => canonicalSort(v));
  if (typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue;
    out[k] = canonicalSort(v);
  }
  return out;
}
