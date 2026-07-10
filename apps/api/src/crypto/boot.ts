// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Boot-time crypto wiring. On every API start:
//
//   1. Resolve the single firm row (single-firm appliance per CLAUDE.md
//      non-negotiable: one firm per appliance).
//   2. Look up the firm's unlock_mode from firm_config (defaults to
//      sealed-on-disk).
//   3. If no firm_key_envelope row exists yet, bootstrap one. For
//      sealed-on-disk this is fully automatic. For admin-passphrase the
//      bootstrap is deferred until an operator POSTs the passphrase to
//      `/api/staff/admin/unlock` for the first time.
//   4. If a row exists and unlock_mode is sealed-on-disk, unseal
//      transparently. If admin-passphrase, leave the appliance locked
//      and let the lock middleware return 503 until the operator
//      unlocks via `/api/staff/admin/unlock`.
//
// The resulting state is exposed via `getApplianceLockState()` so the
// lock middleware and `/admin/unlock` router can read it consistently.

import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { firmConfig, firms } from '@vibe/db/schema';

import { logger } from '../logger';
import { getFirmKeyManager } from './manager';
import { createFirmKeyStore } from './store';

export type LockState =
  | { kind: 'unlocked'; firmId: string }
  | { kind: 'locked'; firmId: string; reason: 'awaiting-passphrase' }
  | { kind: 'not-bootstrapped'; firmId: string; mode: 'admin-passphrase' }
  | { kind: 'no-firm' };

let cached: LockState = { kind: 'no-firm' };

export function getApplianceLockState(): LockState {
  return cached;
}

/** Manually set state (used by the unlock route after successful unseal). */
export function setApplianceLockState(s: LockState): void {
  cached = s;
}

/**
 * Run once at API boot. Resolves the single firm, ensures a firm_config
 * row exists, then either auto-unlocks (sealed-on-disk) or leaves the
 * appliance locked pending an operator unlock.
 */
export async function bootCrypto(db: Database | null): Promise<LockState> {
  if (!db) {
    cached = { kind: 'no-firm' };
    return cached;
  }

  const [firm] = await db.select({ id: firms.id }).from(firms).limit(1);
  if (!firm) {
    logger.warn('crypto boot: no firm row yet; skipping unseal (appliance not provisioned)');
    cached = { kind: 'no-firm' };
    return cached;
  }
  const firmId = firm.id;

  let [cfg] = await db
    .select({ unlockMode: firmConfig.unlockMode })
    .from(firmConfig)
    .where(eq(firmConfig.firmId, firmId))
    .limit(1);
  if (!cfg) {
    await db.insert(firmConfig).values({ firmId }).onConflictDoNothing();
    [cfg] = await db
      .select({ unlockMode: firmConfig.unlockMode })
      .from(firmConfig)
      .where(eq(firmConfig.firmId, firmId))
      .limit(1);
  }
  const mode = (cfg?.unlockMode ?? 'sealed-on-disk') as 'sealed-on-disk' | 'admin-passphrase';

  const mgr = getFirmKeyManager(db);
  const store = createFirmKeyStore(db);
  const existing = await store.get(firmId);

  if (!existing) {
    if (mode === 'sealed-on-disk') {
      await mgr.bootstrap({ firmId, mode: 'sealed-on-disk' });
      logger.info({ firmId, mode }, 'crypto boot: bootstrapped envelope (sealed-on-disk)');
      cached = { kind: 'unlocked', firmId };
      return cached;
    }
    logger.warn(
      { firmId, mode },
      'crypto boot: admin-passphrase mode but no envelope yet — POST /api/staff/admin/unlock with a passphrase to bootstrap',
    );
    cached = { kind: 'not-bootstrapped', firmId, mode: 'admin-passphrase' };
    return cached;
  }

  if (mode === 'sealed-on-disk') {
    await mgr.unseal({ firmId });
    logger.info({ firmId }, 'crypto boot: unsealed (sealed-on-disk)');
    cached = { kind: 'unlocked', firmId };
    return cached;
  }

  logger.info({ firmId }, 'crypto boot: locked, awaiting admin passphrase');
  cached = { kind: 'locked', firmId, reason: 'awaiting-passphrase' };
  return cached;
}
