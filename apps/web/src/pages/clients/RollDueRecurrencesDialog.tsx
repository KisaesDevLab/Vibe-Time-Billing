// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Firm-wide bulk dialog for engagement recurrences. Opens from the
// Clients list header. Fetches every ACTIVE recurrence flagged isDue
// (SCHEDULE && nextRunDate<=today OR ON_COMPLETION && previous engagement
// closed/none), defaults every row to selected, and fires bulk-run on
// confirm. Per-row results render so partners can see which rows were
// spawned vs queued for approval (Q23 collision).

import { useEffect, useState } from 'react';

import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface DueRow {
  id: string;
  clientName: string;
  templateName: string;
  frequency: string;
  triggerMode: 'SCHEDULE' | 'ON_COMPLETION';
  nextRunDate: string | null;
  lastEngagementName: string | null;
  lastEngagementStatus: string | null;
}

interface RunResult {
  recurrenceId: string;
  kind: string;
  name?: string;
  engagementId?: string;
  reason?: string;
}

interface Props {
  onClose: () => void;
}

export function RollDueRecurrencesDialog({ onClose }: Props): JSX.Element {
  const [rows, setRows] = useState<DueRow[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{
    summary: Record<string, number>;
    items: RunResult[];
  } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: DueRow[] }>('/api/staff/engagement-recurrences?dueOnly=true');
        setRows(r.items ?? []);
        // Default-select everything so the common path is a single
        // confirm click.
        setSelected(new Set((r.items ?? []).map((x) => x.id)));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'load_failed');
        setRows([]);
      }
    })();
  }, []);

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function run(): Promise<void> {
    if (selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{
        results: RunResult[];
        summary: Record<string, number>;
      }>('/api/staff/engagement-recurrences/bulk-run', {
        method: 'POST',
        body: JSON.stringify({ recurrenceIds: Array.from(selected) }),
      });
      setResults({ summary: r.summary, items: r.results });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'run_failed');
    } finally {
      setBusy(false);
    }
  }

  const total = rows?.length ?? 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 48,
        zIndex: 200,
      }}
    >
      <div style={{ minWidth: 720, maxWidth: 920, maxHeight: '85vh', overflow: 'auto' }}>
        <Card title="Roll due recurring engagements (firm-wide)">
          {error && (
            <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
              {error}
            </p>
          )}
          {rows == null ? (
            <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
          ) : rows.length === 0 ? (
            <>
              <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
                Nothing is due to roll right now. The worker also checks daily and spawns
                automatically.
              </p>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                <Button variant="ghost" onClick={onClose}>
                  Close
                </Button>
              </div>
            </>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 12, marginBottom: 8, fontSize: 12 }}>
                <span>
                  Selected: <strong>{selected.size}</strong> / {total}
                </span>
                <button
                  type="button"
                  onClick={() => setSelected(new Set(rows.map((r) => r.id)))}
                  style={linkBtnStyle()}
                >
                  Select all
                </button>
                <button type="button" onClick={() => setSelected(new Set())} style={linkBtnStyle()}>
                  Clear
                </button>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${tokens.color.border}` }}>
                    <th style={th()}></th>
                    <th style={th('left')}>Client</th>
                    <th style={th('left')}>Template</th>
                    <th style={th('left')}>Cadence</th>
                    <th style={th('left')}>Trigger</th>
                    <th style={th('left')}>Last engagement</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const result = results?.items.find((x) => x.recurrenceId === r.id);
                    return (
                      <tr
                        key={r.id}
                        style={{
                          borderBottom: `1px solid ${tokens.color.border}`,
                          background: result ? tokens.color.surface : 'transparent',
                        }}
                      >
                        <td style={td()}>
                          <input
                            type="checkbox"
                            checked={selected.has(r.id)}
                            onChange={() => toggle(r.id)}
                            disabled={busy || results != null}
                          />
                        </td>
                        <td style={td()}>{r.clientName}</td>
                        <td style={td()}>{r.templateName}</td>
                        <td style={td()}>
                          <Pill>{r.frequency}</Pill>
                        </td>
                        <td style={td()}>
                          {r.triggerMode === 'SCHEDULE' ? `on ${r.nextRunDate ?? '—'}` : 'on close'}
                        </td>
                        <td style={td()}>
                          {result ? (
                            <Pill
                              tone={
                                result.kind === 'spawned'
                                  ? 'success'
                                  : result.kind === 'approval_queued'
                                    ? 'warning'
                                    : result.kind === 'skipped'
                                      ? 'neutral'
                                      : 'danger'
                              }
                            >
                              {result.kind === 'spawned'
                                ? `spawned: ${result.name ?? ''}`
                                : result.kind === 'approval_queued'
                                  ? 'approval queued'
                                  : result.kind === 'skipped'
                                    ? `skipped (${result.reason})`
                                    : `error (${result.reason})`}
                            </Pill>
                          ) : r.lastEngagementName ? (
                            <span style={{ fontSize: 12 }}>
                              {r.lastEngagementName}{' '}
                              <span style={{ color: tokens.color.textMuted }}>
                                ({r.lastEngagementStatus})
                              </span>
                            </span>
                          ) : (
                            <span style={{ color: tokens.color.textMuted, fontSize: 12 }}>
                              none yet
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {results && (
                <p style={{ fontSize: 13, marginTop: 12 }}>
                  <strong>Done.</strong>{' '}
                  {Object.entries(results.summary)
                    .map(([k, v]) => `${v} ${k}`)
                    .join(' · ')}
                </p>
              )}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                <Button variant="ghost" onClick={onClose}>
                  {results ? 'Close' : 'Cancel'}
                </Button>
                {!results && (
                  <Button disabled={busy || selected.size === 0} onClick={() => void run()}>
                    {busy
                      ? 'Running…'
                      : `Roll ${selected.size} recurrence${selected.size === 1 ? '' : 's'}`}
                  </Button>
                )}
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

function th(align: 'left' | 'right' = 'left'): React.CSSProperties {
  return {
    textAlign: align,
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    color: tokens.color.textMuted,
    padding: '6px 8px',
  };
}
function td(): React.CSSProperties {
  return { padding: '6px 8px', verticalAlign: 'middle' };
}
function linkBtnStyle(): React.CSSProperties {
  return {
    background: 'none',
    border: 'none',
    color: tokens.color.accent,
    fontSize: 12,
    cursor: 'pointer',
    padding: 0,
  };
}
