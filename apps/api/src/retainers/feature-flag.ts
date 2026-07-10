// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Phase 14 of the retainer addendum — `retainers.enabled` (per-firm
// boolean, defaulting OFF). The same value also lives on
// firm_retainer_settings.feature_enabled; this helper memoizes the
// lookup so routes can call it without thinking about which path.
//
// Used by portal + dashboard endpoints to fall closed when a firm has
// not opted in. Offer creation is already gated in offers.ts; this
// helper handles every other surface so flipping the flag off cleanly
// hides existing data too.

import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { firmRetainerSettings } from '@vibe/db/schema';

export async function isRetainerFeatureEnabled(
  db: Database | null,
  firmId: string,
): Promise<boolean> {
  if (!db) return false;
  const [row] = await db
    .select({ enabled: firmRetainerSettings.featureEnabled })
    .from(firmRetainerSettings)
    .where(eq(firmRetainerSettings.firmId, firmId))
    .limit(1);
  return Boolean(row?.enabled);
}
