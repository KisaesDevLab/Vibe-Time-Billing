// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// 0050 — engagement workflow-state config. Per-firm overrides on the
// pgEnum (workflow_state) values: label, color, sort order, kanban
// visibility, and the "fires client communication on entry" flag.
// Rows are seeded by migration; only edit is exposed.
import { useEffect, useState } from 'react';

import { Button, Card, Input, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface StatusConfigRow {
  firmId: string;
  workflowState: string;
  label: string;
  color: string;
  sortOrder: number;
  kanbanVisible: boolean;
  triggersClientComm: boolean;
}

export function EngagementStatusesPage(): JSX.Element {
  const [rows, setRows] = useState<StatusConfigRow[]>([]);
  const [edits, setEdits] = useState<Record<string, Partial<StatusConfigRow>>>({});
  const [savingState, setSavingState] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load(): Promise<void> {
    const r = await api<{ items: StatusConfigRow[] }>('/api/staff/admin/engagement-statuses');
    setRows(r.items ?? []);
    setEdits({});
  }
  useEffect(() => {
    void load();
  }, []);

  function patch(state: string, change: Partial<StatusConfigRow>): void {
    setEdits((prev) => ({ ...prev, [state]: { ...prev[state], ...change } }));
  }

  async function save(state: string): Promise<void> {
    const e = edits[state];
    if (!e || Object.keys(e).length === 0) return;
    setSavingState(state);
    setErr(null);
    try {
      await api(`/api/staff/admin/engagement-statuses/${state}`, {
        method: 'PATCH',
        body: JSON.stringify(e),
      });
      await load();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'save_failed');
    } finally {
      setSavingState(null);
    }
  }

  function effective(row: StatusConfigRow): StatusConfigRow {
    return { ...row, ...edits[row.workflowState] };
  }

  function isDirty(state: string): boolean {
    return Boolean(edits[state] && Object.keys(edits[state]!).length > 0);
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title="Engagement statuses">
        <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 0, marginBottom: 12 }}>
          Customize the labels, colors, kanban visibility, and automation flags for each engagement
          workflow state. New rows cannot be added — the underlying state set is fixed.
        </p>
        {err && <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }}>{err}</p>}
        <Table<StatusConfigRow>
          columns={[
            {
              key: 'state',
              header: 'State',
              render: (r) => <code style={{ fontSize: 12 }}>{r.workflowState}</code>,
            },
            {
              key: 'label',
              header: 'Label',
              render: (r) => {
                const v = effective(r);
                return (
                  <Input
                    value={v.label}
                    onChange={(e) => patch(r.workflowState, { label: e.target.value })}
                  />
                );
              },
            },
            {
              key: 'color',
              header: 'Color',
              render: (r) => {
                const v = effective(r);
                return (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      type="color"
                      value={v.color}
                      aria-label="Color"
                      onChange={(e) => patch(r.workflowState, { color: e.target.value })}
                      style={{
                        width: 32,
                        height: 28,
                        padding: 0,
                        border: 'none',
                        background: 'transparent',
                      }}
                    />
                    <span
                      style={{
                        fontFamily: 'monospace',
                        fontSize: 11,
                        color: tokens.color.textMuted,
                      }}
                    >
                      {v.color}
                    </span>
                  </div>
                );
              },
            },
            {
              key: 'sort',
              header: 'Sort',
              align: 'right',
              render: (r) => {
                const v = effective(r);
                return (
                  <Input
                    type="number"
                    value={String(v.sortOrder)}
                    onChange={(e) =>
                      patch(r.workflowState, { sortOrder: Number(e.target.value) || 0 })
                    }
                    style={{ width: 80, textAlign: 'right' }}
                  />
                );
              },
            },
            {
              key: 'kanban',
              header: 'Kanban',
              align: 'center',
              render: (r) => {
                const v = effective(r);
                return (
                  <input
                    type="checkbox"
                    checked={v.kanbanVisible}
                    aria-label="Visible on kanban"
                    onChange={(e) => patch(r.workflowState, { kanbanVisible: e.target.checked })}
                  />
                );
              },
            },
            {
              key: 'comm',
              header: 'Client comm',
              align: 'center',
              render: (r) => {
                const v = effective(r);
                return (
                  <input
                    type="checkbox"
                    checked={v.triggersClientComm}
                    aria-label="Triggers client communication"
                    onChange={(e) =>
                      patch(r.workflowState, { triggersClientComm: e.target.checked })
                    }
                  />
                );
              },
            },
            {
              key: 'save',
              header: '',
              align: 'right',
              render: (r) => (
                <Button
                  size="sm"
                  variant={isDirty(r.workflowState) ? 'primary' : 'ghost'}
                  disabled={!isDirty(r.workflowState) || savingState === r.workflowState}
                  onClick={() => void save(r.workflowState)}
                >
                  {savingState === r.workflowState ? 'Saving…' : 'Save'}
                </Button>
              ),
            },
          ]}
          rows={rows}
          rowKey={(r) => r.workflowState}
        />
      </Card>
    </div>
  );
}
