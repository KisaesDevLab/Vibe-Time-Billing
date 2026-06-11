// SPDX-License-Identifier: Elastic-2.0
//
// P5.1 — Connect addendum J.7–J.9 — AI egress gate.
//
// Policy:
//   firm_config.ai_egress_enabled = false (default)
//     → ALL AI calls must use the local provider. Cloud is never
//       reached. If no local provider is wired, the call fails closed.
//   firm_config.ai_egress_enabled = true AND vibe_shield_endpoint is set
//     → AI calls may go to the cloud provider, but ONLY if Vibe Shield
//       is currently reachable (last-known status cached in Redis at
//       `ai:shield:reachable` by the healthcheck worker). If Shield is
//       unreachable, mutating MCP tools that require egress are
//       deregistered and the call returns 'shield-unreachable'.
//   firm_config.ai_egress_enabled = true AND vibe_shield_endpoint NULL
//     → policy is misconfigured; fail closed with 'shield-not-configured'.
//
// Reachability: written by `apps/worker/src/jobs/shield-healthcheck.ts`
// every 5 min with TTL 10 min. A missing key means "unknown" — treated
// as unreachable so we fail safe.

import type { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { firmConfig } from '@vibe/db/schema';

export type EgressDecision =
  | { kind: 'local-only'; reason: 'firm-policy' }
  | { kind: 'shield-ok' }
  | { kind: 'direct-ok' }
  | { kind: 'shield-unreachable' }
  | { kind: 'shield-not-configured' };

export const SHIELD_REACHABLE_KEY = 'ai:shield:reachable';
export const SHIELD_REACHABLE_TTL_SEC = 10 * 60; // worker writes every 5 min

export async function resolveEgressPolicy(args: {
  db: Database | null;
  redis: Redis;
  firmId: string;
}): Promise<EgressDecision> {
  if (!args.db) {
    return { kind: 'local-only', reason: 'firm-policy' };
  }
  const [row] = await args.db
    .select({
      enabled: firmConfig.aiEgressEnabled,
      endpoint: firmConfig.vibeShieldEndpoint,
      mode: firmConfig.aiEgressMode,
    })
    .from(firmConfig)
    .where(eq(firmConfig.firmId, args.firmId))
    .limit(1);
  // No firm_config row → fall through to the secure default.
  if (!row || !row.enabled) {
    return { kind: 'local-only', reason: 'firm-policy' };
  }
  // 0100 — direct mode: appliance calls the provider API directly (firm
  // owns the key; budget cap + audit log still apply). No shield needed.
  if (row.mode === 'direct') {
    return { kind: 'direct-ok' };
  }
  if (!row.endpoint) {
    return { kind: 'shield-not-configured' };
  }
  const reachable = await args.redis.get(SHIELD_REACHABLE_KEY);
  if (reachable === '1') return { kind: 'shield-ok' };
  return { kind: 'shield-unreachable' };
}
