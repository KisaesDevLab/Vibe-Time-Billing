// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Dry-run preview for background jobs: read-only "what would this job act on
// right now" counts, so an operator can sanity-check before a manual run.
// Every probe is wrapped so a schema mismatch degrades to { supported:false }
// rather than erroring. Jobs with no meaningful candidate set report
// supported:false with a note.

import { sql, type SQL } from 'drizzle-orm';

import type { Database } from '@vibe/db';

export interface JobPreview {
  supported: boolean;
  count?: number;
  note: string;
}

async function countRows(db: Database, query: SQL): Promise<number> {
  const r = await db.execute(query);
  const rows =
    (r as unknown as { rows?: Array<Record<string, unknown>> }).rows ??
    (r as unknown as Array<Record<string, unknown>>);
  const first = Array.isArray(rows) ? rows[0] : undefined;
  return first ? Number(Object.values(first)[0] ?? 0) : 0;
}

type Probe = { note: string; query?: SQL };

// One probe per job. `query` returns a single count of candidate rows; jobs
// without a clean candidate query omit it (→ supported:false).
const PROBES: Record<string, Probe> = {
  'recurring-billing': {
    note: 'Active recurring plans due to bill (next_run_date ≤ today).',
    query: sql`SELECT COUNT(*) FROM vibetb.recurring_billing_plan WHERE status = 'ACTIVE' AND next_run_date <= CURRENT_DATE`,
  },
  'ar-aging-snapshot': {
    note: 'Open invoices that would be captured in the snapshot.',
    query: sql`SELECT COUNT(*) FROM vibetb.invoice WHERE status IN ('SENT','PARTIALLY_PAID','OVERDUE')`,
  },
  'dunning-sweep': {
    note: 'Overdue invoices eligible for a dunning step.',
    query: sql`SELECT COUNT(*) FROM vibetb.invoice WHERE status = 'OVERDUE'`,
  },
  'late-fee-accrual': {
    note: 'Overdue invoices that may accrue a late fee.',
    query: sql`SELECT COUNT(*) FROM vibetb.invoice WHERE status = 'OVERDUE'`,
  },
  'approval-escalation': {
    note: 'Pending approval requests that may escalate.',
    query: sql`SELECT COUNT(*) FROM vibetb.approval_request WHERE status = 'PENDING'`,
  },
  'webhook-dispatch': {
    note: 'Pending webhook deliveries ready to send (next_attempt_at ≤ now).',
    query: sql`SELECT COUNT(*) FROM vibetb.webhook_delivery WHERE status = 'PENDING' AND next_attempt_at <= now()`,
  },
  'scope-creep-alert': {
    note: 'Mixed-mode engagements scanned for out-of-scope creep.',
    query: sql`SELECT COUNT(*) FROM vibetb.engagement WHERE mixed_mode_enabled = true`,
  },
  'wip-age-alert': {
    note: 'Unbilled, submitted time entries (aged-WIP candidates).',
    query: sql`SELECT COUNT(*) FROM vibetb.time_entry WHERE billing_batch_id IS NULL AND status = 'SUBMITTED'`,
  },
  'saved-report-email': {
    note: 'Saved report definitions considered for scheduled email.',
    query: sql`SELECT COUNT(*) FROM vibetb.saved_report`,
  },
  // No clean candidate query — describe what the job does instead.
  'view-refresh': { note: 'Refreshes materialized views; nothing to preview.' },
  'late-entry-alert': { note: 'Flags stale unsubmitted time; no row-level preview.' },
  'milestone-date-trigger': { note: 'Fires milestone date triggers; no row-level preview.' },
  'hour-bank-expiration': { note: 'Expires lapsed hour banks; no row-level preview.' },
  'hour-bank-replenish': { note: 'Replenishes recurring hour banks; no row-level preview.' },
  'auto-rollover-scan': { note: 'Scans engagements for rollover; no row-level preview.' },
  'retention-enforcement': { note: 'Enforces data-retention policy; no row-level preview.' },
  'audit-anomaly': { note: 'Statistical audit-log anomaly scan; no row-level preview.' },
  'email-in': { note: 'Polls the inbound mailbox; no row-level preview.' },
};

export async function previewJob(db: Database, name: string): Promise<JobPreview> {
  const probe = PROBES[name];
  if (!probe) return { supported: false, note: 'Unknown job.' };
  if (!probe.query) return { supported: false, note: probe.note };
  try {
    const count = await countRows(db, probe.query);
    return { supported: true, count, note: probe.note };
  } catch {
    return { supported: false, note: `${probe.note} (preview unavailable)` };
  }
}
