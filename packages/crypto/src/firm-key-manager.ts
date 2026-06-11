// SPDX-License-Identifier: Elastic-2.0
//
// FirmKeyManager — owns the firm's Master Firm Key (MFK) lifecycle:
// bootstrap (first-ever boot), unseal (every subsequent boot), wrap/
// unwrap T-DEKs, rotate.
//
// The MFK is a 32-byte symmetric key that wraps every per-thread and
// per-vault-object DEK. The MFK itself is wrapped by a KEK derived
// either from a file on disk (sealed-on-disk mode) or from an admin
// passphrase via Argon2id (admin-passphrase mode).
//
// MFK never leaves the process's memory in plaintext. The wrapped form
// is persisted in `vibetb.firm_key_envelope`.

import { mkdir, readFile, writeFile, stat, chmod, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  DEFAULT_ARGON2_PARAMS,
  decrypt,
  deriveKekFromPassphrase,
  encrypt,
  generateKey,
  generateSalt,
  type Argon2Params,
} from './envelope-codec';

const SENTINEL_PLAINTEXT = 'vibe-tb-firm-key-sentinel-v1';

export type UnlockMode = 'sealed-on-disk' | 'admin-passphrase';

export interface SealedOnDiskMetadata {
  mode: 'sealed-on-disk';
  /** Absolute path to the on-disk KEK file. */
  path: string;
}

export interface AdminPassphraseMetadata {
  mode: 'admin-passphrase';
  /** Base64-encoded salt used in the Argon2id derivation. */
  argon2_salt: string;
  /** Argon2id iteration count. */
  argon2_time_cost: number;
  /** Argon2id memory cost in KiB. */
  argon2_memory_cost: number;
  /** Argon2id thread count. */
  argon2_parallelism: number;
}

export type KekMetadata = SealedOnDiskMetadata | AdminPassphraseMetadata;

export interface FirmKeyEnvelopeRow {
  firmId: string;
  wrappedMfk: Uint8Array;
  kekMetadata: KekMetadata;
  sentinelCiphertext: Uint8Array;
  rotationVersion: number;
}

/**
 * Persistence port. The DB-backed adapter lives in the API layer
 * (apps/api/src/crypto/store.ts) so this package stays Drizzle-free
 * and testable in isolation.
 */
export interface FirmKeyStore {
  /** Get the envelope row for a firm; null if not yet bootstrapped. */
  get(firmId: string): Promise<FirmKeyEnvelopeRow | null>;
  /** Insert a fresh envelope row (bootstrap path). */
  insert(row: FirmKeyEnvelopeRow): Promise<void>;
  /** Replace the existing envelope row (rotation path). */
  update(row: FirmKeyEnvelopeRow): Promise<void>;
}

/**
 * Internal state for one firm. Only present after a successful
 * bootstrap or unseal; absent when the appliance is locked.
 */
interface LiveKey {
  firmId: string;
  mfk: Uint8Array;
  unlockMode: UnlockMode;
  rotationVersion: number;
}

export interface FirmKeyManagerOptions {
  store: FirmKeyStore;
  /**
   * Where to write the on-disk KEK in sealed-on-disk mode. Default is
   * `/data/.firm-key.seal`. The directory is created with mode 0700
   * and the file with mode 0400.
   */
  sealedKeyPath?: string;
}

/**
 * Per-firm key lifecycle. Bootstrap once; unseal at every API boot.
 * Hold the MFK in process memory until shutdown.
 */
export class FirmKeyManager {
  private readonly store: FirmKeyStore;
  private readonly sealedKeyPath: string;
  private readonly liveKeys = new Map<string, LiveKey>();

  constructor(opts: FirmKeyManagerOptions) {
    this.store = opts.store;
    this.sealedKeyPath = opts.sealedKeyPath ?? '/data/.firm-key.seal';
  }

  /**
   * First-time setup for a firm. Generates a 32-byte MFK, wraps it
   * with a KEK (mode-dependent), persists the envelope + sentinel,
   * and holds the live MFK.
   */
  async bootstrap(args: { firmId: string; mode: UnlockMode; passphrase?: string }): Promise<void> {
    const existing = await this.store.get(args.firmId);
    if (existing) {
      throw new Error(`firm ${args.firmId} already has a key envelope`);
    }
    const mfk = generateKey();
    const { kek, metadata } = await this.deriveKek(args.mode, args.passphrase);
    const wrappedMfk = encrypt(mfk, kek).bytes;
    const sentinelCiphertext = encrypt(new TextEncoder().encode(SENTINEL_PLAINTEXT), mfk).bytes;
    await this.store.insert({
      firmId: args.firmId,
      wrappedMfk,
      kekMetadata: metadata,
      sentinelCiphertext,
      rotationVersion: 1,
    });
    this.liveKeys.set(args.firmId, {
      firmId: args.firmId,
      mfk,
      unlockMode: args.mode,
      rotationVersion: 1,
    });
  }

  /**
   * Boot-time unseal. Reads the envelope row, derives the KEK, unwraps
   * the MFK, verifies the sentinel. Holds the live MFK on success.
   * Idempotent: calling unseal() twice for the same firm is a no-op.
   */
  async unseal(args: { firmId: string; passphrase?: string }): Promise<void> {
    if (this.liveKeys.has(args.firmId)) return;
    const row = await this.store.get(args.firmId);
    if (!row) {
      throw new Error(`firm ${args.firmId} has no key envelope; call bootstrap() first`);
    }
    const kek = await this.recoverKek(row.kekMetadata, args.passphrase);
    const mfk = decrypt(row.wrappedMfk, kek);
    // Sentinel verifies the MFK is the right one — cryptographically
    // tied to this envelope. decrypt() throws on tag mismatch.
    const sentinelPlain = decrypt(row.sentinelCiphertext, mfk);
    const decoded = new TextDecoder().decode(sentinelPlain);
    if (decoded !== SENTINEL_PLAINTEXT) {
      throw new Error('sentinel mismatch: wrong MFK or envelope corruption');
    }
    this.liveKeys.set(args.firmId, {
      firmId: args.firmId,
      mfk,
      unlockMode: row.kekMetadata.mode,
      rotationVersion: row.rotationVersion,
    });
  }

  isUnlocked(firmId: string): boolean {
    return this.liveKeys.has(firmId);
  }

  modeFor(firmId: string): UnlockMode {
    return this.requireLive(firmId).unlockMode;
  }

  /** Wrap a plaintext T-DEK with the firm's MFK. */
  wrapTDek(firmId: string, plaintextKey: Uint8Array): Uint8Array {
    const live = this.requireLive(firmId);
    return encrypt(plaintextKey, live.mfk).bytes;
  }

  /** Unwrap a stored T-DEK with the firm's MFK. */
  unwrapTDek(firmId: string, wrappedKey: Uint8Array): Uint8Array {
    const live = this.requireLive(firmId);
    return decrypt(wrappedKey, live.mfk);
  }

  /**
   * Rotate the MFK. Generates a new MFK, re-wraps the sentinel,
   * re-wraps the new MFK with the existing KEK. T-DEKs across the DB
   * still need re-wrapping; that's the caller's responsibility.
   *
   * Returns both keys so the caller can re-wrap T-DEKs from old → new.
   *
   * NOTE: rotation in admin-passphrase mode currently re-uses the
   * existing KEK. Changing the passphrase requires a separate flow that
   * derives a new KEK and stores updated metadata.
   */
  async rotateMFK(firmId: string): Promise<{ oldMfk: Uint8Array; newMfk: Uint8Array }> {
    const live = this.requireLive(firmId);
    const row = await this.store.get(firmId);
    if (!row) throw new Error('envelope row vanished mid-rotate');
    if (row.kekMetadata.mode === 'admin-passphrase') {
      throw new Error(
        'rotateMFK in admin-passphrase mode requires the passphrase; use rotateMFKWithPassphrase',
      );
    }
    const kek = await this.recoverKek(row.kekMetadata, undefined);
    const oldMfk = live.mfk;
    const newMfk = generateKey();
    const wrappedMfk = encrypt(newMfk, kek).bytes;
    const sentinelCiphertext = encrypt(new TextEncoder().encode(SENTINEL_PLAINTEXT), newMfk).bytes;
    const nextVersion = row.rotationVersion + 1;
    await this.store.update({
      firmId,
      wrappedMfk,
      kekMetadata: row.kekMetadata,
      sentinelCiphertext,
      rotationVersion: nextVersion,
    });
    this.liveKeys.set(firmId, {
      firmId,
      mfk: newMfk,
      unlockMode: live.unlockMode,
      rotationVersion: nextVersion,
    });
    return { oldMfk, newMfk };
  }

  /**
   * P3.4 — one-way migration from sealed-on-disk → admin-passphrase.
   * Wraps the existing live MFK with a fresh passphrase-derived KEK,
   * persists the new envelope metadata, and best-effort deletes the
   * stale on-disk sealed key. No downgrade path: once you've switched
   * to admin-passphrase, the appliance requires the passphrase at
   * every boot.
   */
  async migrateUnlockMode(args: {
    firmId: string;
    targetMode: 'admin-passphrase';
    passphrase: string;
  }): Promise<{ rotationVersion: number }> {
    const live = this.requireLive(args.firmId);
    if (live.unlockMode !== 'sealed-on-disk') {
      throw new Error(
        `firm ${args.firmId} is already in ${live.unlockMode} mode; migrate is one-way`,
      );
    }
    if (args.targetMode !== 'admin-passphrase') {
      throw new Error('migrateUnlockMode only supports targetMode=admin-passphrase');
    }
    if (!args.passphrase || args.passphrase.length < 12) {
      throw new Error('passphrase must be at least 12 characters');
    }
    const row = await this.store.get(args.firmId);
    if (!row) throw new Error('envelope row vanished mid-migrate');
    const oldSealedPath = row.kekMetadata.mode === 'sealed-on-disk' ? row.kekMetadata.path : null;

    const salt = generateSalt();
    const params: Argon2Params = DEFAULT_ARGON2_PARAMS;
    const newKek = await deriveKekFromPassphrase(args.passphrase, salt, params);
    const wrappedMfk = encrypt(live.mfk, newKek).bytes;
    const sentinelCiphertext = encrypt(
      new TextEncoder().encode(SENTINEL_PLAINTEXT),
      live.mfk,
    ).bytes;
    const nextVersion = row.rotationVersion + 1;
    await this.store.update({
      firmId: args.firmId,
      wrappedMfk,
      kekMetadata: {
        mode: 'admin-passphrase',
        argon2_salt: bytesToBase64(salt),
        argon2_time_cost: params.timeCost,
        argon2_memory_cost: params.memoryCost,
        argon2_parallelism: params.parallelism,
      },
      sentinelCiphertext,
      rotationVersion: nextVersion,
    });
    this.liveKeys.set(args.firmId, {
      firmId: args.firmId,
      mfk: live.mfk,
      unlockMode: 'admin-passphrase',
      rotationVersion: nextVersion,
    });
    if (oldSealedPath) {
      try {
        await unlink(oldSealedPath);
      } catch {
        // best-effort — the new envelope no longer references this file,
        // so a leftover sealed key cannot unseal anything.
      }
    }
    return { rotationVersion: nextVersion };
  }

  /** Drop the live MFK for a firm. Used in tests + manual relock. */
  forget(firmId: string): void {
    const live = this.liveKeys.get(firmId);
    if (live) {
      // Zero out before discarding (best-effort; V8 makes no promises
      // about underlying allocations).
      live.mfk.fill(0);
      this.liveKeys.delete(firmId);
    }
  }

  // -------------------------------------------------------------------
  // private helpers
  // -------------------------------------------------------------------

  private requireLive(firmId: string): LiveKey {
    const live = this.liveKeys.get(firmId);
    if (!live) throw new Error(`firm ${firmId} is not unlocked`);
    return live;
  }

  private async deriveKek(
    mode: UnlockMode,
    passphrase?: string,
  ): Promise<{ kek: Uint8Array; metadata: KekMetadata }> {
    if (mode === 'sealed-on-disk') {
      const kek = generateKey();
      await this.writeSealedKey(kek);
      return {
        kek,
        metadata: { mode: 'sealed-on-disk', path: this.sealedKeyPath },
      };
    }
    if (!passphrase) throw new Error('admin-passphrase mode requires a passphrase');
    const salt = generateSalt();
    const params: Argon2Params = DEFAULT_ARGON2_PARAMS;
    const kek = await deriveKekFromPassphrase(passphrase, salt, params);
    return {
      kek,
      metadata: {
        mode: 'admin-passphrase',
        argon2_salt: bytesToBase64(salt),
        argon2_time_cost: params.timeCost,
        argon2_memory_cost: params.memoryCost,
        argon2_parallelism: params.parallelism,
      },
    };
  }

  private async recoverKek(
    metadata: KekMetadata,
    passphrase: string | undefined,
  ): Promise<Uint8Array> {
    if (metadata.mode === 'sealed-on-disk') {
      return this.readSealedKey(metadata.path);
    }
    if (!passphrase) throw new Error('admin-passphrase mode requires a passphrase');
    const salt = base64ToBytes(metadata.argon2_salt);
    return deriveKekFromPassphrase(passphrase, salt, {
      timeCost: metadata.argon2_time_cost,
      memoryCost: metadata.argon2_memory_cost,
      parallelism: metadata.argon2_parallelism,
    });
  }

  private async writeSealedKey(kek: Uint8Array): Promise<void> {
    const dir = dirname(this.sealedKeyPath);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    } catch {
      // dir already exists; fine
    }
    await writeFile(this.sealedKeyPath, Buffer.from(kek), { mode: 0o400 });
    try {
      await chmod(this.sealedKeyPath, 0o400);
    } catch {
      // best-effort
    }
  }

  private async readSealedKey(path: string): Promise<Uint8Array> {
    const buf = await readFile(path);
    if (buf.length !== 32) {
      throw new Error(`sealed key file at ${path} has wrong length ${buf.length}; expected 32`);
    }
    try {
      await stat(path);
    } catch {
      // non-fatal
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
}

// ---------------------------------------------------------------------
// Local base64 helpers (avoid pulling in another dep).
// ---------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(b64: string): Uint8Array {
  const buf = Buffer.from(b64, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
