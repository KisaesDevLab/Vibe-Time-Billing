// SPDX-License-Identifier: Elastic-2.0
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FirmKeyManager, type FirmKeyEnvelopeRow, type FirmKeyStore } from './firm-key-manager';
import { decrypt, encrypt } from './envelope-codec';

class InMemoryStore implements FirmKeyStore {
  rows = new Map<string, FirmKeyEnvelopeRow>();
  async get(firmId: string): Promise<FirmKeyEnvelopeRow | null> {
    return this.rows.get(firmId) ?? null;
  }
  async insert(row: FirmKeyEnvelopeRow): Promise<void> {
    if (this.rows.has(row.firmId)) throw new Error('row exists');
    this.rows.set(row.firmId, { ...row });
  }
  async update(row: FirmKeyEnvelopeRow): Promise<void> {
    if (!this.rows.has(row.firmId)) throw new Error('row missing');
    this.rows.set(row.firmId, { ...row });
  }
}

const FIRM = '00000000-0000-0000-0000-00000000beef';

describe('FirmKeyManager', () => {
  let tmp: string;
  let sealedPath: string;
  let store: InMemoryStore;
  let mgr: FirmKeyManager;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'vibe-crypto-'));
    sealedPath = join(tmp, '.firm-key.seal');
    store = new InMemoryStore();
    mgr = new FirmKeyManager({ store, sealedKeyPath: sealedPath });
  });

  async function cleanup(): Promise<void> {
    await rm(tmp, { recursive: true, force: true });
  }

  describe('sealed-on-disk mode', () => {
    it('bootstrap → unseal round-trip leaves the firm unlocked', async () => {
      await mgr.bootstrap({ firmId: FIRM, mode: 'sealed-on-disk' });
      expect(mgr.isUnlocked(FIRM)).toBe(true);
      mgr.forget(FIRM);
      expect(mgr.isUnlocked(FIRM)).toBe(false);
      await mgr.unseal({ firmId: FIRM });
      expect(mgr.isUnlocked(FIRM)).toBe(true);
      expect(mgr.modeFor(FIRM)).toBe('sealed-on-disk');
      await cleanup();
    });

    it('T-DEK wrap/unwrap round-trip preserves the key', async () => {
      await mgr.bootstrap({ firmId: FIRM, mode: 'sealed-on-disk' });
      const tDek = new Uint8Array(32).fill(7);
      const wrapped = mgr.wrapTDek(FIRM, tDek);
      expect(wrapped.length).toBeGreaterThan(32);
      const unwrapped = mgr.unwrapTDek(FIRM, wrapped);
      expect(unwrapped).toEqual(tDek);
      await cleanup();
    });

    it('content encrypt → decrypt with unwrapped T-DEK round-trips', async () => {
      await mgr.bootstrap({ firmId: FIRM, mode: 'sealed-on-disk' });
      const tDek = new Uint8Array(32).fill(11);
      const wrapped = mgr.wrapTDek(FIRM, tDek);
      const recoveredTDek = mgr.unwrapTDek(FIRM, wrapped);
      const plaintext = new TextEncoder().encode('hello vibe');
      const ct = encrypt(plaintext, recoveredTDek);
      const pt = decrypt(ct.bytes, recoveredTDek);
      expect(new TextDecoder().decode(pt)).toBe('hello vibe');
      await cleanup();
    });

    it('rotateMFK keeps T-DEKs decryptable through the old key + re-wrappable to new', async () => {
      await mgr.bootstrap({ firmId: FIRM, mode: 'sealed-on-disk' });
      const tDek = new Uint8Array(32).fill(13);
      const wrappedOld = mgr.wrapTDek(FIRM, tDek);
      const { oldMfk } = await mgr.rotateMFK(FIRM);
      // After rotation, the old wrapped T-DEK cannot be unwrapped with
      // the new live MFK.
      expect(() => mgr.unwrapTDek(FIRM, wrappedOld)).toThrow();
      // The caller can unwrap via the old MFK they were handed, then
      // re-wrap with the new live key.
      const recoveredTDek = decrypt(wrappedOld, oldMfk);
      expect(recoveredTDek).toEqual(tDek);
      const wrappedNew = mgr.wrapTDek(FIRM, recoveredTDek);
      const finalUnwrap = mgr.unwrapTDek(FIRM, wrappedNew);
      expect(finalUnwrap).toEqual(tDek);
      await cleanup();
    });
  });

  describe('admin-passphrase mode', () => {
    it('bootstrap stores Argon2id salt + parameters in metadata', async () => {
      await mgr.bootstrap({
        firmId: FIRM,
        mode: 'admin-passphrase',
        passphrase: 'correct-horse-battery-staple',
      });
      const row = await store.get(FIRM);
      expect(row).not.toBeNull();
      expect(row!.kekMetadata.mode).toBe('admin-passphrase');
      if (row!.kekMetadata.mode === 'admin-passphrase') {
        expect(row!.kekMetadata.argon2_salt).toMatch(/^[A-Za-z0-9+/=]+$/);
        expect(row!.kekMetadata.argon2_time_cost).toBeGreaterThan(0);
        expect(row!.kekMetadata.argon2_memory_cost).toBeGreaterThan(0);
        expect(row!.kekMetadata.argon2_parallelism).toBeGreaterThan(0);
      }
      await cleanup();
    });

    it('unseal with correct passphrase succeeds; wrong passphrase throws', async () => {
      await mgr.bootstrap({
        firmId: FIRM,
        mode: 'admin-passphrase',
        passphrase: 'correct-horse',
      });
      mgr.forget(FIRM);
      await expect(mgr.unseal({ firmId: FIRM, passphrase: 'wrong-horse' })).rejects.toThrow();
      expect(mgr.isUnlocked(FIRM)).toBe(false);
      await mgr.unseal({ firmId: FIRM, passphrase: 'correct-horse' });
      expect(mgr.isUnlocked(FIRM)).toBe(true);
      await cleanup();
    });

    it('admin-passphrase mode survives a forget + unseal cycle', async () => {
      await mgr.bootstrap({
        firmId: FIRM,
        mode: 'admin-passphrase',
        passphrase: 'pass-1',
      });
      const tDek = new Uint8Array(32).fill(17);
      const wrapped = mgr.wrapTDek(FIRM, tDek);
      mgr.forget(FIRM);
      const mgr2 = new FirmKeyManager({ store, sealedKeyPath: sealedPath });
      await mgr2.unseal({ firmId: FIRM, passphrase: 'pass-1' });
      const unwrapped = mgr2.unwrapTDek(FIRM, wrapped);
      expect(unwrapped).toEqual(tDek);
      await cleanup();
    });
  });

  // ============================================================
  // P1.1 — A.12 polish: rotation guards + mode parity
  // ============================================================
  describe('mode parity (A.12)', () => {
    it('sealed-on-disk and admin-passphrase produce identical ciphertext semantics', async () => {
      // Same plaintext encrypted under each mode's MFK should decrypt
      // back to the same bytes — the AEAD scheme is mode-independent;
      // only the KEK derivation differs.
      const tmp2 = await mkdtemp(join(tmpdir(), 'vibe-crypto-parity-'));
      const sealedPath2 = join(tmp2, '.firm-key.seal');
      const SOD = '11111111-1111-1111-1111-111111111111';
      const APH = '22222222-2222-2222-2222-222222222222';
      const sodMgr = new FirmKeyManager({ store, sealedKeyPath: sealedPath2 });
      await sodMgr.bootstrap({ firmId: SOD, mode: 'sealed-on-disk' });
      await sodMgr.bootstrap({
        firmId: APH,
        mode: 'admin-passphrase',
        passphrase: 'parity-test-passphrase',
      });
      const plaintext = new TextEncoder().encode('parity-test payload');
      // Round-trip under each firm's T-DEK
      const tDekSod = new Uint8Array(32).fill(20);
      const tDekAph = new Uint8Array(32).fill(20);
      const wSod = sodMgr.wrapTDek(SOD, tDekSod);
      const wAph = sodMgr.wrapTDek(APH, tDekAph);
      const uSod = sodMgr.unwrapTDek(SOD, wSod);
      const uAph = sodMgr.unwrapTDek(APH, wAph);
      expect(uSod).toEqual(tDekSod);
      expect(uAph).toEqual(tDekAph);
      // Encrypted content under each mode's recovered T-DEK
      const ctSod = encrypt(plaintext, uSod).bytes;
      const ctAph = encrypt(plaintext, uAph).bytes;
      // Ciphertexts differ (random nonces) but both decrypt to the
      // original plaintext.
      expect(ctSod).not.toEqual(ctAph);
      expect(decrypt(ctSod, uSod)).toEqual(plaintext);
      expect(decrypt(ctAph, uAph)).toEqual(plaintext);
      await rm(tmp2, { recursive: true, force: true });
    });

    it('rotateMFK refuses in admin-passphrase mode without passphrase support', async () => {
      // The current implementation explicitly throws because re-wrapping
      // the new MFK with the same KEK requires re-deriving from the
      // passphrase, which we don't take as input. Codified so a future
      // refactor that quietly succeeds would break this test.
      await mgr.bootstrap({
        firmId: FIRM,
        mode: 'admin-passphrase',
        passphrase: 'rotate-guard-test',
      });
      await expect(mgr.rotateMFK(FIRM)).rejects.toThrow(
        /admin-passphrase mode requires the passphrase/,
      );
      await cleanup();
    });

    it('rotateMFK throws when the firm is not unlocked', async () => {
      // Defense: rotation must not silently no-op when the live MFK
      // isn't loaded; otherwise an operator could think they rotated
      // when nothing happened.
      await expect(mgr.rotateMFK(FIRM)).rejects.toThrow();
      await cleanup();
    });
  });

  describe('migrateUnlockMode (P3.4)', () => {
    it('sealed-on-disk → admin-passphrase preserves the MFK and survives a relock', async () => {
      await mgr.bootstrap({ firmId: FIRM, mode: 'sealed-on-disk' });
      const tDek = new Uint8Array(32).fill(0x42);
      const wrapped = mgr.wrapTDek(FIRM, tDek);
      const passphrase = 'correct-horse-battery-staple';
      const r = await mgr.migrateUnlockMode({
        firmId: FIRM,
        targetMode: 'admin-passphrase',
        passphrase,
      });
      expect(r.rotationVersion).toBeGreaterThan(1);
      expect(mgr.modeFor(FIRM)).toBe('admin-passphrase');
      // T-DEKs wrapped pre-migration must still unwrap (same MFK held).
      expect(mgr.unwrapTDek(FIRM, wrapped)).toEqual(tDek);
      // Relock + unseal with the passphrase succeeds.
      mgr.forget(FIRM);
      await mgr.unseal({ firmId: FIRM, passphrase });
      expect(mgr.modeFor(FIRM)).toBe('admin-passphrase');
      expect(mgr.unwrapTDek(FIRM, wrapped)).toEqual(tDek);
      await cleanup();
    });

    it('refuses migration when the firm is not unlocked', async () => {
      await expect(
        mgr.migrateUnlockMode({
          firmId: FIRM,
          targetMode: 'admin-passphrase',
          passphrase: 'aaaaaaaaaaaa',
        }),
      ).rejects.toThrow('not unlocked');
      await cleanup();
    });

    it('refuses migration when already in admin-passphrase mode (one-way)', async () => {
      await mgr.bootstrap({
        firmId: FIRM,
        mode: 'admin-passphrase',
        passphrase: 'a-very-strong-pass',
      });
      await expect(
        mgr.migrateUnlockMode({
          firmId: FIRM,
          targetMode: 'admin-passphrase',
          passphrase: 'another-strong-pass',
        }),
      ).rejects.toThrow('one-way');
      await cleanup();
    });

    it('refuses short passphrases', async () => {
      await mgr.bootstrap({ firmId: FIRM, mode: 'sealed-on-disk' });
      await expect(
        mgr.migrateUnlockMode({
          firmId: FIRM,
          targetMode: 'admin-passphrase',
          passphrase: 'short',
        }),
      ).rejects.toThrow('12');
      await cleanup();
    });
  });

  describe('isolation', () => {
    it('rejects bootstrap when an envelope already exists', async () => {
      await mgr.bootstrap({ firmId: FIRM, mode: 'sealed-on-disk' });
      await expect(mgr.bootstrap({ firmId: FIRM, mode: 'sealed-on-disk' })).rejects.toThrow(
        'already has a key envelope',
      );
      await cleanup();
    });

    it('wrapTDek throws if the firm is not unlocked', async () => {
      expect(() => mgr.wrapTDek(FIRM, new Uint8Array(32))).toThrow('not unlocked');
      await cleanup();
    });

    it('sentinel mismatch is caught', async () => {
      await mgr.bootstrap({ firmId: FIRM, mode: 'sealed-on-disk' });
      const row = store.rows.get(FIRM)!;
      row.wrappedMfk = new Uint8Array(row.wrappedMfk.length).fill(0xff);
      mgr.forget(FIRM);
      await expect(mgr.unseal({ firmId: FIRM })).rejects.toThrow();
      await cleanup();
    });
  });
});
