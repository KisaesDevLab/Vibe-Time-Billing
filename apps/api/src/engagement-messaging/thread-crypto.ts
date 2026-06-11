// SPDX-License-Identifier: Elastic-2.0
//
// Per-thread T-DEK lifecycle. Wraps @vibe/crypto's envelope codec with
// thread-aware encrypt/decrypt helpers — every operation looks up the
// thread's wrapped DEK, unwraps it with the firm MFK, performs the
// content op, and discards the plaintext key.
//
// The plaintext T-DEK never leaves a single function's local scope.

import { decrypt, encrypt, generateKey } from '@vibe/crypto';

import { getFirmKeyManager } from '../crypto/manager';
import { getApplianceLockState } from '../crypto/boot';
import type { Database } from '@vibe/db';
import { threads } from '@vibe/db/schema';
import { eq } from 'drizzle-orm';

export interface ThreadCryptoCtx {
  db: Database;
  firmId: string;
  threadId: string;
}

function requireUnlockedFirmId(): string {
  const state = getApplianceLockState();
  if (state.kind !== 'unlocked') {
    throw new Error(`appliance not unlocked (state=${state.kind})`);
  }
  return state.firmId;
}

/**
 * Generate a fresh T-DEK and wrap it with the firm MFK. Returns the
 * wrapped bytes; caller stores in thread.t_dek_wrapped. The plaintext
 * T-DEK is discarded.
 */
export function generateWrappedTDek(db: Database, firmId: string): Uint8Array {
  const mgr = getFirmKeyManager(db);
  const tDek = generateKey();
  const wrapped = mgr.wrapTDek(firmId, tDek);
  tDek.fill(0);
  return wrapped;
}

async function unwrapThreadTDek(ctx: ThreadCryptoCtx): Promise<Uint8Array> {
  const [row] = await ctx.db
    .select({ wrapped: threads.tDekWrapped, firmId: threads.firmId })
    .from(threads)
    .where(eq(threads.id, ctx.threadId))
    .limit(1);
  if (!row) throw new Error(`thread ${ctx.threadId} not found`);
  if (row.firmId !== ctx.firmId) {
    throw new Error(`thread ${ctx.threadId} does not belong to firm ${ctx.firmId}`);
  }
  const mgr = getFirmKeyManager(ctx.db);
  return mgr.unwrapTDek(ctx.firmId, row.wrapped);
}

/** Encrypt a UTF-8 string under the thread's T-DEK. */
export async function encryptForThread(
  ctx: ThreadCryptoCtx,
  plaintext: string,
): Promise<Uint8Array> {
  requireUnlockedFirmId();
  const tDek = await unwrapThreadTDek(ctx);
  try {
    const bytes = new TextEncoder().encode(plaintext);
    const blob = encrypt(bytes, tDek);
    return blob.bytes;
  } finally {
    tDek.fill(0);
  }
}

/** Encrypt raw bytes (e.g. an attachment) under the thread's T-DEK. */
export async function encryptBytesForThread(
  ctx: ThreadCryptoCtx,
  bytes: Uint8Array,
): Promise<Uint8Array> {
  requireUnlockedFirmId();
  const tDek = await unwrapThreadTDek(ctx);
  try {
    return encrypt(bytes, tDek).bytes;
  } finally {
    tDek.fill(0);
  }
}

/** Decrypt raw bytes previously sealed with the thread's T-DEK. */
export async function decryptBytesForThread(
  ctx: ThreadCryptoCtx,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  requireUnlockedFirmId();
  const tDek = await unwrapThreadTDek(ctx);
  try {
    return decrypt(ciphertext, tDek);
  } finally {
    tDek.fill(0);
  }
}

/** Decrypt a stored ciphertext under the thread's T-DEK. */
export async function decryptForThread(
  ctx: ThreadCryptoCtx,
  ciphertext: Uint8Array,
): Promise<string> {
  requireUnlockedFirmId();
  const tDek = await unwrapThreadTDek(ctx);
  try {
    const plain = decrypt(ciphertext, tDek);
    return new TextDecoder().decode(plain);
  } finally {
    tDek.fill(0);
  }
}

/**
 * Batch decrypt — single unwrap of the T-DEK, decrypt many messages.
 * Used by the message-list endpoint to avoid N unwraps per page.
 */
export async function batchDecryptForThread(
  ctx: ThreadCryptoCtx,
  ciphertexts: ReadonlyArray<Uint8Array>,
): Promise<string[]> {
  requireUnlockedFirmId();
  const tDek = await unwrapThreadTDek(ctx);
  try {
    return ciphertexts.map((ct) => new TextDecoder().decode(decrypt(ct, tDek)));
  } finally {
    tDek.fill(0);
  }
}
