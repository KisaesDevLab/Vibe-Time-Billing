// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0222 — effective AI routing mode. Resolution order:
//
//   firm_config.ai_mode = 'router'  → router, using the firm's stored URL +
//                                      MFK-wrapped token (Admin → AI settings)
//   firm_config.ai_mode = 'direct'  → direct, regardless of env
//   firm_config.ai_mode = 'env'     → VIBE_AI_MODE / VIBE_AI_ROUTER_URL /
//                                      VIBE_AI_TOKEN (appliance default)
//
// A firm row set to 'router' without a usable URL + token degrades to
// 'direct' and says so in `problem` — never a silent half-configured router.
//
// `aiMode()` callers are synchronous and sit on the hot path, so the result
// is cached in-process and refreshed at boot, after every admin save, and
// on a slow timer (other replicas / manual DB edits). Single-firm appliance:
// the first firm_config row is the firm.

import type { Database } from '@vibe/db';
import { firmConfig } from '@vibe/db/schema';

import { getFirmKeyManager } from '../crypto/manager';
import { getApplianceLockState } from '../crypto/boot';
import { logger } from '../logger';

export type AiMode = 'direct' | 'router';
export type AiModeSetting = 'env' | AiMode;

export interface AiRuntime {
  mode: AiMode;
  /** Where the effective mode came from. */
  source: 'env' | 'firm';
  /** What the firm row asked for (so the UI can show "env" vs override). */
  firmSetting: AiModeSetting;
  routerUrl: string | null;
  routerToken: string | null;
  /** Why a requested router mode could not be honoured, if so. */
  problem: string | null;
  loadedAt: number;
}

function fromEnv(): Pick<AiRuntime, 'mode' | 'routerUrl' | 'routerToken'> {
  const mode: AiMode = process.env['VIBE_AI_MODE'] === 'router' ? 'router' : 'direct';
  return {
    mode,
    routerUrl: process.env['VIBE_AI_ROUTER_URL'] ?? null,
    routerToken: process.env['VIBE_AI_TOKEN'] ?? null,
  };
}

let current: AiRuntime = {
  ...fromEnv(),
  source: 'env',
  firmSetting: 'env',
  problem: null,
  loadedAt: 0,
};

const listeners = new Set<(rt: AiRuntime) => void>();

/** Synchronous read for the hot path (pickProvider, status routes).
 *  Until the first refresh has run (boot, or tests that only set env vars)
 *  this reflects the environment live. */
export function getAiRuntime(): AiRuntime {
  if (current.loadedAt === 0) {
    return { ...fromEnv(), source: 'env', firmSetting: 'env', problem: null, loadedAt: 0 };
  }
  return current;
}

export function onAiRuntimeChange(fn: (rt: AiRuntime) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Re-read firm_config and recompute. Safe to call often; never throws. */
export async function refreshAiRuntime(db: Database | null): Promise<AiRuntime> {
  const env = fromEnv();
  let next: AiRuntime = {
    ...env,
    source: 'env',
    firmSetting: 'env',
    problem: null,
    loadedAt: Date.now(),
  };
  if (db) {
    try {
      const [row] = await db
        .select({
          firmId: firmConfig.firmId,
          aiMode: firmConfig.aiMode,
          url: firmConfig.aiRouterUrl,
          tokenEnc: firmConfig.aiRouterTokenEncrypted,
        })
        .from(firmConfig)
        .limit(1);
      if (row && row.aiMode !== 'env') {
        const setting = row.aiMode as AiMode;
        if (setting === 'direct') {
          next = { ...next, mode: 'direct', source: 'firm', firmSetting: 'direct' };
        } else {
          let token: string | null = null;
          let problem: string | null = null;
          if (!row.url) problem = 'router_url_missing';
          else if (!row.tokenEnc) problem = 'router_token_missing';
          else if (getApplianceLockState().kind !== 'unlocked') problem = 'appliance_locked';
          else {
            try {
              token = new TextDecoder('utf-8').decode(
                getFirmKeyManager(db).unwrapTDek(row.firmId, row.tokenEnc),
              );
            } catch (err) {
              problem = `token_unwrap_failed: ${err instanceof Error ? err.message : String(err)}`;
            }
          }
          next =
            problem || !token
              ? { ...next, mode: 'direct', source: 'firm', firmSetting: 'router', problem }
              : {
                  mode: 'router',
                  source: 'firm',
                  firmSetting: 'router',
                  routerUrl: row.url!.replace(/\/+$/, ''),
                  routerToken: token,
                  problem: null,
                  loadedAt: Date.now(),
                };
        }
      }
    } catch (err) {
      // Table not migrated yet / DB blip: keep env behaviour.
      logger.warn({ err }, 'ai-runtime: firm_config read failed; using env mode');
    }
  }
  const changed =
    next.mode !== current.mode ||
    next.routerUrl !== current.routerUrl ||
    next.routerToken !== current.routerToken;
  current = next;
  if (changed) for (const fn of listeners) fn(next);
  return next;
}

/** Boot helper: initial load + slow periodic refresh. Returns a stop fn. */
export function startAiRuntimeRefresh(db: Database | null, intervalMs = 60_000): () => void {
  void refreshAiRuntime(db);
  const t = setInterval(() => void refreshAiRuntime(db), intervalMs);
  if (typeof t === 'object' && 'unref' in t) t.unref();
  return () => clearInterval(t);
}

/** Test seam. */
export function _resetAiRuntimeForTests(): void {
  current = { ...fromEnv(), source: 'env', firmSetting: 'env', problem: null, loadedAt: 0 };
}
