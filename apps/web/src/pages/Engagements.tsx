// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Top-level Engagements list view (v2 Part 2). Canopy "Tasks"-style:
// four sub-tabs (Active Work / All Work / My Work / Queued Work),
// sortable + filterable columns, per-column filter dropdowns, bulk
// actions, CSV export.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button, Card, ColumnFilter, Combobox, Pill, Tabs, tokens, type SortDir } from '@vibe/ui';

import { api } from '../api-client';
import { useAuth } from '../auth-context';

type WorkflowState =
  | 'NO_STATUS'
  | 'NOT_STARTED'
  | 'READY'
  | 'IN_PROGRESS'
  | 'ON_HOLD'
  | 'NEEDS_REVIEW'
  | 'WITH_CLIENT'
  | 'COMPLETED'
  | 'CANCELED'
  | 'DRAFT';

type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
type LifecycleStatus = 'PROPOSED' | 'ACTIVE' | 'PAUSED' | 'CLOSED' | 'ARCHIVED';

interface EngagementRow {
  id: string;
  clientId: string;
  name: string;
  status: LifecycleStatus;
  workflowState: WorkflowState;
  priority: Priority;
  feeStructure: string;
  feeAmountCents: number | null;
  partnerId: string | null;
  managerId: string | null;
  startDate: string | null;
  endDate: string | null;
  engagementTypeId: string | null;
  clientName: string;
}

interface AppUser {
  id: string;
  fullName: string;
}

interface EngagementType {
  id: string;
  name: string;
}

const WORKFLOW_LABELS: Record<WorkflowState, string> = {
  NO_STATUS: 'No status',
  NOT_STARTED: 'Not started',
  READY: 'Ready',
  IN_PROGRESS: 'In progress',
  ON_HOLD: 'On hold',
  NEEDS_REVIEW: 'Needs review',
  WITH_CLIENT: 'With client',
  COMPLETED: 'Completed',
  CANCELED: 'Canceled',
  DRAFT: 'Draft',
};

const WORKFLOW_TONE: Record<
  WorkflowState,
  'neutral' | 'accent' | 'success' | 'warning' | 'danger'
> = {
  NO_STATUS: 'neutral',
  NOT_STARTED: 'neutral',
  READY: 'accent',
  IN_PROGRESS: 'accent',
  ON_HOLD: 'warning',
  NEEDS_REVIEW: 'warning',
  WITH_CLIENT: 'warning',
  COMPLETED: 'success',
  CANCELED: 'neutral',
  DRAFT: 'neutral',
};

const PRIORITY_TONE: Record<Priority, 'neutral' | 'accent' | 'warning' | 'danger'> = {
  LOW: 'neutral',
  MEDIUM: 'accent',
  HIGH: 'warning',
  URGENT: 'danger',
};

const ACTIVE_WORK = new Set<WorkflowState>(['READY', 'IN_PROGRESS', 'NEEDS_REVIEW', 'WITH_CLIENT']);
const QUEUED_WORK = new Set<WorkflowState>(['NO_STATUS', 'NOT_STARTED', 'DRAFT']);

type Tab = 'active' | 'all' | 'mine' | 'queued';

export function EngagementsPage(): JSX.Element {
  const { me } = useAuth();
  const currentUserId = me?.appUserId ?? '';
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('active');
  const [rows, setRows] = useState<EngagementRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [users, setUsers] = useState<AppUser[]>([]);
  const [types, setTypes] = useState<EngagementType[]>([]);

  // Per-column filter state.
  const [workflowFilter, setWorkflowFilter] = useState<Set<string>>(new Set());
  const [priorityFilter, setPriorityFilter] = useState<Set<string>>(new Set());
  const [clientFilter, setClientFilter] = useState<Set<string>>(new Set());
  const [typeFilter, setTypeFilter] = useState<Set<string>>(new Set());
  const [assigneeFilter, setAssigneeFilter] = useState<Set<string>>(new Set());

  const [sortBy, setSortBy] = useState<{ col: string; dir: SortDir }>({ col: '', dir: null });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      // Tab-driven scope filter on workflow_state.
      const scopeWs: WorkflowState[] =
        tab === 'active'
          ? Array.from(ACTIVE_WORK)
          : tab === 'queued'
            ? Array.from(QUEUED_WORK)
            : [];
      const params = new URLSearchParams();
      const ws =
        scopeWs.length > 0 && workflowFilter.size === 0
          ? scopeWs
          : workflowFilter.size > 0
            ? Array.from(workflowFilter)
            : [];
      if (ws.length > 0) params.set('workflowState', ws.join(','));
      if (priorityFilter.size > 0) params.set('priority', Array.from(priorityFilter).join(','));
      if (tab === 'mine' && currentUserId) params.set('assigneeUserId', currentUserId);
      if (clientFilter.size > 0) params.set('clientId', Array.from(clientFilter).join(','));

      const r = await api<{ items: EngagementRow[] }>(
        `/api/staff/engagements?${params.toString()}`,
      );
      setRows(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load_failed');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, workflowFilter, priorityFilter, clientFilter, assigneeFilter]);

  useEffect(() => {
    void (async () => {
      try {
        const [u, t] = await Promise.all([
          api<{ users: AppUser[] }>('/api/staff/admin/users'),
          api<{ items: EngagementType[] }>('/api/staff/taxonomy/engagement-types'),
        ]);
        setUsers(u.users ?? []);
        setTypes(t.items ?? []);
      } catch {
        // Non-fatal.
      }
    })();
  }, []);

  // Client-side filter on type + assignee (server doesn't filter these);
  // and client-side sort because the server returns max 500.
  const visible = useMemo(() => {
    let r = rows;
    if (typeFilter.size > 0) {
      r = r.filter((row) => row.engagementTypeId && typeFilter.has(row.engagementTypeId));
    }
    if (assigneeFilter.size > 0) {
      r = r.filter(
        (row) =>
          (row.partnerId && assigneeFilter.has(row.partnerId)) ||
          (row.managerId && assigneeFilter.has(row.managerId)),
      );
    }
    if (sortBy.dir) {
      const sign = sortBy.dir === 'asc' ? 1 : -1;
      r = [...r].sort((a, b) => {
        let av = '';
        let bv = '';
        switch (sortBy.col) {
          case 'workflowState':
            av = a.workflowState;
            bv = b.workflowState;
            break;
          case 'name':
            av = a.name.toLowerCase();
            bv = b.name.toLowerCase();
            break;
          case 'client':
            av = a.clientName.toLowerCase();
            bv = b.clientName.toLowerCase();
            break;
          case 'priority':
            av = a.priority;
            bv = b.priority;
            break;
          case 'startDate':
            av = a.startDate ?? '';
            bv = b.startDate ?? '';
            break;
          case 'endDate':
            av = a.endDate ?? '';
            bv = b.endDate ?? '';
            break;
          default:
            return 0;
        }
        return av < bv ? -sign : av > bv ? sign : 0;
      });
    }
    return r;
  }, [rows, typeFilter, assigneeFilter, sortBy]);

  const clientOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.clientId, r.clientName);
    return Array.from(map.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [rows]);

  function toggleRow(id: string): void {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  }

  function toggleAll(): void {
    if (selectedIds.size === visible.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(visible.map((r) => r.id)));
  }

  // QA fix — every mutation handler was a bare `await api(...)` with no
  // try/catch. Callers used `void bulkSetWorkflow(...)` so any non-2xx
  // bubbled up as an unhandled promise rejection (visible in the
  // browser console). Now any error is surfaced via setError and the
  // promise resolves cleanly.
  async function bulkSetWorkflow(state: WorkflowState): Promise<void> {
    try {
      await Promise.all(
        Array.from(selectedIds).map((id) =>
          api(`/api/staff/engagements/${id}/workflow-state`, {
            method: 'PATCH',
            body: JSON.stringify({ workflowState: state }),
          }),
        ),
      );
      setSelectedIds(new Set());
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'bulk_workflow_failed');
    }
  }

  async function bulkSetPriority(p: Priority): Promise<void> {
    try {
      await Promise.all(
        Array.from(selectedIds).map((id) =>
          api(`/api/staff/engagements/${id}/priority`, {
            method: 'PATCH',
            body: JSON.stringify({ priority: p }),
          }),
        ),
      );
      setSelectedIds(new Set());
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'bulk_priority_failed');
    }
  }

  async function setRowWorkflow(id: string, state: WorkflowState): Promise<void> {
    try {
      await api(`/api/staff/engagements/${id}/workflow-state`, {
        method: 'PATCH',
        body: JSON.stringify({ workflowState: state }),
      });
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'workflow_update_failed');
    }
  }

  async function setRowPriority(id: string, p: Priority): Promise<void> {
    try {
      await api(`/api/staff/engagements/${id}/priority`, {
        method: 'PATCH',
        body: JSON.stringify({ priority: p }),
      });
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'priority_update_failed');
    }
  }

  function exportCsv(): void {
    const params = new URLSearchParams();
    if (workflowFilter.size > 0) params.set('workflowState', Array.from(workflowFilter).join(','));
    if (priorityFilter.size > 0) params.set('priority', Array.from(priorityFilter).join(','));
    if (tab === 'mine' && currentUserId) params.set('assigneeUserId', currentUserId);
    if (clientFilter.size > 0) params.set('clientId', Array.from(clientFilter).join(','));
    params.set('format', 'csv');
    window.location.href = `/api/staff/engagements?${params.toString()}`;
  }

  const userOptions = users.map((u) => ({ value: u.id, label: u.fullName }));
  const typeOptions = types.map((t) => ({ value: t.id, label: t.name }));

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1400 }}>
      <Card
        title={
          <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span>Engagements</span>
            <span style={{ fontSize: 13, color: tokens.color.textMuted }}>
              {visible.length} engagement{visible.length === 1 ? '' : 's'}
            </span>
          </span>
        }
        action={
          <span style={{ display: 'flex', gap: 6 }}>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => alert('Kanban view coming soon')}
              title="Kanban view (coming soon)"
            >
              ▦ Board
            </Button>
            <Button size="sm" variant="ghost" onClick={exportCsv}>
              ↓ CSV
            </Button>
            <Button size="sm" onClick={() => navigate('/engagements/new')}>
              + New engagement
            </Button>
          </span>
        }
      >
        <Tabs
          tabs={[
            { key: 'active', label: 'Active Work' },
            { key: 'all', label: 'All Work' },
            { key: 'mine', label: 'My Work' },
            { key: 'queued', label: 'Queued Work' },
          ]}
          active={tab}
          onChange={(k) => {
            setTab(k as Tab);
            setSelectedIds(new Set());
          }}
        />

        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
            {error}
          </p>
        )}

        {selectedIds.size > 0 && (
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              padding: '8px 12px',
              marginBottom: 8,
              borderRadius: tokens.radius.md,
              background: tokens.color.accentMuted,
            }}
          >
            <span style={{ fontSize: 13, color: tokens.color.accent }}>
              {selectedIds.size} selected
            </span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <BulkWorkflowButton onPick={(w) => void bulkSetWorkflow(w)} />
              <BulkPriorityButton onPick={(p) => void bulkSetPriority(p)} />
              <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
                Cancel
              </Button>
            </span>
          </div>
        )}

        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 13,
                fontFamily: tokens.font.body,
              }}
            >
              <thead>
                <tr style={{ background: tokens.color.surface }}>
                  <th style={th()}>
                    <input
                      type="checkbox"
                      checked={selectedIds.size > 0 && selectedIds.size === visible.length}
                      onChange={toggleAll}
                      aria-label="Select all"
                    />
                  </th>
                  <th style={th()}>
                    Status{' '}
                    <ColumnFilter
                      ariaLabel="Filter workflow state"
                      values={(Object.keys(WORKFLOW_LABELS) as WorkflowState[]).map((w) => ({
                        value: w,
                        label: WORKFLOW_LABELS[w],
                      }))}
                      selected={workflowFilter}
                      sort={sortBy.col === 'workflowState' ? sortBy.dir : null}
                      onApply={(sel, dir) => {
                        setWorkflowFilter(sel);
                        if (dir) setSortBy({ col: 'workflowState', dir });
                      }}
                    />
                  </th>
                  <th style={th()}>
                    Name{' '}
                    <ColumnFilter
                      ariaLabel="Sort by name"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={sortBy.col === 'name' ? sortBy.dir : null}
                      onApply={(_, dir) => {
                        if (dir) setSortBy({ col: 'name', dir });
                      }}
                    />
                  </th>
                  <th style={th()}>
                    Client{' '}
                    <ColumnFilter
                      ariaLabel="Filter client"
                      values={clientOptions}
                      selected={clientFilter}
                      sort={sortBy.col === 'client' ? sortBy.dir : null}
                      onApply={(sel, dir) => {
                        setClientFilter(sel);
                        if (dir) setSortBy({ col: 'client', dir });
                      }}
                    />
                  </th>
                  <th style={th()}>
                    Type{' '}
                    <ColumnFilter
                      ariaLabel="Filter type"
                      values={typeOptions}
                      selected={typeFilter}
                      sort={null}
                      onApply={(sel) => setTypeFilter(sel)}
                    />
                  </th>
                  <th style={th()}>
                    Assignee(s){' '}
                    <ColumnFilter
                      ariaLabel="Filter assignee"
                      values={userOptions}
                      selected={assigneeFilter}
                      sort={null}
                      onApply={(sel) => setAssigneeFilter(sel)}
                    />
                  </th>
                  <th style={th()}>
                    Start{' '}
                    <ColumnFilter
                      ariaLabel="Sort by start date"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={sortBy.col === 'startDate' ? sortBy.dir : null}
                      onApply={(_, dir) => {
                        if (dir) setSortBy({ col: 'startDate', dir });
                      }}
                    />
                  </th>
                  <th style={th()}>
                    Due{' '}
                    <ColumnFilter
                      ariaLabel="Sort by due date"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={sortBy.col === 'endDate' ? sortBy.dir : null}
                      onApply={(_, dir) => {
                        if (dir) setSortBy({ col: 'endDate', dir });
                      }}
                    />
                  </th>
                  <th style={th()}>
                    Priority{' '}
                    <ColumnFilter
                      ariaLabel="Filter priority"
                      values={(['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as Priority[]).map((p) => ({
                        value: p,
                        label: p,
                      }))}
                      selected={priorityFilter}
                      sort={sortBy.col === 'priority' ? sortBy.dir : null}
                      onApply={(sel, dir) => {
                        setPriorityFilter(sel);
                        if (dir) setSortBy({ col: 'priority', dir });
                      }}
                    />
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr>
                    <td
                      colSpan={9}
                      style={{
                        textAlign: 'center',
                        padding: 40,
                        color: tokens.color.textMuted,
                        fontSize: 13,
                      }}
                    >
                      <div style={{ fontSize: 32, marginBottom: 8 }}>▽</div>
                      <strong>No Results</strong>
                      <div>Please refine your filters.</div>
                    </td>
                  </tr>
                ) : (
                  visible.map((r) => {
                    const assigneeNames = [
                      users.find((u) => u.id === r.partnerId)?.fullName,
                      users.find((u) => u.id === r.managerId)?.fullName,
                    ].filter(Boolean);
                    const typeName = types.find((t) => t.id === r.engagementTypeId)?.name;
                    return (
                      <tr
                        key={r.id}
                        style={{
                          borderTop: `1px solid ${tokens.color.border}`,
                          background: selectedIds.has(r.id) ? tokens.color.accentMuted : undefined,
                        }}
                      >
                        <td style={td()}>
                          <input
                            type="checkbox"
                            checked={selectedIds.has(r.id)}
                            onChange={() => toggleRow(r.id)}
                            aria-label={`Select ${r.name}`}
                          />
                        </td>
                        <td style={td()}>
                          <InlineWorkflowEdit
                            value={r.workflowState}
                            onChange={(v) => void setRowWorkflow(r.id, v)}
                          />
                        </td>
                        <td style={td()}>
                          <a href={`/engagements/${r.id}`}>{r.name}</a>
                        </td>
                        <td style={td()}>
                          <a href={`/clients/${r.clientId}`}>{r.clientName}</a>
                        </td>
                        <td style={td()}>{typeName ?? '—'}</td>
                        <td style={td()}>
                          {assigneeNames.length > 0 ? assigneeNames.join(', ') : '—'}
                        </td>
                        <td style={td()}>{r.startDate ?? '—'}</td>
                        <td style={td()}>{r.endDate ?? '—'}</td>
                        <td style={td()}>
                          <InlinePriorityEdit
                            value={r.priority}
                            onChange={(v) => void setRowPriority(r.id, v)}
                          />
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function th(): React.CSSProperties {
  return {
    textAlign: 'left',
    padding: '10px 8px',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: tokens.color.textMuted,
    fontWeight: 600,
    borderBottom: `1px solid ${tokens.color.border}`,
  };
}

function td(): React.CSSProperties {
  return {
    padding: '8px',
    fontSize: 13,
    verticalAlign: 'middle',
  };
}

function InlineWorkflowEdit({
  value,
  onChange,
}: {
  value: WorkflowState;
  onChange: (v: WorkflowState) => void;
}): JSX.Element {
  const options = (Object.keys(WORKFLOW_LABELS) as WorkflowState[]).map((w) => ({
    value: w,
    label: WORKFLOW_LABELS[w],
  }));
  // Use a tiny Combobox-as-pill: read renders a Pill, click opens picker.
  // To keep this self-contained, render the Combobox in trigger-as-pill mode
  // via plain CSS (the combobox already shows as button).
  return (
    <div style={{ width: 130 }}>
      <Combobox
        ariaLabel="Workflow state"
        size="sm"
        value={value}
        onChange={(v) => onChange(v as WorkflowState)}
        options={options}
        renderOption={(o) => (
          <span style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 1 }}>
            <Pill tone={WORKFLOW_TONE[o.value as WorkflowState]}>{o.label}</Pill>
          </span>
        )}
      />
    </div>
  );
}

function InlinePriorityEdit({
  value,
  onChange,
}: {
  value: Priority;
  onChange: (v: Priority) => void;
}): JSX.Element {
  const options: Priority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
  return (
    <div style={{ width: 100 }}>
      <Combobox
        ariaLabel="Priority"
        size="sm"
        value={value}
        onChange={(v) => onChange(v as Priority)}
        options={options.map((p) => ({ value: p, label: p }))}
        renderOption={(o) => (
          <span style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 1 }}>
            <Pill tone={PRIORITY_TONE[o.value as Priority]}>{o.label}</Pill>
          </span>
        )}
      />
    </div>
  );
}

function BulkWorkflowButton({ onPick }: { onPick: (w: WorkflowState) => void }): JSX.Element {
  const [v, setV] = useState<string>('');
  useEffect(() => {
    if (v) {
      onPick(v as WorkflowState);
      setV('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v]);
  return (
    <div style={{ width: 180 }}>
      <Combobox
        ariaLabel="Bulk set workflow state"
        size="sm"
        value={v}
        onChange={setV}
        options={(Object.keys(WORKFLOW_LABELS) as WorkflowState[]).map((w) => ({
          value: w,
          label: WORKFLOW_LABELS[w],
        }))}
        placeholder="Set status…"
      />
    </div>
  );
}

function BulkPriorityButton({ onPick }: { onPick: (p: Priority) => void }): JSX.Element {
  const [v, setV] = useState<string>('');
  useEffect(() => {
    if (v) {
      onPick(v as Priority);
      setV('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v]);
  return (
    <div style={{ width: 140 }}>
      <Combobox
        ariaLabel="Bulk set priority"
        size="sm"
        value={v}
        onChange={setV}
        options={(['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as Priority[]).map((p) => ({
          value: p,
          label: p,
        }))}
        placeholder="Set priority…"
      />
    </div>
  );
}
