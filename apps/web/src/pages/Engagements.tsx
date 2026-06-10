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
import { EngagementsKanban, type StatusColumn } from './EngagementsKanban';
import { KanbanViewsMenu } from './engagements/KanbanViewsMenu';

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
  dueDate: string | null;
  engagementTypeId: string | null;
  clientName: string;
  // Service-line dimension (joined server-side from engagement_type →
  // service_line). NULL for engagements without an assigned type.
  serviceLineId: string | null;
  serviceLineName: string | null;
  serviceLineCategory: 'tax' | 'audit' | 'advisory' | 'bookkeeping' | 'payroll' | null;
}

interface AppUser {
  id: string;
  fullName: string;
}

interface EngagementType {
  id: string;
  name: string;
}

interface ServiceLine {
  id: string;
  name: string;
  category: 'tax' | 'audit' | 'advisory' | 'bookkeeping' | 'payroll';
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

// Filter/sort state persisted to localStorage so the table's filters
// survive a refresh or leaving and returning to the view.
const FILTERS_KEY = '__vibe_eng_filters';

interface PersistedFilters {
  tab?: Tab;
  workflow?: string[];
  priority?: string[];
  client?: string[];
  type?: string[];
  serviceLine?: string[];
  assignee?: string[];
  clientOwnerId?: string;
  sortBy?: { col: string; dir: SortDir };
}

function readPersistedFilters(): PersistedFilters {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as PersistedFilters) : {};
  } catch {
    return {};
  }
}

export function EngagementsPage(): JSX.Element {
  const { me } = useAuth();
  const currentUserId = me?.appUserId ?? '';
  const navigate = useNavigate();
  // Hydrate filters from localStorage once (lazy init below reads this).
  const [saved] = useState<PersistedFilters>(() => readPersistedFilters());
  // 0050 — default = My Work. Was 'active'.
  const [tab, setTab] = useState<Tab>(saved.tab ?? 'mine');
  const [rows, setRows] = useState<EngagementRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [users, setUsers] = useState<AppUser[]>([]);
  const [types, setTypes] = useState<EngagementType[]>([]);
  const [serviceLines, setServiceLines] = useState<ServiceLine[]>([]);

  // Per-column filter state.
  const [workflowFilter, setWorkflowFilter] = useState<Set<string>>(new Set(saved.workflow));
  const [priorityFilter, setPriorityFilter] = useState<Set<string>>(new Set(saved.priority));
  const [clientFilter, setClientFilter] = useState<Set<string>>(new Set(saved.client));
  const [typeFilter, setTypeFilter] = useState<Set<string>>(new Set(saved.type));
  // Service-line filter — sent server-side via ?serviceLineId. A single
  // value at a time (the API filters by exact match); multi-select on
  // top of that runs client-side via the visible useMemo below.
  const [serviceLineFilter, setServiceLineFilter] = useState<Set<string>>(
    new Set(saved.serviceLine),
  );
  const [assigneeFilter, setAssigneeFilter] = useState<Set<string>>(new Set(saved.assignee));
  // 0050 — filter by client owner (client.partnerInChargeId).
  const [clientOwnerId, setClientOwnerId] = useState<string>(saved.clientOwnerId ?? '');
  // 0050 — List | Kanban view toggle. Persisted in localStorage so users
  // don't have to re-pick on each session.
  const [view, setView] = useState<'list' | 'kanban'>(() => {
    try {
      return (localStorage.getItem('__vibe_eng_view') as 'list' | 'kanban') || 'kanban';
    } catch {
      return 'kanban';
    }
  });
  const [statusCols, setStatusCols] = useState<StatusColumn[]>([]);
  // Per-user kanban column hides. Persisted to localStorage so each
  // staff member's column filter survives reloads — independent of the
  // firm-wide kanbanVisible toggle in admin → Engagement Statuses.
  const [hiddenKanbanCols, setHiddenKanbanCols] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('__vibe_eng_kanban_hidden');
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? new Set<string>(parsed) : new Set();
    } catch {
      return new Set();
    }
  });
  const [kanbanGearOpen, setKanbanGearOpen] = useState(false);

  function persistHidden(next: Set<string>): void {
    try {
      localStorage.setItem('__vibe_eng_kanban_hidden', JSON.stringify(Array.from(next)));
    } catch {
      // Storage may be disabled — in-memory state still drives the
      // current session.
    }
  }

  function toggleKanbanCol(state: string): void {
    setHiddenKanbanCols((prev) => {
      const next = new Set(prev);
      if (next.has(state)) next.delete(state);
      else next.add(state);
      persistHidden(next);
      return next;
    });
  }

  // Apply a saved view's hidden-column set (from the Views menu).
  function applyHidden(next: Set<string>): void {
    setHiddenKanbanCols(next);
    persistHidden(next);
  }

  const [sortBy, setSortBy] = useState<{ col: string; dir: SortDir }>(
    saved.sortBy ?? { col: '', dir: null },
  );
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
      // Client multi-select is applied client-side (see the `visible` memo);
      // not sent here so the filter dropdown's options stay stable.
      if (clientOwnerId) params.set('clientOwnerId', clientOwnerId);
      // When exactly one service line is picked, narrow server-side
      // (cheaper for large firms). Multi-select runs client-side below.
      if (serviceLineFilter.size === 1) {
        params.set('serviceLineId', Array.from(serviceLineFilter)[0]!);
      }

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
  }, [
    tab,
    workflowFilter,
    priorityFilter,
    assigneeFilter,
    serviceLineFilter,
    clientOwnerId,
    // 0050 — when auth resolves and default tab is 'mine', refetch.
    currentUserId,
  ]);

  // Persist filters/sort so they survive a refresh or leaving the view.
  useEffect(() => {
    try {
      localStorage.setItem(
        FILTERS_KEY,
        JSON.stringify({
          tab,
          workflow: Array.from(workflowFilter),
          priority: Array.from(priorityFilter),
          client: Array.from(clientFilter),
          type: Array.from(typeFilter),
          serviceLine: Array.from(serviceLineFilter),
          assignee: Array.from(assigneeFilter),
          clientOwnerId,
          sortBy,
        } satisfies PersistedFilters),
      );
    } catch {
      // Storage may be disabled — in-memory state still drives the session.
    }
  }, [
    tab,
    workflowFilter,
    priorityFilter,
    clientFilter,
    typeFilter,
    serviceLineFilter,
    assigneeFilter,
    clientOwnerId,
    sortBy,
  ]);

  useEffect(() => {
    void (async () => {
      try {
        // Each sub-call .catch'd individually so a single permission
        // denial (e.g. staff without app_user:read) doesn't blank out
        // all three filter sources.
        const [u, t, s, sl] = await Promise.all([
          api<{ users: AppUser[] }>('/api/staff/admin/users').catch(() => ({ users: [] })),
          api<{ items: EngagementType[] }>('/api/staff/taxonomy/engagement-types').catch(() => ({
            items: [],
          })),
          api<{
            items: Array<{
              workflowState: WorkflowState;
              label: string;
              color: string;
              sortOrder: number;
              kanbanVisible: boolean;
            }>;
          }>('/api/staff/admin/engagement-statuses').catch(() => ({ items: [] })),
          api<{ items: ServiceLine[] }>('/api/staff/taxonomy/service-lines').catch(() => ({
            items: [],
          })),
        ]);
        setUsers(u.users ?? []);
        setTypes(t.items ?? []);
        setServiceLines(sl.items ?? []);
        setStatusCols(
          (s.items ?? [])
            .filter((row) => row.kanbanVisible)
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map<StatusColumn>((row) => ({
              workflowState: row.workflowState,
              label: row.label,
              color: row.color,
              sortOrder: row.sortOrder,
            })),
        );
      } catch {
        // Non-fatal.
      }
    })();
  }, []);

  function changeView(next: 'list' | 'kanban'): void {
    setView(next);
    try {
      localStorage.setItem('__vibe_eng_view', next);
    } catch {
      // Non-fatal.
    }
  }

  // Client-side filter on type + assignee + service-line (the server
  // filter is single-value to keep the SQL simple; multi-select runs
  // here on top of the up-to-500-row server response).
  const visible = useMemo(() => {
    let r = rows;
    if (typeFilter.size > 0) {
      r = r.filter((row) => row.engagementTypeId && typeFilter.has(row.engagementTypeId));
    }
    if (serviceLineFilter.size > 1) {
      r = r.filter((row) => row.serviceLineId && serviceLineFilter.has(row.serviceLineId));
    }
    // Client multi-select runs client-side so the dropdown options (derived
    // from the loaded rows) stay stable as you check/uncheck clients.
    if (clientFilter.size > 0) {
      r = r.filter((row) => clientFilter.has(row.clientId));
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
          case 'dueDate':
            av = a.dueDate ?? '';
            bv = b.dueDate ?? '';
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
  }, [rows, typeFilter, assigneeFilter, serviceLineFilter, clientFilter, sortBy]);

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
    if (clientOwnerId) params.set('clientOwnerId', clientOwnerId);
    params.set('format', 'csv');
    window.location.href = `/api/staff/engagements?${params.toString()}`;
  }

  const userOptions = users.map((u) => ({ value: u.id, label: u.fullName }));
  const typeOptions = types.map((t) => ({ value: t.id, label: t.name }));
  const serviceLineOptions = serviceLines.map((sl) => ({
    value: sl.id,
    label: `${sl.name} (${sl.category})`,
  }));

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
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <div style={{ width: 200 }}>
              <Combobox
                ariaLabel="Client owner"
                clearable
                value={clientOwnerId}
                onChange={setClientOwnerId}
                options={users.map((u) => ({ value: u.id, label: u.fullName }))}
                placeholder="Any owner"
                size="sm"
              />
            </div>
            <span
              style={{
                display: 'inline-flex',
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm,
              }}
            >
              <Button
                size="sm"
                variant={view === 'list' ? 'secondary' : 'ghost'}
                onClick={() => changeView('list')}
                aria-pressed={view === 'list'}
              >
                ☰ List
              </Button>
              <Button
                size="sm"
                variant={view === 'kanban' ? 'secondary' : 'ghost'}
                onClick={() => changeView('kanban')}
                aria-pressed={view === 'kanban'}
              >
                ▦ Board
              </Button>
            </span>
            {view === 'kanban' && (
              <KanbanViewsMenu
                columns={statusCols}
                hidden={hiddenKanbanCols}
                onApply={applyHidden}
              />
            )}
            {view === 'kanban' && (
              <div style={{ position: 'relative' }}>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setKanbanGearOpen((v) => !v)}
                  title="Choose which status columns to show on this kanban (saved per-user)"
                  aria-label="Kanban column settings"
                  aria-expanded={kanbanGearOpen}
                >
                  ⚙ Columns
                </Button>
                {kanbanGearOpen && (
                  <div
                    role="dialog"
                    aria-label="Kanban columns"
                    style={{
                      position: 'absolute',
                      top: '110%',
                      right: 0,
                      minWidth: 240,
                      background: tokens.color.bg,
                      border: `1px solid ${tokens.color.border}`,
                      borderRadius: tokens.radius.md,
                      padding: 10,
                      zIndex: 50,
                      display: 'grid',
                      gap: 6,
                      boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
                    }}
                  >
                    <p
                      style={{
                        margin: 0,
                        fontSize: 11,
                        textTransform: 'uppercase',
                        letterSpacing: 0.4,
                        color: tokens.color.textMuted,
                      }}
                    >
                      Show columns
                    </p>
                    {statusCols.map((col) => (
                      <label
                        key={col.workflowState}
                        style={{ display: 'flex', gap: 8, fontSize: 13, alignItems: 'center' }}
                      >
                        <input
                          type="checkbox"
                          checked={!hiddenKanbanCols.has(col.workflowState)}
                          onChange={() => toggleKanbanCol(col.workflowState)}
                        />
                        <span
                          style={{
                            display: 'inline-block',
                            width: 10,
                            height: 10,
                            borderRadius: 5,
                            background: col.color,
                          }}
                        />
                        {col.label}
                      </label>
                    ))}
                    <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                      <button
                        type="button"
                        style={{
                          background: 'none',
                          border: 'none',
                          fontSize: 11,
                          color: tokens.color.accent,
                          cursor: 'pointer',
                          padding: 0,
                        }}
                        onClick={() => {
                          setHiddenKanbanCols(new Set());
                          try {
                            localStorage.setItem('__vibe_eng_kanban_hidden', '[]');
                          } catch {
                            // Non-fatal: in-memory clear still applies.
                          }
                        }}
                      >
                        Show all
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
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
        ) : view === 'kanban' ? (
          <EngagementsKanban
            rows={visible.map((r) => ({
              id: r.id,
              clientId: r.clientId,
              name: r.name,
              workflowState: r.workflowState,
              priority: r.priority,
              clientName: r.clientName,
            }))}
            columns={statusCols.filter((c) => !hiddenKanbanCols.has(c.workflowState))}
            onMoved={() => void load()}
            onError={(m) => setError(m)}
          />
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
                    Service line{' '}
                    <ColumnFilter
                      ariaLabel="Filter service line"
                      values={serviceLineOptions}
                      selected={serviceLineFilter}
                      sort={null}
                      onApply={(sel) => setServiceLineFilter(sel)}
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
                      sort={sortBy.col === 'dueDate' ? sortBy.dir : null}
                      onApply={(_, dir) => {
                        if (dir) setSortBy({ col: 'dueDate', dir });
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
                      colSpan={10}
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
                        <td style={td()} title={r.serviceLineCategory ?? undefined}>
                          {r.serviceLineName ?? '—'}
                        </td>
                        <td style={td()}>
                          {assigneeNames.length > 0 ? assigneeNames.join(', ') : '—'}
                        </td>
                        <td style={td()}>{r.startDate ?? '—'}</td>
                        <td style={td()}>{r.dueDate ?? '—'}</td>
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
