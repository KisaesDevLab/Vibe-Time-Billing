// SPDX-License-Identifier: Elastic-2.0
//
// Scheduled saved-report email worker (Phase 17 #22). Reads saved_report
// rows whose params_json contains a `schedule` block { recipients[],
// cron, enabled } and dispatches a notification email via the configured
// mail provider. The email carries a deep link into the report with the
// saved filters applied (report data is not rendered in the worker).

import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { savedReports } from '@vibe/db/schema';

import type { Logger } from 'pino';

interface ScheduleBlock {
  recipients?: string[];
  cron?: string;
  enabled?: boolean;
  /** ISO timestamp of the last successful dispatch (worker-maintained). */
  lastSentAt?: string;
}

// Minimal cron *day* matcher. Evaluates the day-of-month, month and
// day-of-week fields ("*", "N", "N,M", "N-M", "*/N") of a 5-field cron
// against a date. Minute/hour are ignored — dispatch cadence is governed
// by the worker's own job schedule; this only decides WHICH runs send.
// (The cron field used to be stored but never evaluated, so every enabled
// report emailed on every run regardless of its configured schedule.)
function cronDayMatches(cron: string | undefined, d: Date): boolean {
  if (!cron || !cron.trim()) return true;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return true; // unparseable → treat as "any day"
  const match = (expr: string, value: number): boolean => {
    if (expr === '*') return true;
    return expr.split(',').some((tok) => {
      const step = /^\*\/(\d+)$/.exec(tok);
      if (step) return value % Number(step[1]) === 0;
      const range = /^(\d+)-(\d+)$/.exec(tok);
      if (range) return value >= Number(range[1]) && value <= Number(range[2]);
      return Number(tok) === value;
    });
  };
  const dom = parts[2]!;
  const mon = parts[3]!;
  const dow = parts[4]!;
  return match(dom, d.getUTCDate()) && match(mon, d.getUTCMonth() + 1) && match(dow, d.getUTCDay());
}

// Deep link into the web app with the saved filters applied. Mirrors the
// admin Saved-reports "Open" mapping: realization renders on the hub
// (dimension → dim), everything else on the generic viewer.
function reportHref(base: string, kind: string, params: Record<string, unknown>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (k === 'schedule' || v == null || typeof v === 'object') continue;
    qs.set(kind === 'realization' && k === 'dimension' ? 'dim' : k, String(v));
  }
  const path = kind === 'realization' ? '/reports' : `/reports/view/${kind}`;
  const q = qs.toString();
  return `${base.replace(/\/$/, '')}${path}${q ? `?${q}` : ''}`;
}

export async function runSavedReportEmail(
  db: Database,
  log: Logger,
  sendEmail?: (args: { to: string; subject: string; body: string }) => Promise<void>,
  appBaseUrl?: string,
): Promise<{ scanned: number; sent: number; skipped: number }> {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const rows = await db.select().from(savedReports);
  let sent = 0;
  let skipped = 0;
  for (const r of rows) {
    const params = (r.paramsJson ?? {}) as Record<string, unknown>;
    const schedule = params['schedule'] as ScheduleBlock | undefined;
    if (!schedule?.enabled || !Array.isArray(schedule.recipients)) continue;
    // Honor the configured cron (day granularity) and never double-send on
    // the same day (e.g. when the job is re-run manually from Admin → Jobs).
    if (!cronDayMatches(schedule.cron, now)) {
      skipped++;
      continue;
    }
    if (schedule.lastSentAt && schedule.lastSentAt.slice(0, 10) === today) {
      skipped++;
      continue;
    }
    const filters = Object.entries(params)
      .filter(([k, v]) => k !== 'schedule' && v != null && typeof v !== 'object')
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(', ');
    const link = appBaseUrl ? reportHref(appBaseUrl, r.reportKind, params) : null;
    const body =
      `This is your scheduled reminder for the saved report "${r.name}" (${r.reportKind}).\n\n` +
      (filters ? `Saved filters — ${filters}\n\n` : '') +
      (link
        ? `Open the report with these filters applied:\n${link}\n`
        : `Open the Reports page in the app and load the saved report "${r.name}" to view it.\n`);
    let delivered = 0;
    for (const to of schedule.recipients ?? []) {
      if (sendEmail) {
        try {
          await sendEmail({ to, subject: `Scheduled report: ${r.name}`, body });
          delivered++;
          sent++;
        } catch (err) {
          log.warn({ err, to, reportId: r.id }, 'saved-report email failed');
        }
      } else {
        log.info({ to, reportId: r.id }, 'saved-report email would send (no mail provider wired)');
      }
    }
    if (delivered > 0) {
      // Record the dispatch inside the schedule block so re-runs today no-op.
      await db
        .update(savedReports)
        .set({
          paramsJson: { ...params, schedule: { ...schedule, lastSentAt: now.toISOString() } },
          updatedAt: now,
        })
        .where(eq(savedReports.id, r.id))
        .catch((err: unknown) =>
          log.warn({ err, reportId: r.id }, 'saved-report lastSentAt update failed'),
        );
    }
  }
  return { scanned: rows.length, sent, skipped };
}
