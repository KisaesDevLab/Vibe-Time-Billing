// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Process-wide FirmKeyManager singleton. Built lazily so unit tests
// that don't need crypto don't pay the libsodium init cost (now via
// @noble/ciphers — still keeps the lazy pattern). Holds the live MFK
// in memory; cleared on `forget()` or process exit.

import { FirmKeyManager } from '@vibe/crypto';
import type { Database } from '@vibe/db';

import { createFirmKeyStore } from './store';

let mgr: FirmKeyManager | null = null;

export function getFirmKeyManager(db: Database): FirmKeyManager {
  if (!mgr) {
    const sealedKeyPath = process.env['FIRM_KEY_SEAL_PATH'] ?? '/data/.firm-key.seal';
    mgr = new FirmKeyManager({
      store: createFirmKeyStore(db),
      sealedKeyPath,
    });
  }
  return mgr;
}

/** Test-only — reset the singleton between tests. */
export function resetFirmKeyManagerForTests(): void {
  mgr = null;
}
