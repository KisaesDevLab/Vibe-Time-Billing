// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { useEffect, useState } from 'react';

import { Button, Card, Pill, tokens } from '@vibe/ui';

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
interface JobRunRow {
  id: string;
  status: string;
  itemCount: number | null;
  error: string | null;
  triggeredBy: string | null;
  startedAt: string;
  finishedAt: string | null;
}
interface PreviewResult {
  supported: boolean;
  count?: number;
  note: string;
}

export function JobsPage(): JSX.Element {
  const [jobs, setJobs] = useState<string[]>([]);
  const [stats, setStats] = useState<Record<string, QStat>>({});
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Record<string, PreviewResult | 'loading'>>({});
  const [runs, setRuns] = useState<Record<string, JobRunRow[]>>({});
  const [openHistory, setOpenHistory] = useState<Set<string>>(new Set());

  async function load(): Promise<void> {
    try {
      const r = await api<{ jobs: string[] }>('/api/staff/admin/jobs/known');
      setJobs(r.jobs ?? []);
    } catch {
      /* ignore */
    }
    try {
      const sc = await api<{ schedules: Record<string, boolean> }>(
        '/api/staff/admin/jobs/schedules',
      );
      setEnabled(sc.schedules ?? {});
    } catch {
      /* ignore */
    }
    try {
      const s = await api<{ stats: Record<string, QStat> }>('/api/staff/admin/jobs/stats');
      setStats(s.stats ?? {});
    } catch {
      /* stats requires redis; OK to ignore */
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function toggle(name: string): Promise<void> {
    const next = !(enabled[name] ?? true);
    setEnabled((s) => ({ ...s, [name]: next }));
    try {
      await api(`/api/staff/admin/jobs/${name}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: next }),
      });
    } catch {
      setEnabled((s) => ({ ...s, [name]: !next })); // revert on failure
    }
  }

  async function doPreview(name: string): Promise<void> {
    setPreview((s) => ({ ...s, [name]: 'loading' }));
    try {
      const r = await api<PreviewResult>(`/api/staff/admin/jobs/${name}/preview`, {
        method: 'POST',
      });
      setPreview((s) => ({ ...s, [name]: r }));
    } catch {
      setPreview((s) => ({ ...s, [name]: { supported: false, note: 'preview failed' } }));
    }
  }

  async function toggleHistory(name: string): Promise<void> {
    setOpenHistory((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });
    if (!runs[name]) {
      try {
        const r = await api<{ runs: JobRunRow[] }>(`/api/staff/admin/jobs/${name}/runs`);
        setRuns((s) => ({ ...s, [name]: r.runs ?? [] }));
      } catch {
        setRuns((s) => ({ ...s, [name]: [] }));
      }
    }
  }

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

  const previewText = (p: PreviewResult | 'loading' | undefined): string => {
    if (p === undefined) return '';
    if (p === 'loading') return 'previewing…';
    return p.supported ? `${p.count} item(s) — ${p.note}` : p.note;
  };

  const runTone = (s: string): 'success' | 'danger' | 'neutral' | 'warning' =>
    s === 'completed'
      ? 'success'
      : s === 'failed'
        ? 'danger'
        : s === 'skipped'
          ? 'warning'
          : 'neutral';

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 960 }}>
      <Card title="Scheduled jobs">
        <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 0 }}>
          Each job runs on a worker cron. Toggle a job off to skip its runs, preview what it would
          act on, run it on demand, or view recent run history.
        </p>
        <div style={{ display: 'grid', gap: 12 }}>
          {jobs.map((j) => {
            const isEnabled = enabled[j] ?? true;
            return (
              <div
                key={j}
                style={{
                  padding: '8px 12px',
                  borderRadius: tokens.radius.sm,
                  background: tokens.color.surface,
                  opacity: isEnabled ? 1 : 0.6,
                }}
              >
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr auto',
                    gap: 12,
                    alignItems: 'center',
                  }}
                >
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>
                      {j} {!isEnabled && <Pill tone="warning">disabled</Pill>}
                    </div>
                    <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
                      {JOB_DESCRIPTIONS[j] ?? ''}
                    </div>
                    {stats[j] && (
                      <div style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 4 }}>
                        waiting {stats[j]!.waiting} · active {stats[j]!.active} · delayed{' '}
                        {stats[j]!.delayed} · failed {stats[j]!.failed}
                      </div>
                    )}
                    {(preview[j] !== undefined || status[j]) && (
                      <div style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 4 }}>
                        {previewText(preview[j])}
                        {status[j] ? ` · ${status[j]}` : ''}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <input type="checkbox" checked={isEnabled} onChange={() => void toggle(j)} />
                      enabled
                    </label>
                    <Button size="sm" variant="secondary" onClick={() => void doPreview(j)}>
                      Preview
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => void toggleHistory(j)}>
                      History
                    </Button>
                    <Button size="sm" disabled={running.has(j)} onClick={() => void run(j)}>
                      Run now
                    </Button>
                  </div>
                </div>
                {openHistory.has(j) && (
                  <div style={{ marginTop: 8, fontSize: 12 }}>
                    {(runs[j] ?? []).length === 0 ? (
                      <span style={{ color: tokens.color.textMuted }}>No runs recorded yet.</span>
                    ) : (
                      <div style={{ display: 'grid', gap: 4 }}>
                        {(runs[j] ?? []).map((r) => (
                          <div key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <Pill tone={runTone(r.status)}>{r.status}</Pill>
                            <span style={{ color: tokens.color.textMuted }}>
                              {new Date(r.startedAt).toLocaleString()}
                              {r.triggeredBy ? ` · ${r.triggeredBy}` : ''}
                              {r.error ? ` · ${r.error}` : ''}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
