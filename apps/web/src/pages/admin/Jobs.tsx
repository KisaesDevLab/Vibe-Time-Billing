// SPDX-License-Identifier: Elastic-2.0
import { useEffect, useState } from 'react';

import { Button, Card, tokens } from '@vibe/ui';

import { api } from '../../api-client';

const JOB_DESCRIPTIONS: Record<string, string> = {
  'recurring-billing': 'Generate invoices for plans whose next_run_date has arrived.',
  'ar-aging-snapshot': 'Snapshot AR aging buckets per client/firm.',
  'view-refresh': 'Refresh realization/utilization/profitability materialized views.',
  'dunning-sweep': 'Send dunning steps for overdue invoices; record to dunning_history.',
  'late-fee-accrual': 'Add late-fee line items to overdue invoices.',
  'late-entry-alert': 'Email staff who missed time-entry days in the alert window.',
  'milestone-date-trigger': 'Mark date-triggered milestones as TRIGGERED.',
  'hour-bank-expiration': 'Expire hour-bank residual at the expiration date.',
  'approval-escalation': 'Reassign stale approvals back to the unassigned pool.',
};

interface QStat {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

export function JobsPage(): JSX.Element {
  const [jobs, setJobs] = useState<string[]>([]);
  const [stats, setStats] = useState<Record<string, QStat>>({});
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<Record<string, string>>({});

  async function load(): Promise<void> {
    try {
      const r = await api<{ jobs: string[] }>('/api/staff/admin/jobs/known');
      setJobs(r.jobs ?? []);
    } catch {
      // ignore
    }
    try {
      const s = await api<{ stats: Record<string, QStat> }>('/api/staff/admin/jobs/stats');
      setStats(s.stats ?? {});
    } catch {
      // stats requires redis; OK to ignore
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function run(name: string): Promise<void> {
    setRunning((s) => new Set(s).add(name));
    setStatus((s) => ({ ...s, [name]: 'enqueuing…' }));
    try {
      await api(`/api/staff/admin/jobs/run/${name}`, { method: 'POST' });
      setStatus((s) => ({ ...s, [name]: 'enqueued' }));
    } catch (err) {
      setStatus((s) => ({
        ...s,
        [name]: err instanceof Error ? `failed: ${err.message}` : 'failed',
      }));
    } finally {
      setRunning((s) => {
        const next = new Set(s);
        next.delete(name);
        return next;
      });
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 900 }}>
      <Card title="Scheduled jobs">
        <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 0 }}>
          Each job has a cron schedule in the worker. Click <em>Run now</em> to enqueue a one-off
          run from the API.
        </p>
        <div style={{ display: 'grid', gap: 12 }}>
          {jobs.map((j) => (
            <div
              key={j}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto auto',
                gap: 12,
                alignItems: 'center',
                padding: '8px 12px',
                borderRadius: tokens.radius.sm,
                background: tokens.color.surface,
              }}
            >
              <div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{j}</div>
                <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
                  {JOB_DESCRIPTIONS[j] ?? ''}
                </div>
                {stats[j] && (
                  <div style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 4 }}>
                    waiting {stats[j]!.waiting} · active {stats[j]!.active} · delayed{' '}
                    {stats[j]!.delayed} · failed {stats[j]!.failed}
                  </div>
                )}
              </div>
              <span style={{ fontSize: 12, color: tokens.color.textMuted }}>{status[j] ?? ''}</span>
              <Button size="sm" disabled={running.has(j)} onClick={() => void run(j)}>
                Run now
              </Button>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
