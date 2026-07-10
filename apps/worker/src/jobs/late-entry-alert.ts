// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Late-entry alert (Phase 9 #15). Per-firm:
//   1. Read late_entry_alert_days from firm_settings (default 3).
//   2. For each timekeeper, find dates within the last alert window that
//      have no time entries.
//   3. Dispatch a friendly reminder via the firm's email provider.
//
// This is a digest-style job — one email per timekeeper per run, so the
// blast radius is bounded even if the worker is misconfigured.

import { and, eq, gte, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { appUsers, firmSettings, timeEntries } from '@vibe/db/schema';

import type { Logger } from 'pino';

export interface LateEntryAlertDeps {
  sendEmail?: (args: { to: string; subject: string; body: string }) => Promise<void>;
}

export async function runLateEntryAlert(
  db: Database,
  log: Logger,
  today = new Date().toISOString().slice(0, 10),
  deps: LateEntryAlertDeps = {},
): Promise<{ usersScanned: number; alertsSent: number }> {
  const allFirmSettings = await db.select().from(firmSettings);
  let usersScanned = 0;
  let alertsSent = 0;
  for (const fs of allFirmSettings) {
    const alertDays = fs.lateEntryAlertDays ?? 3;
    if (alertDays <= 0) continue;
    const since = new Date(Date.parse(today + 'T00:00:00Z') - alertDays * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const users = await db
      .select({ id: appUsers.id, email: appUsers.email, fullName: appUsers.fullName })
      .from(appUsers)
      .where(and(eq(appUsers.firmId, fs.firmId), eq(appUsers.status, 'ACTIVE')));
    for (const u of users) {
      usersScanned++;
      // Days within the window that have zero entries for this user.
      const dates = await db
        .select({
          d: sql<string>`generate_series(${since}::date, (${today}::date - INTERVAL '1 day'), '1 day')::date::text`.as(
            'd',
          ),
        })
        .from(sql`(SELECT 1) AS dummy`);
      const presentEntries = await db
        .select({ entryDate: timeEntries.entryDate })
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.appUserId, u.id),
            gte(timeEntries.entryDate, since),
            sql`${timeEntries.entryDate} < ${today}::date`,
          ),
        );
      const present = new Set(presentEntries.map((r) => r.entryDate));
      const missing = dates.map((r) => r.d).filter((d) => !present.has(d));
      if (missing.length === 0) continue;
      if (!deps.sendEmail) {
        log.info(
          { userId: u.id, missingCount: missing.length },
          'late entry alert (no dispatcher)',
        );
        continue;
      }
      try {
        await deps.sendEmail({
          to: u.email,
          subject: `Missing time entries (${missing.length} day${missing.length === 1 ? '' : 's'})`,
          body:
            `Hi ${u.fullName},\n\n` +
            `You haven't logged time for these dates in the last ${alertDays} day window:\n` +
            missing.map((d) => `  ${d}`).join('\n') +
            `\n\nPlease catch up when you get a chance.`,
        });
        alertsSent++;
      } catch (err) {
        log.error({ err, userId: u.id }, 'late entry alert dispatch failed');
      }
    }
  }
  return { usersScanned, alertsSent };
}
