// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Top-level Engagements list view (v2 Part 2). Canopy "Tasks"-style:
// four sub-tabs (Active Work / All Work / My Work / Queued Work),
// sortable + filterable columns, per-column filter dropdowns, bulk
// actions, CSV export.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  Button,
  Card,
  ColumnFilter,
  Combobox,
  Pill,
  Table,
  type TableColumn,
  Tabs,
  tokens,
  type SortDir,
} from '@vibe/ui';
import { useClientPage } from '../lib/use-paged-list';

import { api } from '../api-client';
import { useAuth } from '../auth-context';
import { filterStatuses, filterStatusesForMany } from '../status-filter';
import { EngagementsKanban, type StatusColumn } from './EngagementsKanban';
import { MailMergeDialog } from './clients/MailMergeDialog';
import { KanbanViewsMenu } from './engagements/KanbanViewsMenu';

type WorkflowState =
  | 'NO_STATUS'
  | 'NOT_STARTED'
  | 'READY'
  | 'IN_PROGRESS'
  | 'IN_REVIEW'
  | 'ON_HOLD'
  | 'NEEDS_REVIEW'
  | 'WITH_CLIENT'
  | 'WAITING_ON_CLIENT'
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
  serviceLineCategory: string | null;
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
  category: string;
}

const WORKFLOW_LABELS: Record<WorkflowState, string> = {
  NO_STATUS: 'No status',
  NOT_STARTED: 'Not started',
  READY: 'Ready',
  IN_PROGRESS: 'In progress',
  IN_REVIEW: 'In Review',
  ON_HOLD: 'On hold',
  NEEDS_REVIEW: 'Needs review',
  WITH_CLIENT: 'With client',
  WAITING_ON_CLIENT: 'Waiting on Client',
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
  IN_REVIEW: 'warning',
  ON_HOLD: 'warning',
  NEEDS_REVIEW: 'warning',
  WITH_CLIENT: 'warning',
  WAITING_ON_CLIENT: 'warning',
  COMPLETED: 'success',
  CANCELED: 'neutral',
  DRAFT: 'neutral',
};

// A light, readable row tint from a status hex color (#rrggbb → rgba). Falls
// back to no tint on an unparseable color.
function tintFromHex(hex: string, alpha = 0.14): string | undefined {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return undefined;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const PRIORITY_TONE: Record<Priority, 'neutral' | 'accent' | 'warning' | 'danger'> = {
  LOW: 'neutral',
  MEDIUM: 'accent',
  HIGH: 'warning',
  URGENT: 'danger',
};

const ACTIVE_WORK = new Set<WorkflowState>([
  'READY',
  'IN_PROGRESS',
  'IN_REVIEW',
  'NEEDS_REVIEW',
  'WITH_CLIENT',
  'WAITING_ON_CLIENT',
]);
const QUEUED_WORK = new Set<WorkflowState>(['NO_STATUS', 'NOT_STARTED', 'DRAFT']);

type Tab = 'active' | 'all' | 'mine' | 'queued';

// Filter/sort state persisted to sessionStorage so the table's filters
// survive a refresh or leaving and returning to the view — same lifetime
// as every other column-filter view (useColumnView, TaxReturnsTab, …).
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
    const raw = sessionStorage.getItem(FILTERS_KEY);
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
  // Hydrate filters from sessionStorage once (lazy init below reads this).
  const [saved] = useState<PersistedFilters>(() => readPersistedFilters());
  // 0050 — default = My Work. Was 'active'.
  const [tab, setTab] = useState<Tab>(saved.tab ?? 'mine');
  const [rows, setRows] = useState<EngagementRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [nameQuery, setNameQuery] = useState('');
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
  // Show/hide DRAFT-workflow engagements (applies to both list + kanban via
  // the `visible` memo). Default true = no behavior change.
  const [showDrafts, setShowDrafts] = useState(true);
  // "Active only" — hide COMPLETED / CANCELED engagements. Persisted; default
  // off (no behavior change).
  const [activeOnly, setActiveOnly] = useState<boolean>(() => {
    try {
      return localStorage.getItem('__vibe_eng_active_only') === 'on';
    } catch {
      return false;
    }
  });
  function toggleActiveOnly(next: boolean): void {
    setActiveOnly(next);
    try {
      localStorage.setItem('__vibe_eng_active_only', next ? 'on' : 'off');
    } catch {
      // Storage may be disabled — in-memory state still drives the session.
    }
  }
  // Tint each list row by its status color. On by default; persisted so the
  // preference survives reloads.
  const [colorRows, setColorRows] = useState<boolean>(() => {
    try {
      return localStorage.getItem('__vibe_eng_row_color') !== 'off';
    } catch {
      return true;
    }
  });
  function toggleColorRows(next: boolean): void {
    setColorRows(next);
    try {
      localStorage.setItem('__vibe_eng_row_color', next ? 'on' : 'off');
    } catch {
      // Storage may be disabled — in-memory state still drives the session.
    }
  }
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
  // 0167 — full status catalog (incl. non-board statuses + service-line
  // mapping) used to populate and filter the inline/bulk status pickers.
  const [statuses, setStatuses] = useState<
    Array<{
      workflowState: WorkflowState;
      label: string;
      color: string;
      sortOrder: number;
      kanbanVisible: boolean;
      serviceLineIds: string[];
    }>
  >([]);
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
  const [mergeOpen, setMergeOpen] = useState(false);

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
      sessionStorage.setItem(
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
              serviceLineIds: string[];
            }>;
            // engagement:read endpoint (every timekeeper can read it);
            // also the source of the per-status service-line mapping.
          }>('/api/staff/engagement-statuses').catch(() => ({ items: [] })),
          api<{ items: ServiceLine[] }>('/api/staff/taxonomy/service-lines').catch(() => ({
            items: [],
          })),
        ]);
        setUsers(u.users ?? []);
        setTypes(t.items ?? []);
        setServiceLines(sl.items ?? []);
        setStatuses(s.items ?? []);
        setStatusCols(
          (s.items ?? [])
            .filter((row) => row.kanbanVisible)
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map<StatusColumn>((row) => ({
              workflowState: row.workflowState,
              label: row.label,
              color: row.color,
              sortOrder: row.sortOrder,
              serviceLineIds: row.serviceLineIds,
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
    if (!showDrafts) {
      r = r.filter((row) => row.workflowState !== 'DRAFT');
    }
    if (activeOnly) {
      r = r.filter((row) => row.workflowState !== 'COMPLETED' && row.workflowState !== 'CANCELED');
    }
    if (nameQuery.trim()) {
      const q = nameQuery.trim().toLowerCase();
      r = r.filter((row) => row.name.toLowerCase().includes(q));
    }
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
  }, [
    rows,
    showDrafts,
    activeOnly,
    nameQuery,
    typeFilter,
    assigneeFilter,
    serviceLineFilter,
    clientFilter,
    sortBy,
  ]);

  const { paged, pagination } = useClientPage(visible);

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

  // 0167 — status picker options filtered to an engagement's service line.
  // The current value is always kept so an out-of-scope status never hides.
  function statusOptionsFor(
    serviceLineId: string | null,
    current: string,
  ): Array<{ value: string; label: string }> {
    return filterStatuses(statuses, serviceLineId, current).map((s) => ({
      value: s.workflowState,
      label: s.label,
    }));
  }

  // Bulk picker: only statuses valid for every selected engagement.
  const bulkStatusOptions = useMemo(() => {
    const sel = rows.filter((r) => selectedIds.has(r.id));
    return filterStatusesForMany(
      statuses,
      sel.map((r) => r.serviceLineId),
      sel.map((r) => r.workflowState),
    ).map((s) => ({ value: s.workflowState, label: s.label }));
  }, [statuses, rows, selectedIds]);

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

  // workflow_state → status color, from the firm's status catalog. Drives the
  // per-row background tint in list view.
  const statusColorMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of statuses) m.set(s.workflowState, s.color);
    return m;
  }, [statuses]);

  const engagementColumns: TableColumn<EngagementRow>[] = [
    {
      key: 'select',
      header: (
        <input
          type="checkbox"
          checked={selectedIds.size > 0 && selectedIds.size === visible.length}
          onChange={toggleAll}
          aria-label="Select all"
        />
      ),
      render: (r) => (
        <input
          type="checkbox"
          checked={selectedIds.has(r.id)}
          onChange={() => toggleRow(r.id)}
          aria-label={`Select ${r.name}`}
        />
      ),
    },
    {
      key: 'workflowState',
      header: (
        <>
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
        </>
      ),
      render: (r) => (
        <InlineWorkflowEdit
          value={r.workflowState}
          options={statusOptionsFor(r.serviceLineId, r.workflowState)}
          onChange={(v) => void setRowWorkflow(r.id, v)}
        />
      ),
    },
    {
      key: 'name',
      header: (
        <>
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
        </>
      ),
      render: (r) => <a href={`/engagements/${r.id}`}>{r.name}</a>,
    },
    {
      key: 'client',
      header: (
        <>
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
        </>
      ),
      render: (r) => <a href={`/clients/${r.clientId}`}>{r.clientName}</a>,
    },
    {
      key: 'type',
      header: (
        <>
          Type{' '}
          <ColumnFilter
            ariaLabel="Filter type"
            values={typeOptions}
            selected={typeFilter}
            sort={null}
            onApply={(sel) => setTypeFilter(sel)}
          />
        </>
      ),
      render: (r) => types.find((t) => t.id === r.engagementTypeId)?.name ?? '—',
    },
    {
      key: 'serviceLine',
      header: (
        <>
          Service line{' '}
          <ColumnFilter
            ariaLabel="Filter service line"
            values={serviceLineOptions}
            selected={serviceLineFilter}
            sort={null}
            onApply={(sel) => setServiceLineFilter(sel)}
          />
        </>
      ),
      render: (r) => (
        <span title={r.serviceLineCategory ?? undefined}>{r.serviceLineName ?? '—'}</span>
      ),
    },
    {
      key: 'assignee',
      header: (
        <>
          Assignee(s){' '}
          <ColumnFilter
            ariaLabel="Filter assignee"
            values={userOptions}
            selected={assigneeFilter}
            sort={null}
            onApply={(sel) => setAssigneeFilter(sel)}
          />
        </>
      ),
      render: (r) => {
        const assigneeNames = [
          users.find((u) => u.id === r.partnerId)?.fullName,
          users.find((u) => u.id === r.managerId)?.fullName,
        ].filter(Boolean);
        return assigneeNames.length > 0 ? assigneeNames.join(', ') : '—';
      },
    },
    {
      key: 'startDate',
      header: (
        <>
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
        </>
      ),
      render: (r) => r.startDate ?? '—',
    },
    {
      key: 'dueDate',
      header: (
        <>
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
        </>
      ),
      render: (r) => r.dueDate ?? '—',
    },
    {
      key: 'priority',
      header: (
        <>
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
        </>
      ),
      render: (r) => (
        <InlinePriorityEdit value={r.priority} onChange={(v) => void setRowPriority(r.id, v)} />
      ),
    },
  ];

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
            <input
              type="search"
              value={nameQuery}
              onChange={(e) => setNameQuery(e.target.value)}
              placeholder="Search name…"
              aria-label="Search engagements by name"
              style={{
                width: 180,
                padding: '6px 8px',
                fontSize: 13,
                borderRadius: tokens.radius.sm,
                border: `1px solid ${tokens.color.border}`,
                background: tokens.color.surface,
                color: tokens.color.text,
              }}
            />
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
            <label
              style={{
                fontSize: 12,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                color: tokens.color.textMuted,
              }}
            >
              <input
                type="checkbox"
                checked={showDrafts}
                onChange={(e) => setShowDrafts(e.target.checked)}
              />
              Show drafts
            </label>
            <label
              style={{
                fontSize: 12,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                color: tokens.color.textMuted,
              }}
              title="Hide Completed and Canceled engagements"
            >
              <input
                type="checkbox"
                checked={activeOnly}
                onChange={(e) => toggleActiveOnly(e.target.checked)}
              />
              Active only
            </label>
            {view === 'list' && (
              <label
                style={{
                  fontSize: 12,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  color: tokens.color.textMuted,
                }}
              >
                <input
                  type="checkbox"
                  checked={colorRows}
                  onChange={(e) => toggleColorRows(e.target.checked)}
                />
                Color rows by status
              </label>
            )}
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
              <BulkWorkflowButton
                options={bulkStatusOptions}
                onPick={(w) => void bulkSetWorkflow(w)}
              />
              <BulkPriorityButton onPick={(p) => void bulkSetPriority(p)} />
              <Button size="sm" variant="secondary" onClick={() => setMergeOpen(true)}>
                ✉ Mail merge letter
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
                Cancel
              </Button>
            </span>
          </div>
        )}

        {mergeOpen && (
          <MailMergeDialog
            mode="engagements"
            targets={visible
              .filter((r) => selectedIds.has(r.id))
              .map((r) => ({ id: r.clientId, name: r.clientName, engagementId: r.id }))}
            onClose={() => setMergeOpen(false)}
            onDone={() => {
              setMergeOpen(false);
              setSelectedIds(new Set());
            }}
          />
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
              serviceLineId: r.serviceLineId,
            }))}
            columns={statusCols.filter((c) => !hiddenKanbanCols.has(c.workflowState))}
            onMoved={() => void load()}
            onError={(m) => setError(m)}
          />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <Table<EngagementRow>
              columns={engagementColumns}
              rows={paged}
              rowKey={(r) => r.id}
              rowStyle={(r) => {
                if (selectedIds.has(r.id)) return { background: tokens.color.accentMuted };
                if (!colorRows) return undefined;
                const hex = statusColorMap.get(r.workflowState);
                const bg = hex ? tintFromHex(hex) : undefined;
                return bg ? { background: bg } : undefined;
              }}
              empty={
                <div style={{ padding: 40, textAlign: 'center' }}>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>▽</div>
                  <strong>No Results</strong>
                  <div>Please refine your filters.</div>
                </div>
              }
              pagination={pagination}
            />
          </div>
        )}
      </Card>
    </div>
  );
}

function InlineWorkflowEdit({
  value,
  options,
  onChange,
}: {
  value: WorkflowState;
  options: Array<{ value: string; label: string }>;
  onChange: (v: WorkflowState) => void;
}): JSX.Element {
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
            <Pill tone={WORKFLOW_TONE[o.value as WorkflowState] ?? 'neutral'}>{o.label}</Pill>
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

function BulkWorkflowButton({
  options,
  onPick,
}: {
  options: Array<{ value: string; label: string }>;
  onPick: (w: WorkflowState) => void;
}): JSX.Element {
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
        options={options}
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
