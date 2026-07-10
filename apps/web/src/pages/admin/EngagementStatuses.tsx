// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Engagement progress-status catalog (0101). A compact list of the firm's
// statuses; create/edit happens in a popup (StatusEditorModal) so the form
// has room to grow as more per-status features land. Built-ins are
// un-deletable; custom statuses are fully managed here.
import { useEffect, useState } from 'react';

import { Button, Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { StatusEditorModal, type StatusConfigRow, type ServiceLineLite } from './StatusEditorModal';

export function EngagementStatusesPage(): JSX.Element {
  const [rows, setRows] = useState<StatusConfigRow[]>([]);
  const [serviceLines, setServiceLines] = useState<ServiceLineLite[]>([]);
  const [err, setErr] = useState<string | null>(null);
  // editing: a row to edit, or 'new' to create, or null = modal closed.
  const [editing, setEditing] = useState<StatusConfigRow | 'new' | null>(null);

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: StatusConfigRow[]; serviceLines?: ServiceLineLite[] }>(
        '/api/staff/admin/engagement-statuses',
      );
      setRows(r.items ?? []);
      setServiceLines(r.serviceLines ?? []);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'load_failed');
    }
  }

  const serviceLineName = (id: string): string =>
    serviceLines.find((s) => s.id === id)?.name ?? '—';

  // Inline toggle for the on-table checkboxes (optimistic, reverts on error).
  async function toggle(row: StatusConfigRow, change: Partial<StatusConfigRow>): Promise<void> {
    setRows((prev) =>
      prev.map((r) => (r.workflowState === row.workflowState ? { ...r, ...change } : r)),
    );
    try {
      await api(`/api/staff/admin/engagement-statuses/${row.workflowState}`, {
        method: 'PATCH',
        body: JSON.stringify(change),
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'update_failed');
      void load();
    }
  }
  useEffect(() => {
    void load();
  }, []);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1000 }}>
      <Card title="Engagement statuses">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 12,
            gap: 12,
          }}
        >
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
            Your board statuses. Click one to edit its color, order, client-facing text, and more.
            Built-ins can be edited but not deleted.
          </p>
          <Button variant="primary" onClick={() => setEditing('new')}>
            + Add status
          </Button>
        </div>
        {err && <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }}>{err}</p>}

        <Table<StatusConfigRow>
          columns={[
            {
              key: 'label',
              header: 'Status',
              render: (r) => (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span
                    aria-hidden
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: 3,
                      background: r.color,
                      display: 'inline-block',
                      flexShrink: 0,
                    }}
                  />
                  <span>{r.label}</span>
                  {r.isSystem && <Pill tone="neutral">built-in</Pill>}
                </div>
              ),
            },
            {
              key: 'client',
              header: 'Client sees',
              render: (r) =>
                r.clientLabel ? (
                  <span style={{ fontSize: 13 }}>{r.clientLabel}</span>
                ) : (
                  <span style={{ fontSize: 12, color: tokens.color.textMuted }}>standard pill</span>
                ),
            },
            {
              key: 'clientVisible',
              header: 'Show clients',
              align: 'center',
              render: (r) => (
                <input
                  type="checkbox"
                  checked={r.clientVisible}
                  aria-label={`Show ${r.label} to clients`}
                  onChange={(e) => void toggle(r, { clientVisible: e.target.checked })}
                />
              ),
            },
            {
              key: 'kanban',
              header: 'Board',
              align: 'center',
              render: (r) => (
                <input
                  type="checkbox"
                  checked={r.kanbanVisible}
                  aria-label={`Show ${r.label} on board`}
                  onChange={(e) => void toggle(r, { kanbanVisible: e.target.checked })}
                />
              ),
            },
            {
              key: 'serviceLines',
              header: 'Service lines',
              render: (r) =>
                r.serviceLineIds.length === 0 ? (
                  <span style={{ fontSize: 12, color: tokens.color.textMuted }}>All</span>
                ) : (
                  <span style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                    {r.serviceLineIds.map((id) => (
                      <Pill key={id} tone="neutral">
                        {serviceLineName(id)}
                      </Pill>
                    ))}
                  </span>
                ),
            },
            {
              key: 'notifies',
              header: 'Notifies',
              render: (r) =>
                r.triggersClientComm && r.notifyChannels.length > 0 ? (
                  <span style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                    {r.notifyChannels.map((c) => (
                      <Pill key={c} tone="accent">
                        {c === 'EMAIL' ? 'email' : c === 'SMS' ? 'sms' : 'portal'}
                      </Pill>
                    ))}
                    <Pill tone={r.notifyMode === 'IMMEDIATE' ? 'warning' : 'neutral'}>
                      {r.notifyMode === 'IMMEDIATE' ? 'immediate' : 'approval'}
                    </Pill>
                  </span>
                ) : (
                  <span style={{ fontSize: 12, color: tokens.color.textMuted }}>—</span>
                ),
            },
            {
              key: 'sort',
              header: 'Order',
              align: 'right',
              render: (r) => (
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{r.sortOrder}</span>
              ),
            },
            {
              key: 'edit',
              header: '',
              align: 'right',
              render: (r) => (
                <Button size="sm" variant="secondary" onClick={() => setEditing(r)}>
                  Edit
                </Button>
              ),
            },
          ]}
          rows={rows}
          rowKey={(r) => r.workflowState}
        />
      </Card>

      {editing !== null && (
        <StatusEditorModal
          status={editing === 'new' ? null : editing}
          serviceLines={serviceLines}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
