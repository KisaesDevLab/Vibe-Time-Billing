// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0233 — merge-writes into firm_settings.sms_health. Each component owns a
// section (webhook / poll / send / media / lines) and must never clobber a
// sibling, so writes go through jsonb_set on the section. Zod-free.

import { eq, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { firmSettings, type SmsHealth } from '@vibe/db/schema';

type Section = keyof SmsHealth;

export async function mergeSmsHealth<K extends Section>(
  db: Database,
  firmId: string,
  section: K,
  patch: NonNullable<SmsHealth[K]>,
): Promise<void> {
  const path = `{${section}}`;
  const json = JSON.stringify(patch);
  await db
    .update(firmSettings)
    .set({
      smsHealth: sql`jsonb_set(
        coalesce(${firmSettings.smsHealth}, '{}'::jsonb),
        ${path}::text[],
        coalesce(${firmSettings.smsHealth} -> ${section}, '{}'::jsonb) || ${json}::jsonb,
        true
      )`,
    })
    .where(eq(firmSettings.firmId, firmId));
}

/** Read one firm's SmsHealth (empty object when unset). */
export async function readSmsHealth(db: Database, firmId: string): Promise<SmsHealth> {
  const [row] = await db
    .select({ h: firmSettings.smsHealth })
    .from(firmSettings)
    .where(eq(firmSettings.firmId, firmId))
    .limit(1);
  return (row?.h ?? {}) as SmsHealth;
}
