// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Single-firm-per-appliance resolver for the anonymous intake surface.
// Unauthenticated callers carry no session, so "which firm" is simply the
// lone firm row (CLAUDE.md #1 — no multi-tenant). Cached after first read
// since it never changes for the life of the process.

import type { Database } from '@vibe/db';
import { firms } from '@vibe/db/schema';

let cachedFirmId: string | null = null;

/** The appliance's single firm id, or null if none is bootstrapped yet. */
export async function resolveApplianceFirmId(db: Database | null): Promise<string | null> {
  if (cachedFirmId) return cachedFirmId;
  if (!db) return null;
  const [row] = await db.select({ id: firms.id }).from(firms).limit(1);
  cachedFirmId = row?.id ?? null;
  return cachedFirmId;
}

/** Test hook — clear the memoized firm id between cases. */
export function resetApplianceFirmIdForTests(): void {
  cachedFirmId = null;
}
