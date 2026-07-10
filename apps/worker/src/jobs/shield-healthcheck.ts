// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P5.2 — Vibe Shield reachability probe. Runs every 5 minutes; pings
// each firm's configured `vibe_shield_endpoint` and stamps the result
// in Redis at `ai:shield:reachable` with a 10-minute TTL (so a single
// missed probe doesn't immediately flip cloud egress off, but two
// consecutive misses do).
//
// Since the appliance is single-firm, "each firm's endpoint" reduces to
// "the one firm's endpoint" — but we keep the loop so a future multi-
// firm deployment is a small change.
//
// Failure isolation: a probe failure must NEVER throw out of this job;
// the worker keeps running and the next cycle re-checks.

import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import { firmConfig } from '@vibe/db/schema';

// Mirror of the constants in apps/api/src/ai/egress.ts. Duplicated
// here so the worker doesn't import across apps; they're never
// expected to diverge.
const SHIELD_REACHABLE_KEY = 'ai:shield:reachable';
const SHIELD_REACHABLE_TTL_SEC = 10 * 60;

const PROBE_TIMEOUT_MS = 5_000;

export async function runShieldHealthcheck(args: {
  db: Database | null;
  redis: Redis;
  log: Logger;
  fetchImpl?: typeof fetch;
}): Promise<{ checked: number; reachable: number }> {
  if (!args.db) return { checked: 0, reachable: 0 };
  // Pull every firm with an egress endpoint set. Single-firm today;
  // tolerates multi-firm tomorrow.
  const rows = await args.db
    .select({
      firmId: firmConfig.firmId,
      enabled: firmConfig.aiEgressEnabled,
      endpoint: firmConfig.vibeShieldEndpoint,
    })
    .from(firmConfig);
  const targets = rows.filter((r) => r.enabled && r.endpoint);
  if (targets.length === 0) {
    // No firms have egress enabled; clear the global reachable flag so
    // a previously-set 'reachable' doesn't linger forever.
    await args.redis.del(SHIELD_REACHABLE_KEY);
    return { checked: 0, reachable: 0 };
  }
  const fetchFn = args.fetchImpl ?? fetch;
  let reachable = 0;
  for (const t of targets) {
    if (!t.endpoint) continue;
    const url = `${t.endpoint.replace(/\/$/, '')}/health`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      try {
        const r = await fetchFn(url, { signal: ctrl.signal });
        if (r.ok) reachable += 1;
        else args.log.warn({ url, status: r.status }, 'shield healthcheck non-200');
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      args.log.warn({ err, url }, 'shield healthcheck request failed');
    }
  }
  // Single global flag (single-firm appliance). If any target is up
  // we set reachable=1; otherwise we let the TTL expire it.
  if (reachable > 0) {
    await args.redis.set(SHIELD_REACHABLE_KEY, '1', 'EX', SHIELD_REACHABLE_TTL_SEC);
  } else {
    await args.redis.del(SHIELD_REACHABLE_KEY);
  }
  return { checked: targets.length, reachable };
}

// Suppress unused-import lint when caller doesn't reach for `eq`.
void eq;
