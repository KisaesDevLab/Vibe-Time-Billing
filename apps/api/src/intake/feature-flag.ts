// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0103 — Document Intake feature gate. The public intake surface and the
// staff Intake Inbox are off by default; a firm turns them on via
// firm_config.intake_enabled (admin settings). The public router and the
// inbox both consult this before doing any work, so the feature fails
// closed when the flag is absent or the DB is unavailable.

import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { firmConfig } from '@vibe/db/schema';

/** True only when this firm has the intake feature switched on. */
export async function isIntakeEnabled(db: Database | null, firmId: string): Promise<boolean> {
  if (!db) return false;
  const [row] = await db
    .select({ enabled: firmConfig.intakeEnabled })
    .from(firmConfig)
    .where(eq(firmConfig.firmId, firmId))
    .limit(1);
  return Boolean(row?.enabled);
}
