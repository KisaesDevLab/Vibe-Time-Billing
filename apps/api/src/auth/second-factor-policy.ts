// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0151 — firm-level staff second-factor policy (revises locked decision
// #5). One question, asked from two places: the password sign-in flow
// (skip the 2FA challenge?) and the step-up gates (let a stale session
// through?). Defaults to REQUIRED whenever the answer can't be read
// (no db, no settings row, query failure) so a degraded appliance never
// fails open.

import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { firmSettings } from '@vibe/db/schema';

export async function isSecondFactorRequired(
  db: Database | null,
  firmId: string,
): Promise<boolean> {
  if (!db) return true;
  try {
    const [row] = await db
      .select({ staffSecondFactorRequired: firmSettings.staffSecondFactorRequired })
      .from(firmSettings)
      .where(eq(firmSettings.firmId, firmId))
      .limit(1);
    return row?.staffSecondFactorRequired ?? true;
  } catch {
    return true;
  }
}
