/* eslint-disable jsx-a11y/label-has-associated-control -- labels and controls are siblings inside grid containers; revisit with htmlFor/id pairs in a polish pass */
// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Top-level "Tasks" view. Two presentations over the same firm-wide task set:
//   - Table: per-column filter/sort (the shared @vibe/ui ColumnFilter, like
//     the Tax tables) + a title search, with inline edit.
//   - Kanban: one column per status; drag a card to another column to change
//     its status.
// A My/All scope toggle + "show done/canceled" bound the server fetch; the
// per-column filters + sort run client-side for instant response and persist
// for the browser session. The per-client task UI still lives on the client
// detail page (TasksCard); both read/write the same client_task table.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  Button,
  Card,
  ColumnFilter,
  Combobox,
  EmptyState,
  Pill,
  Table,
  type TableColumn,
  Tabs,
  tokens,
  type ComboboxOption,
  type SortDir,
} from '@vibe/ui';

import { api } from '../api-client';
import { useClientPage } from '../lib/use-paged-list';
import {
  PRIORITY_TONE,
  RECURRENCE_LABEL,
  RECURRENCE_OPTIONS,
  STATUS_TONE,
  type TaskPriority,
  type TaskRecurrence,
  type TaskStatus,
} from './clients/task-tones';

interface TaskRow {
  id: string;
  clientId: string;
  clientName: string | null;
  engagementId: string | null;
  engagementName: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  title: string;
  description: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  dueDate: string | null;
  recurrence: TaskRecurrence | null;
  createdAt: string;
  completedAt: string | null;
}

interface AppUser {
  id: string;
  fullName: string;
}

interface ClientHit {
  id: string;
  name: string;
}

const PRIORITY_VALUES = [
  { value: 'URGENT', label: 'Urgent' },
  { value: 'HIGH', label: 'High' },
  { value: 'MEDIUM', label: 'Medium' },
  { value: 'LOW', label: 'Low' },
];
const PRIORITY_RANK: Record<TaskPriority, number> = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

const STATUS_COLUMNS: Array<{ value: TaskStatus; label: string }> = [
  { value: 'OPEN', label: 'Open' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'BLOCKED', label: 'Blocked' },
  { value: 'DONE', label: 'Done' },
  { value: 'CANCELED', label: 'Canceled' },
];
const STATUS_VALUES = STATUS_COLUMNS.map((s) => ({ value: s.value, label: s.label }));

type SortCol = 'title' | 'client' | 'assignee' | 'priority' | 'status' | 'due';

const STORAGE_KEY = 'vibe.tasks.view';

interface PersistedView {
  view: 'table' | 'kanban';
  scope: 'mine' | 'all';
  includeClosed: boolean;
  sortCol: SortCol | '';
  sortDir: SortDir;
  client: string[];
  assignee: string[];
  priority: string[];
  status: string[];
  dueRange: DueRange;
}

const DEFAULT_VIEW: PersistedView = {
  view: 'table',
  scope: 'mine',
  includeClosed: false,
  sortCol: 'due',
  sortDir: 'asc',
  client: [],
  assignee: [],
  priority: [],
  status: [],
  dueRange: 'all',
};

function loadView(): PersistedView {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_VIEW;
    return { ...DEFAULT_VIEW, ...(JSON.parse(raw) as Partial<PersistedView>) };
  } catch {
    return DEFAULT_VIEW;
  }
}

function todayIso(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

const UNASSIGNED = '__unassigned__';

type DueRange = 'all' | 'week' | 'month' | 'quarter' | 'year';
const DUE_RANGE_OPTIONS: Array<{ value: DueRange; label: string }> = [
  { value: 'all', label: 'All due dates' },
  { value: 'week', label: 'Due this week' },
  { value: 'month', label: 'Due this month' },
  { value: 'quarter', label: 'Due this quarter' },
  { value: 'year', label: 'Due this year' },
];

// True when a task's due date falls in the calendar period containing today.
// Undated tasks are excluded once a range is chosen (nothing to match on).
function dueInRange(dueIso: string | null, range: DueRange): boolean {
  if (range === 'all') return true;
  if (!dueIso) return false;
  const [y, m, d] = dueIso.split('-').map(Number);
  if (!y || !m || !d) return false;
  const due = new Date(y, m - 1, d);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  let start: Date;
  let end: Date;
  if (range === 'week') {
    start = new Date(now);
    start.setDate(now.getDate() - now.getDay()); // Sunday
    end = new Date(start);
    end.setDate(start.getDate() + 7);
  } else if (range === 'month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  } else if (range === 'quarter') {
    const q = Math.floor(now.getMonth() / 3);
    start = new Date(now.getFullYear(), q * 3, 1);
    end = new Date(now.getFullYear(), q * 3 + 3, 1);
  } else {
    start = new Date(now.getFullYear(), 0, 1);
    end = new Date(now.getFullYear() + 1, 0, 1);
  }
  return due >= start && due < end;
}

export function TasksPage(): JSX.Element {
  const navigate = useNavigate();
  const initial = useMemo(() => loadView(), []);

  const [rows, setRows] = useState<TaskRow[]>([]);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [view, setView] = useState<'table' | 'kanban'>(initial.view);
  const [scope, setScope] = useState<'mine' | 'all'>(initial.scope);
  const [includeClosed, setIncludeClosed] = useState(initial.includeClosed);
  const [q, setQ] = useState('');

  const [sortBy, setSortBy] = useState<{ col: SortCol | ''; dir: SortDir }>({
    col: initial.sortCol,
    dir: initial.sortDir,
  });
  const [clientFilter, setClientFilter] = useState<Set<string>>(new Set(initial.client));
  const [assigneeFilter, setAssigneeFilter] = useState<Set<string>>(new Set(initial.assignee));
  const [priorityFilter, setPriorityFilter] = useState<Set<string>>(new Set(initial.priority));
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set(initial.status));
  const [dueRange, setDueRange] = useState<DueRange>(initial.dueRange);

  // dialog: undefined = closed; null = create; TaskRow = edit
  const [dialog, setDialog] = useState<TaskRow | null | undefined>(undefined);

  const today = useMemo(() => todayIso(), []);

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('scope', scope);
      // Load all statuses so client-side status filter + kanban columns work;
      // gate done/canceled behind the toggle to keep the set bounded.
      params.set('status', includeClosed ? 'ALL' : 'OPEN,IN_PROGRESS,BLOCKED');
      if (q.trim()) params.set('q', q.trim());
      params.set('pageSize', '200');
      const r = await api<{ items: TaskRow[] }>(`/api/staff/tasks?${params.toString()}`);
      setRows(r.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void api<{ users: AppUser[] }>('/api/staff/tasks/assignees')
      .then((r) => setUsers(r.users ?? []))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, includeClosed]);

  useEffect(() => {
    const v: PersistedView = {
      view,
      scope,
      includeClosed,
      sortCol: sortBy.col,
      sortDir: sortBy.dir,
      client: [...clientFilter],
      assignee: [...assigneeFilter],
      priority: [...priorityFilter],
      status: [...statusFilter],
      dueRange,
    };
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(v));
    } catch {
      /* private mode — in-memory only */
    }
  }, [
    view,
    scope,
    includeClosed,
    sortBy,
    clientFilter,
    assigneeFilter,
    priorityFilter,
    statusFilter,
    dueRange,
  ]);

  async function patch(id: string, body: Record<string, unknown>): Promise<void> {
    setBusyId(id);
    // Optimistic update for snappy drag/drop + quick actions.
    setRows((prev) => prev.map((t) => (t.id === id ? { ...t, ...(body as Partial<TaskRow>) } : t)));
    try {
      await api(`/api/staff/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'update_failed');
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: string): Promise<void> {
    if (!confirm('Remove this task?')) return;
    setBusyId(id);
    try {
      await api(`/api/staff/tasks/${id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'remove_failed');
    } finally {
      setBusyId(null);
    }
  }

  // Distinct filter value lists from the loaded rows.
  const clientValues = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (r.clientId) m.set(r.clientId, r.clientName ?? r.clientId);
    return [...m.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [rows]);
  const assigneeValues = useMemo(() => {
    const m = new Map<string, string>();
    let anyUnassigned = false;
    for (const r of rows) {
      if (r.assigneeUserId) m.set(r.assigneeUserId, r.assigneeName ?? r.assigneeUserId);
      else anyUnassigned = true;
    }
    const out = [...m.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
    if (anyUnassigned) out.push({ value: UNASSIGNED, label: 'Unassigned' });
    return out;
  }, [rows]);

  // Shared client-side filter (everything except status — kanban columns ARE
  // the status, so the board ignores the status filter).
  function passesNonStatus(t: TaskRow): boolean {
    if (clientFilter.size > 0 && !clientFilter.has(t.clientId)) return false;
    if (assigneeFilter.size > 0 && !assigneeFilter.has(t.assigneeUserId ?? UNASSIGNED))
      return false;
    if (priorityFilter.size > 0 && !priorityFilter.has(t.priority)) return false;
    if (!dueInRange(t.dueDate, dueRange)) return false;
    return true;
  }

  const tableRows = useMemo(() => {
    let r = rows.filter(
      (t) => passesNonStatus(t) && (statusFilter.size === 0 || statusFilter.has(t.status)),
    );
    if (sortBy.col && sortBy.dir) {
      const sign = sortBy.dir === 'asc' ? 1 : -1;
      const col = sortBy.col;
      r = [...r].sort((a, b) => {
        let cmp = 0;
        switch (col) {
          case 'title':
            cmp = a.title.toLowerCase().localeCompare(b.title.toLowerCase());
            break;
          case 'client':
            cmp = (a.clientName ?? '')
              .toLowerCase()
              .localeCompare((b.clientName ?? '').toLowerCase());
            break;
          case 'assignee':
            cmp = (a.assigneeName ?? '')
              .toLowerCase()
              .localeCompare((b.assigneeName ?? '').toLowerCase());
            break;
          case 'priority':
            cmp = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
            break;
          case 'status':
            cmp = a.status.localeCompare(b.status);
            break;
          case 'due':
            cmp = (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999');
            break;
        }
        if (cmp !== 0) return cmp * sign;
        return Date.parse(b.createdAt) - Date.parse(a.createdAt);
      });
    }
    return r;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, clientFilter, assigneeFilter, priorityFilter, statusFilter, dueRange, sortBy]);

  const kanbanRows = useMemo(
    () => rows.filter(passesNonStatus),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, clientFilter, assigneeFilter, priorityFilter, dueRange],
  );

  const sortFor = (c: SortCol): SortDir => (sortBy.col === c ? sortBy.dir : null);
  const filtersActive =
    clientFilter.size + assigneeFilter.size + priorityFilter.size + statusFilter.size > 0 ||
    dueRange !== 'all' ||
    q.trim().length > 0;

  function clearFilters(): void {
    setClientFilter(new Set());
    setAssigneeFilter(new Set());
    setPriorityFilter(new Set());
    setStatusFilter(new Set());
    setDueRange('all');
    setQ('');
    void load();
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg }}>
      <Card title="Tasks" action={<Button onClick={() => setDialog(null)}>+ New task</Button>}>
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
            {error}
          </p>
        )}

        <div
          style={{
            display: 'flex',
            gap: 12,
            flexWrap: 'wrap',
            alignItems: 'center',
            marginBottom: 12,
          }}
        >
          <Tabs
            tabs={[
              { key: 'table', label: 'Table' },
              { key: 'kanban', label: 'Kanban' },
            ]}
            active={view}
            onChange={(k) => setView(k as 'table' | 'kanban')}
          />
          <div style={{ display: 'inline-flex', gap: 4 }}>
            {(['mine', 'all'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                style={{
                  padding: '6px 14px',
                  fontSize: 13,
                  cursor: 'pointer',
                  border: `1px solid ${scope === s ? tokens.color.accent : tokens.color.border}`,
                  background: scope === s ? tokens.color.accent : 'transparent',
                  color: scope === s ? '#fff' : tokens.color.text,
                  borderRadius: tokens.radius.md,
                }}
              >
                {s === 'mine' ? 'My tasks' : 'All tasks'}
              </button>
            ))}
          </div>
          <div style={{ flex: 1, minWidth: 180, display: 'flex', gap: 6 }}>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void load();
              }}
              placeholder="Search title…"
              aria-label="Search tasks"
              style={{
                flex: 1,
                padding: '6px 10px',
                background: tokens.color.surface,
                color: tokens.color.text,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                fontSize: 13,
              }}
            />
            <Button size="sm" variant="secondary" onClick={() => void load()}>
              Search
            </Button>
          </div>
          <label style={{ display: 'flex', gap: 6, fontSize: 13, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={includeClosed}
              onChange={(e) => setIncludeClosed(e.target.checked)}
            />
            Show done / canceled
          </label>
          <select
            aria-label="Filter by due date"
            value={dueRange}
            onChange={(e) => setDueRange(e.target.value as DueRange)}
            style={{
              padding: '6px 10px',
              fontSize: 13,
              background: tokens.color.surface,
              color: tokens.color.text,
              border: `1px solid ${dueRange === 'all' ? tokens.color.border : tokens.color.accent}`,
              borderRadius: tokens.radius.md,
            }}
          >
            {DUE_RANGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {filtersActive && (
            <button
              type="button"
              onClick={clearFilters}
              style={{
                background: 'none',
                border: 'none',
                color: tokens.color.accent,
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              Clear filters
            </button>
          )}
        </div>

        {loading ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
        ) : view === 'table' ? (
          <TaskTable
            rows={tableRows}
            total={rows.length}
            today={today}
            busyId={busyId}
            clientValues={clientValues}
            assigneeValues={assigneeValues}
            clientFilter={clientFilter}
            assigneeFilter={assigneeFilter}
            priorityFilter={priorityFilter}
            statusFilter={statusFilter}
            setClientFilter={setClientFilter}
            setAssigneeFilter={setAssigneeFilter}
            setPriorityFilter={setPriorityFilter}
            setStatusFilter={setStatusFilter}
            sortFor={sortFor}
            setSortBy={setSortBy}
            onOpenClient={(id) => navigate(`/clients/${id}`)}
            onEdit={(t) => setDialog(t)}
            onSetStatus={(id, status) => void patch(id, { status })}
            onRemove={(id) => void remove(id)}
          />
        ) : (
          <KanbanBoard
            rows={kanbanRows}
            today={today}
            onEdit={(t) => setDialog(t)}
            onMove={(id, status) => void patch(id, { status })}
          />
        )}
      </Card>

      {dialog !== undefined && (
        <TaskDialog
          users={users}
          task={dialog}
          onClose={() => setDialog(undefined)}
          onSaved={() => {
            setDialog(undefined);
            void load();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table view
// ---------------------------------------------------------------------------

function TaskTable(props: {
  rows: TaskRow[];
  total: number;
  today: string;
  busyId: string | null;
  clientValues: Array<{ value: string; label: string }>;
  assigneeValues: Array<{ value: string; label: string }>;
  clientFilter: Set<string>;
  assigneeFilter: Set<string>;
  priorityFilter: Set<string>;
  statusFilter: Set<string>;
  setClientFilter: (s: Set<string>) => void;
  setAssigneeFilter: (s: Set<string>) => void;
  setPriorityFilter: (s: Set<string>) => void;
  setStatusFilter: (s: Set<string>) => void;
  sortFor: (c: SortCol) => SortDir;
  setSortBy: (s: { col: SortCol; dir: SortDir }) => void;
  onOpenClient: (id: string) => void;
  onEdit: (t: TaskRow) => void;
  onSetStatus: (id: string, status: TaskStatus) => void;
  onRemove: (id: string) => void;
}): JSX.Element {
  const {
    rows,
    total,
    today,
    busyId,
    clientValues,
    assigneeValues,
    clientFilter,
    assigneeFilter,
    priorityFilter,
    statusFilter,
    setClientFilter,
    setAssigneeFilter,
    setPriorityFilter,
    setStatusFilter,
    sortFor,
    setSortBy,
    onOpenClient,
    onEdit,
    onSetStatus,
    onRemove,
  } = props;

  const { paged, pagination } = useClientPage(rows);

  if (total === 0) {
    return (
      <EmptyState title="No tasks" body="Create a task or adjust the scope / filters above." />
    );
  }

  const columns: TableColumn<TaskRow>[] = [
    {
      key: 'title',
      mobile: 'title',
      mobileLabel: 'Task',
      header: (
        <>
          Task{' '}
          <ColumnFilter
            ariaLabel="Sort by task"
            values={[]}
            selected={new Set()}
            searchable={false}
            sort={sortFor('title')}
            onApply={(_, dir) => dir && setSortBy({ col: 'title', dir })}
          />
        </>
      ),
      render: (t) => (
        <button
          onClick={() => onEdit(t)}
          style={{
            border: 'none',
            background: 'transparent',
            padding: 0,
            textAlign: 'left',
            cursor: 'pointer',
          }}
        >
          <strong style={{ fontSize: 13, color: tokens.color.accent }}>
            {t.title}
            {t.recurrence && (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 400,
                  color: tokens.color.textMuted,
                  marginLeft: 6,
                }}
                title={`Repeats ${RECURRENCE_LABEL[t.recurrence]}`}
              >
                ↻ {RECURRENCE_LABEL[t.recurrence]}
              </span>
            )}
          </strong>
          {t.description && (
            <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
              {t.description.length > 80 ? `${t.description.slice(0, 80)}…` : t.description}
            </div>
          )}
        </button>
      ),
    },
    {
      key: 'client',
      mobile: 'meta',
      mobileLabel: 'Client',
      header: (
        <>
          Client{' '}
          <ColumnFilter
            ariaLabel="Filter / sort client"
            values={clientValues}
            selected={clientFilter}
            sort={sortFor('client')}
            onApply={(sel, dir) => {
              setClientFilter(sel);
              if (dir) setSortBy({ col: 'client', dir });
            }}
          />
        </>
      ),
      render: (t) => (
        <div style={{ display: 'grid', gap: 2 }}>
          <button
            onClick={() => onOpenClient(t.clientId)}
            style={{
              border: 'none',
              background: 'transparent',
              color: tokens.color.accent,
              cursor: 'pointer',
              fontSize: 13,
              padding: 0,
              textAlign: 'left',
            }}
          >
            {t.clientName ?? '—'}
          </button>
          {t.engagementName && (
            <span style={{ fontSize: 11, color: tokens.color.textMuted }}>{t.engagementName}</span>
          )}
        </div>
      ),
    },
    {
      key: 'assignee',
      mobile: 'field',
      mobileLabel: 'Assignee',
      header: (
        <>
          Assignee{' '}
          <ColumnFilter
            ariaLabel="Filter / sort assignee"
            values={assigneeValues}
            selected={assigneeFilter}
            sort={sortFor('assignee')}
            onApply={(sel, dir) => {
              setAssigneeFilter(sel);
              if (dir) setSortBy({ col: 'assignee', dir });
            }}
          />
        </>
      ),
      render: (t) => t.assigneeName ?? 'Unassigned',
    },
    {
      key: 'priority',
      mobile: 'badge',
      mobileLabel: 'Priority',
      header: (
        <>
          Priority{' '}
          <ColumnFilter
            ariaLabel="Filter / sort priority"
            values={PRIORITY_VALUES}
            selected={priorityFilter}
            searchable={false}
            sort={sortFor('priority')}
            onApply={(sel, dir) => {
              setPriorityFilter(sel);
              if (dir) setSortBy({ col: 'priority', dir });
            }}
          />
        </>
      ),
      render: (t) => <Pill tone={PRIORITY_TONE[t.priority]}>{t.priority}</Pill>,
    },
    {
      key: 'status',
      mobile: 'badge',
      mobileLabel: 'Status',
      header: (
        <>
          Status{' '}
          <ColumnFilter
            ariaLabel="Filter / sort status"
            values={STATUS_VALUES}
            selected={statusFilter}
            searchable={false}
            sort={sortFor('status')}
            onApply={(sel, dir) => {
              setStatusFilter(sel);
              if (dir) setSortBy({ col: 'status', dir });
            }}
          />
        </>
      ),
      render: (t) => <Pill tone={STATUS_TONE[t.status]}>{t.status.replace('_', ' ')}</Pill>,
    },
    {
      key: 'due',
      mobile: 'field',
      mobileLabel: 'Due',
      header: (
        <>
          Due{' '}
          <ColumnFilter
            ariaLabel="Sort by due date"
            values={[]}
            selected={new Set()}
            searchable={false}
            sort={sortFor('due')}
            onApply={(_, dir) => dir && setSortBy({ col: 'due', dir })}
          />
        </>
      ),
      render: (t) => {
        const overdue =
          t.dueDate != null && t.dueDate < today && t.status !== 'DONE' && t.status !== 'CANCELED';
        return t.dueDate ? (
          <span
            style={{
              fontSize: 12,
              color: overdue ? tokens.color.danger : tokens.color.textMuted,
              fontWeight: overdue ? 600 : 400,
            }}
          >
            {t.dueDate}
          </span>
        ) : (
          <span style={{ fontSize: 12, color: tokens.color.textMuted }}>—</span>
        );
      },
    },
    {
      key: 'actions',
      mobile: 'actions',
      header: 'Actions',
      align: 'right',
      render: (t) => (
        <span style={{ display: 'inline-flex', gap: 4 }}>
          <Button size="sm" variant="ghost" onClick={() => onEdit(t)}>
            Edit
          </Button>
          {t.status !== 'DONE' && t.status !== 'CANCELED' && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busyId === t.id}
              onClick={() => onSetStatus(t.id, 'DONE')}
            >
              Done
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={busyId === t.id}
            onClick={() => onRemove(t.id)}
          >
            Remove
          </Button>
        </span>
      ),
    },
  ];

  return (
    <>
      <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 6 }}>
        {rows.length === total ? `${total} tasks` : `${rows.length} of ${total}`}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <Table<TaskRow>
          columns={columns}
          rows={paged}
          rowKey={(t) => t.id}
          rowStyle={(t) => ({ background: priorityRowBg(t.priority) })}
          empty="No tasks match these filters."
          pagination={pagination}
        />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Kanban view
// ---------------------------------------------------------------------------

function KanbanBoard(props: {
  rows: TaskRow[];
  today: string;
  onEdit: (t: TaskRow) => void;
  onMove: (id: string, status: TaskStatus) => void;
}): JSX.Element {
  const { rows, today, onEdit, onMove } = props;
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<TaskStatus | null>(null);

  const byStatus = useMemo(() => {
    const m = new Map<TaskStatus, TaskRow[]>();
    for (const c of STATUS_COLUMNS) m.set(c.value, []);
    for (const t of rows) m.get(t.status)?.push(t);
    return m;
  }, [rows]);

  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        overflowX: 'auto',
        alignItems: 'flex-start',
        paddingBottom: 8,
      }}
    >
      {STATUS_COLUMNS.map((col) => {
        const list = byStatus.get(col.value) ?? [];
        const isOver = overCol === col.value;
        return (
          <div
            key={col.value}
            onDragOver={(e) => {
              e.preventDefault();
              setOverCol(col.value);
            }}
            onDragLeave={() => setOverCol((c) => (c === col.value ? null : c))}
            onDrop={(e) => {
              e.preventDefault();
              const id = dragId ?? e.dataTransfer.getData('text/plain');
              setOverCol(null);
              setDragId(null);
              if (id) onMove(id, col.value);
            }}
            style={{
              flex: '0 0 260px',
              minWidth: 260,
              background: isOver ? tokens.color.surface : 'transparent',
              border: `1px solid ${isOver ? tokens.color.accent : tokens.color.border}`,
              borderRadius: tokens.radius.md,
              padding: 8,
              display: 'grid',
              gap: 8,
              alignContent: 'start',
              minHeight: 120,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Pill tone={STATUS_TONE[col.value]}>{col.label}</Pill>
              <span style={{ fontSize: 12, color: tokens.color.textMuted }}>{list.length}</span>
            </div>
            {list.map((t) => {
              const overdue =
                t.dueDate != null &&
                t.dueDate < today &&
                t.status !== 'DONE' &&
                t.status !== 'CANCELED';
              return (
                <div
                  key={t.id}
                  role="button"
                  tabIndex={0}
                  draggable
                  onDragStart={(e) => {
                    setDragId(t.id);
                    e.dataTransfer.setData('text/plain', t.id);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragEnd={() => setDragId(null)}
                  onClick={() => onEdit(t)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onEdit(t);
                    }
                  }}
                  style={{
                    background:
                      t.priority === 'URGENT' || t.priority === 'HIGH'
                        ? priorityRowBg(t.priority)
                        : tokens.color.surface,
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.sm,
                    padding: 8,
                    cursor: 'grab',
                    display: 'grid',
                    gap: 6,
                    opacity: dragId === t.id ? 0.5 : 1,
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600 }}>
                    {t.title}
                    {t.recurrence && (
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 400,
                          color: tokens.color.textMuted,
                          marginLeft: 6,
                        }}
                        title={`Repeats ${RECURRENCE_LABEL[t.recurrence]}`}
                      >
                        ↻ {RECURRENCE_LABEL[t.recurrence]}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
                    {t.clientName ?? '—'}
                    {t.engagementName && (
                      <span style={{ opacity: 0.8 }}> · {t.engagementName}</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Pill tone={PRIORITY_TONE[t.priority]}>{t.priority}</Pill>
                    <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                      {t.assigneeName ?? 'Unassigned'}
                    </span>
                    {t.dueDate && (
                      <span
                        style={{
                          fontSize: 11,
                          marginLeft: 'auto',
                          color: overdue ? tokens.color.danger : tokens.color.textMuted,
                          fontWeight: overdue ? 600 : 400,
                        }}
                      >
                        {t.dueDate}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
            {list.length === 0 && (
              <div style={{ fontSize: 12, color: tokens.color.textMuted, padding: '8px 4px' }}>
                Drop here
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / Edit dialog
// ---------------------------------------------------------------------------

function TaskDialog({
  users,
  task,
  onClose,
  onSaved,
}: {
  users: AppUser[];
  task: TaskRow | null; // null = create
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const editing = task != null;
  const [clientQuery, setClientQuery] = useState('');
  const [clientHits, setClientHits] = useState<ClientHit[]>([]);
  const [clientId, setClientId] = useState(task?.clientId ?? '');
  const [clientLabel, setClientLabel] = useState(task?.clientName ?? '');
  // Optional engagement association — options are the selected client's
  // engagements (loaded on demand).
  const [engagementId, setEngagementId] = useState(task?.engagementId ?? '');
  const [engagementOptions, setEngagementOptions] = useState<Array<{ id: string; name: string }>>(
    [],
  );
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? 'MEDIUM');
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? 'OPEN');
  const [dueDate, setDueDate] = useState(task?.dueDate ?? '');
  const [assigneeUserId, setAssigneeUserId] = useState(task?.assigneeUserId ?? '');
  const [recurrence, setRecurrence] = useState<TaskRecurrence | ''>(task?.recurrence ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (editing || clientId) return;
    const term = clientQuery.trim();
    if (!term) {
      setClientHits([]);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      void api<{ items: ClientHit[] }>(
        `/api/staff/clients?q=${encodeURIComponent(term)}&pageSize=10`,
      )
        .then((r) => {
          if (alive) setClientHits(r.items ?? []);
        })
        .catch(() => undefined);
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [clientQuery, clientId, editing]);

  // Load the selected client's engagements for the association dropdown.
  useEffect(() => {
    if (!clientId) {
      setEngagementOptions([]);
      return;
    }
    let alive = true;
    void api<{ items: Array<{ id: string; name: string }> }>(
      `/api/staff/engagements?clientId=${clientId}&pageSize=200`,
    )
      .then((r) => {
        if (alive) setEngagementOptions(r.items ?? []);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [clientId]);

  async function save(): Promise<void> {
    if (!title.trim() || (!editing && !clientId)) return;
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        await api(`/api/staff/tasks/${task!.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            title: title.trim(),
            description: description.trim() || null,
            priority,
            status,
            dueDate: dueDate || null,
            assigneeUserId: assigneeUserId || null,
            recurrence: recurrence || null,
            engagementId: engagementId || null,
          }),
        });
      } else {
        await api('/api/staff/tasks', {
          method: 'POST',
          body: JSON.stringify({
            clientId,
            title: title.trim(),
            description: description.trim() || null,
            priority,
            dueDate: dueDate || null,
            assigneeUserId: assigneeUserId || null,
            recurrence: recurrence || null,
            engagementId: engagementId || null,
          }),
        });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save_failed');
    } finally {
      setBusy(false);
    }
  }

  const fieldStyle: React.CSSProperties = {
    padding: '6px 10px',
    background: tokens.color.surface,
    color: tokens.color.text,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.md,
    fontSize: 13,
    width: '100%',
    boxSizing: 'border-box',
  };

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
      <div style={{ minWidth: 480, maxWidth: 560, width: '90%' }}>
        <Card title={editing ? 'Edit task' : 'New task'}>
          {error && (
            <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
              {error}
            </p>
          )}
          <div style={{ display: 'grid', gap: 10 }}>
            <div>
              <label style={{ fontSize: 12, color: tokens.color.textMuted }}>Client *</label>
              {editing || clientId ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Pill tone="accent">{clientLabel || '—'}</Pill>
                  {!editing && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setClientId('');
                        setClientLabel('');
                        setClientQuery('');
                        setEngagementId('');
                      }}
                    >
                      Change
                    </Button>
                  )}
                </div>
              ) : (
                <>
                  <input
                    value={clientQuery}
                    onChange={(e) => setClientQuery(e.target.value)}
                    placeholder="Search clients…"
                    style={fieldStyle}
                  />
                  {clientHits.length > 0 && (
                    <div
                      style={{
                        border: `1px solid ${tokens.color.border}`,
                        borderRadius: tokens.radius.md,
                        marginTop: 4,
                        maxHeight: 180,
                        overflowY: 'auto',
                      }}
                    >
                      {clientHits.map((c) => (
                        <button
                          key={c.id}
                          onClick={() => {
                            setClientId(c.id);
                            setClientLabel(c.name);
                            setClientHits([]);
                            setEngagementId('');
                          }}
                          style={{
                            display: 'block',
                            width: '100%',
                            textAlign: 'left',
                            border: 'none',
                            background: 'transparent',
                            padding: '6px 10px',
                            cursor: 'pointer',
                            fontSize: 13,
                            color: tokens.color.text,
                          }}
                        >
                          {c.name}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            {clientId && (
              <div>
                <label style={{ fontSize: 12, color: tokens.color.textMuted }}>Engagement</label>
                <select
                  value={engagementId}
                  onChange={(e) => setEngagementId(e.target.value)}
                  style={fieldStyle}
                  aria-label="Associated engagement"
                >
                  <option value="">— None —</option>
                  {engagementOptions.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label style={{ fontSize: 12, color: tokens.color.textMuted }}>Title *</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Task title"
                style={fieldStyle}
              />
            </div>

            <div>
              <label style={{ fontSize: 12, color: tokens.color.textMuted }}>Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                style={{ ...fieldStyle, resize: 'vertical' }}
              />
            </div>

            <div
              style={{
                display: 'grid',
                // Two columns when they fit; single column on phone sheets.
                gridTemplateColumns: 'repeat(auto-fit, minmax(min(160px, 100%), 1fr))',
                gap: 8,
              }}
            >
              <div>
                <label style={{ fontSize: 12, color: tokens.color.textMuted }}>Priority</label>
                <Combobox
                  ariaLabel="Priority"
                  value={priority}
                  onChange={(v) => setPriority(v as TaskPriority)}
                  options={[
                    { value: 'LOW', label: 'Low' },
                    { value: 'MEDIUM', label: 'Medium' },
                    { value: 'HIGH', label: 'High' },
                    { value: 'URGENT', label: 'Urgent' },
                  ]}
                />
              </div>
              {editing && (
                <div>
                  <label style={{ fontSize: 12, color: tokens.color.textMuted }}>Status</label>
                  <Combobox
                    ariaLabel="Status"
                    value={status}
                    onChange={(v) => setStatus(v as TaskStatus)}
                    options={STATUS_COLUMNS.map<ComboboxOption>((s) => ({
                      value: s.value,
                      label: s.label,
                    }))}
                  />
                </div>
              )}
              <div>
                <label style={{ fontSize: 12, color: tokens.color.textMuted }}>Due date</label>
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  style={fieldStyle}
                />
              </div>
              <div>
                <label style={{ fontSize: 12, color: tokens.color.textMuted }}>Assignee</label>
                <Combobox
                  ariaLabel="Assignee"
                  clearable
                  value={assigneeUserId}
                  onChange={setAssigneeUserId}
                  options={users.map<ComboboxOption>((u) => ({ value: u.id, label: u.fullName }))}
                  placeholder="Unassigned"
                />
              </div>
              <div>
                <label style={{ fontSize: 12, color: tokens.color.textMuted }}>Repeats</label>
                <Combobox
                  ariaLabel="Repeats"
                  value={recurrence}
                  onChange={(v) => setRecurrence(v as TaskRecurrence | '')}
                  options={RECURRENCE_OPTIONS.map<ComboboxOption>((o) => ({
                    value: o.value,
                    label: o.label,
                  }))}
                />
              </div>
            </div>
            {recurrence && (
              <p style={{ fontSize: 11, color: tokens.color.textMuted, margin: 0 }}>
                When this task is completed, the next one opens automatically.
              </p>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button
                onClick={() => void save()}
                disabled={busy || !title.trim() || (!editing && !clientId)}
              >
                {busy ? 'Saving…' : editing ? 'Save changes' : 'Create task'}
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

// A light tint of the priority pill color for the whole row — only the
// attention-grabbing tiers (Urgent → danger, High → warning) get one; others
// stay on the default surface. color-mix keeps the tint readable in both themes.
function priorityRowBg(priority: TaskPriority): string {
  if (priority === 'URGENT') return `color-mix(in srgb, ${tokens.color.danger} 12%, transparent)`;
  if (priority === 'HIGH') return `color-mix(in srgb, ${tokens.color.warning} 12%, transparent)`;
  return 'transparent';
}
