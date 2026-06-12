// SPDX-License-Identifier: Elastic-2.0
//
// 0155 — Route Sheet dialog. Opened from the client-list Printer button.
// Lists the client's uncompleted engagements; staff tick the ones to
// route, optionally change each one's workflow status (e.g. → Ready),
// add a note, and "Print & Log". On submit the status changes are
// committed + recorded and the generated PDF opens in a new tab. A
// "Recent route sheets" section reprints prior sheets.

import { useCallback, useEffect, useState } from 'react';

import { Button, Card, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface EngagementRow {
  id: string;
  name: string;
  workflowState: string;
  period: string | null;
  dueDate: string | null;
}
interface StatusOption {
  workflowState: string;
  label: string;
  sortOrder: number;
}
interface HistoryRow {
  id: string;
  note: string | null;
  printedAt: string;
  staffName: string | null;
  engagementCount: number;
}

const BASE = '/api/staff/route-sheets';

export function RouteSheetDialog({
  clientId,
  clientName,
  onClose,
}: {
  clientId: string;
  clientName: string;
  onClose: () => void;
}): JSX.Element {
  const [engagements, setEngagements] = useState<EngagementRow[]>([]);
  const [statusOptions, setStatusOptions] = useState<StatusOption[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Per-engagement chosen workflow state (defaults to current).
  const [stateById, setStateById] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadHistory = useCallback(async (): Promise<void> => {
    const h = await api<{ items: HistoryRow[] }>(`${BASE}/client/${clientId}/history`);
    setHistory(h.items ?? []);
  }, [clientId]);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: EngagementRow[]; statusOptions: StatusOption[] }>(
          `${BASE}/client/${clientId}/engagements`,
        );
        setEngagements(r.items ?? []);
        setStatusOptions(r.statusOptions ?? []);
        setStateById(Object.fromEntries((r.items ?? []).map((e) => [e.id, e.workflowState])));
        await loadHistory();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed to load engagements');
      } finally {
        setLoading(false);
      }
    })();
  }, [clientId, loadHistory]);

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function printSheet(): Promise<void> {
    const items = engagements
      .filter((e) => selected.has(e.id))
      .map((e) => ({ engagementId: e.id, workflowState: stateById[e.id] ?? e.workflowState }));
    if (items.length === 0) {
      setError('Select at least one engagement.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ printId: string }>(`${BASE}/print`, {
        method: 'POST',
        body: JSON.stringify({ clientId, note: note.trim() || undefined, items }),
      });
      // Open the generated PDF (inline → browser print dialog).
      window.open(`${BASE}/${r.printId}/pdf`, '_blank', 'noopener,noreferrer');
      await loadHistory();
      setSelected(new Set());
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'print failed';
      setError(msg === 'render_failed' ? 'Could not render the PDF. Try again.' : msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Route sheet for ${clientName}`}
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
      <div style={{ width: 'min(720px, 94vw)', maxHeight: '88vh', overflow: 'auto' }}>
        <Card title={`Route sheet — ${clientName}`}>
          {error && (
            <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
              {error}
            </p>
          )}

          {loading ? (
            <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
          ) : (
            <div style={{ display: 'grid', gap: 14 }}>
              <div>
                <div
                  style={{
                    fontSize: 11,
                    textTransform: 'uppercase',
                    color: tokens.color.textMuted,
                    fontWeight: 600,
                    marginBottom: 6,
                  }}
                >
                  Uncompleted engagements
                </div>
                {engagements.length === 0 ? (
                  <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
                    No uncompleted engagements for this client.
                  </p>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: tokens.color.surface }}>
                        <th style={th('center')}>{''}</th>
                        <th style={th()}>Engagement</th>
                        <th style={th()}>Period</th>
                        <th style={th()}>Status → set to</th>
                      </tr>
                    </thead>
                    <tbody>
                      {engagements.map((e) => (
                        <tr key={e.id} style={{ borderTop: `1px solid ${tokens.color.border}` }}>
                          <td style={{ ...td(), textAlign: 'center' }}>
                            <input
                              type="checkbox"
                              aria-label={`Include ${e.name}`}
                              checked={selected.has(e.id)}
                              onChange={() => toggle(e.id)}
                            />
                          </td>
                          <td style={td()}>{e.name}</td>
                          <td style={{ ...td(), color: tokens.color.textMuted }}>
                            {e.period ?? '—'}
                          </td>
                          <td style={td()}>
                            <select
                              aria-label={`Status for ${e.name}`}
                              value={stateById[e.id] ?? e.workflowState}
                              onChange={(ev) =>
                                setStateById((prev) => ({ ...prev, [e.id]: ev.target.value }))
                              }
                              style={selectStyle}
                            >
                              {statusOptions.map((s) => (
                                <option key={s.workflowState} value={s.workflowState}>
                                  {s.label}
                                </option>
                              ))}
                            </select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div style={{ display: 'grid', gap: 4 }}>
                <label
                  htmlFor="route-sheet-note"
                  style={{ fontSize: 11, color: tokens.color.textMuted }}
                >
                  Note to print on the sheet (Special Instructions)
                </label>
                <textarea
                  id="route-sheet-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  placeholder="e.g. Client prefers pickup; call before 4pm."
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    padding: 8,
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.sm,
                    background: tokens.color.bg,
                    color: tokens.color.text,
                    fontSize: 13,
                    resize: 'vertical',
                  }}
                />
              </div>

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <Button variant="ghost" onClick={onClose} disabled={busy}>
                  Close
                </Button>
                <Button onClick={() => void printSheet()} disabled={busy || selected.size === 0}>
                  {busy ? 'Printing…' : `Print & Log (${selected.size})`}
                </Button>
              </div>

              {history.length > 0 && (
                <div style={{ borderTop: `1px solid ${tokens.color.border}`, paddingTop: 10 }}>
                  <div
                    style={{
                      fontSize: 11,
                      textTransform: 'uppercase',
                      color: tokens.color.textMuted,
                      fontWeight: 600,
                      marginBottom: 6,
                    }}
                  >
                    Recent route sheets
                  </div>
                  <div style={{ display: 'grid', gap: 4 }}>
                    {history.map((h) => (
                      <div
                        key={h.id}
                        style={{
                          display: 'flex',
                          gap: 8,
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          fontSize: 12,
                        }}
                      >
                        <span style={{ color: tokens.color.textMuted }}>
                          {new Date(h.printedAt).toLocaleString()} · {h.staffName ?? 'staff'} ·{' '}
                          {h.engagementCount} eng.
                          {h.note ? ` · "${h.note.slice(0, 40)}"` : ''}
                        </span>
                        <a
                          href={`${BASE}/${h.id}/pdf`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: tokens.color.accent, textDecoration: 'none' }}
                        >
                          Reprint
                        </a>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function th(align: 'left' | 'center' = 'left'): React.CSSProperties {
  return {
    textAlign: align,
    padding: '8px',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    color: tokens.color.textMuted,
    fontWeight: 600,
    borderBottom: `1px solid ${tokens.color.border}`,
  };
}
function td(): React.CSSProperties {
  return { padding: '8px', fontSize: 13, verticalAlign: 'middle' };
}
const selectStyle: React.CSSProperties = {
  padding: '4px 6px',
  fontSize: 13,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  background: tokens.color.bg,
  color: tokens.color.text,
};
