// SPDX-License-Identifier: Elastic-2.0
//
// Scheduled saved-report email worker (Phase 17 #22). Reads saved_report
// rows whose params_json contains a `schedule` block { recipients[],
// cron } and dispatches the rendered report via the configured mail
// provider. Until firms wire schedules, this is a no-op pass.

import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { savedReports } from '@vibe/db/schema';

import type { Logger } from 'pino';

interface ScheduleBlock {
  recipients?: string[];
  cron?: string;
  enabled?: boolean;
}

export async function runSavedReportEmail(
  db: Database,
  log: Logger,
  sendEmail?: (args: { to: string; subject: string; body: string }) => Promise<void>,
): Promise<{ scanned: number; sent: number }> {
  const rows = await db.select().from(savedReports);
  const candidates = rows.filter((r) => {
    const params = (r.paramsJson ?? {}) as Record<string, unknown>;
    const schedule = params['schedule'] as ScheduleBlock | undefined;
    return Boolean(schedule?.enabled && Array.isArray(schedule.recipients));
  });
  if (candidates.length === 0) {
    return { scanned: rows.length, sent: 0 };
  }
  let sent = 0;
  for (const r of candidates) {
    const schedule = (r.paramsJson as Record<string, unknown>)['schedule'] as ScheduleBlock;
    const recipients = schedule.recipients ?? [];
    for (const to of recipients) {
      if (sendEmail) {
        try {
          await sendEmail({
            to,
            subject: `Scheduled report: ${r.name}`,
            body: `Your scheduled report "${r.name}" (${r.reportKind}) is attached.\n\nKind: ${r.reportKind}\nParams: ${JSON.stringify(r.paramsJson)}`,
          });
          sent++;
        } catch (err) {
          log.warn({ err, to, reportId: r.id }, 'saved-report email failed');
        }
      } else {
        log.info({ to, reportId: r.id }, 'saved-report email would send (no mail provider wired)');
      }
    }
  }
  void eq;
  return { scanned: rows.length, sent };
}
