// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';

import {
  AiPanel,
  Button,
  Card,
  ColumnFilter,
  Combobox,
  Input,
  Pill,
  Table,
  tokens,
  type ComboboxOption,
} from '@vibe/ui';

import { api } from '../api-client';
import {
  elapsedToHours,
  formatHuman,
  useTimersOptional,
  type TimerStartPrefill,
} from '../timer-context';
import { TableSearch } from '../components/TableSearch';
import { filterStatuses } from '../status-filter';
import { useColumnView, viewToPagedQuery } from '../lib/column-view';
import { aiUsable, useAiStatus } from '../hooks/useAiStatus';
import { ProcessProjectDialog } from './clients/ProcessProjectDialog';
import { ExpensesView } from './ExpensesView';

interface Engagement {
  id: string;
  name: string;
  clientId: string;
  // v2 Sprint E — needed for client-first filtering. Server already
  // returns it on /engagements; older callers ignored it.
  status?: string;
  // Progress/board status — preselects the status picker when logging time.
  workflowState?: string;
  // 0148 — drives the work-code filter (joined via engagement_type).
  serviceLineId?: string | null;
}

interface StatusOption {
  workflowState: string;
  label: string;
  // 0167 — service lines this status applies to (empty ⇒ all).
  serviceLineIds: string[];
}

interface Client {
  id: string;
  name: string;
  status?: string;
}

interface WorkCode {
  id: string;
  name: string;
  // 0148 — codes tagged to a service line only show for matching
  // engagements; null = available everywhere.
  serviceLineId?: string | null;
}

interface TimeEntry {
  id: string;
  engagementId: string;
  engagementName?: string;
  clientId?: string;
  clientName?: string;
  workCodeId?: string | null;
  entryDate: string;
  hours: string;
  standardAmountCents: number;
  billableFlag: boolean;
  inScopeFlag: boolean;
  outOfScopeOverride?: boolean;
  description: string;
  lockedAt?: string | null;
  billingBatchId?: string | null;
}

interface DayTotal {
  entryDate: string;
  hours: number;
  amountCents: number;
}

type TaskStatus = 'OPEN' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE' | 'CANCELED';
interface EngagementTask {
  id: string;
  title: string;
  status: TaskStatus;
}
const TASK_STATUS_OPTIONS: Array<{ value: TaskStatus; label: string }> = [
  { value: 'OPEN', label: 'Open' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'BLOCKED', label: 'Blocked' },
  { value: 'DONE', label: 'Done' },
  { value: 'CANCELED', label: 'Canceled' },
];

interface MonthTotal {
  month: string;
  hours: number;
  amountCents: number;
  count: number;
}

type ViewMode = 'log' | 'day' | 'week' | 'month' | 'expenses';

const today = (): string => new Date().toISOString().slice(0, 10);

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function startOfWeek(iso: string): string {
  // Monday-anchored week (matches Postgres date_trunc('week') ISO default).
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0..6, Sunday=0
  const delta = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function dayLabel(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'short',
  });
}

// Map the firm rounding setting ('0.10' | '0.25' | '0.00' = free decimal)
// to the Hours number-input step/min. Free decimal allows any positive value.
function hoursStepMin(roundingHours: string): { step: number | 'any'; min: number } {
  if (roundingHours === '0.00') return { step: 'any', min: 0.01 };
  const n = Number(roundingHours);
  return Number.isFinite(n) && n > 0 ? { step: n, min: n } : { step: 0.25, min: 0.25 };
}

export function TimeEntryPage(): JSX.Element {
  const [view, setView] = useState<ViewMode>('log');
  const [engagements, setEngagements] = useState<Engagement[]>([]);
  const [workCodes, setWorkCodes] = useState<WorkCode[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [statusOptions, setStatusOptions] = useState<StatusOption[]>([]);
  const [pinnedClientIds, setPinnedClientIds] = useState<Set<string>>(new Set());
  // Firm time-entry rounding increment ('0.10' | '0.25' | '0.00' = free).
  const [roundingHours, setRoundingHours] = useState('0.25');

  useEffect(() => {
    void (async () => {
      try {
        const [e, w, c, p, s, cfg] = await Promise.all([
          api<{ items: Engagement[] }>('/api/staff/engagements'),
          api<{ items: WorkCode[] }>('/api/staff/taxonomy/work-codes'),
          api<{ items: Client[] }>('/api/staff/clients'),
          api<{ items: { clientId: string }[] }>('/api/staff/clients/pins').catch(() => ({
            items: [],
          })),
          api<{ items: StatusOption[] }>('/api/staff/engagement-statuses').catch(() => ({
            items: [],
          })),
          api<{ roundingHours: string }>('/api/staff/time-entries/config').catch(() => ({
            roundingHours: '0.25',
          })),
        ]);
        setEngagements(e.items ?? []);
        setWorkCodes(w.items ?? []);
        setStatusOptions(s.items ?? []);
        setRoundingHours(cfg.roundingHours ?? '0.25');
        // Sort pinned clients to top of the list.
        const pins = new Set((p.items ?? []).map((x) => x.clientId));
        setPinnedClientIds(pins);
        const sorted = [...(c.items ?? [])].sort((a, b) => {
          const pa = pins.has(a.id) ? 0 : 1;
          const pb = pins.has(b.id) ? 0 : 1;
          if (pa !== pb) return pa - pb;
          return a.name.localeCompare(b.name);
        });
        setClients(sorted);
      } catch {
        // Silent; child views render empty/error states themselves.
      }
    })();
  }, []);

  async function togglePin(clientId: string): Promise<void> {
    const isPinned = pinnedClientIds.has(clientId);
    try {
      if (isPinned) {
        await api(`/api/staff/clients/pins/${clientId}`, { method: 'DELETE' });
        const next = new Set(pinnedClientIds);
        next.delete(clientId);
        setPinnedClientIds(next);
      } else {
        await api('/api/staff/clients/pins', {
          method: 'POST',
          body: JSON.stringify({ clientId }),
        });
        const next = new Set(pinnedClientIds);
        next.add(clientId);
        setPinnedClientIds(next);
      }
      // Re-sort with new pin state.
      setClients((prev) =>
        [...prev].sort((a, b) => {
          const set = isPinned
            ? new Set(Array.from(pinnedClientIds).filter((id) => id !== clientId))
            : new Set([...Array.from(pinnedClientIds), clientId]);
          const pa = set.has(a.id) ? 0 : 1;
          const pb = set.has(b.id) ? 0 : 1;
          if (pa !== pb) return pa - pb;
          return a.name.localeCompare(b.name);
        }),
      );
    } catch {
      // Non-fatal.
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <ViewTabs view={view} onChange={setView} />
      {view === 'log' && (
        <LogView
          engagements={engagements}
          workCodes={workCodes}
          clients={clients}
          statusOptions={statusOptions}
          pinnedClientIds={pinnedClientIds}
          roundingHours={roundingHours}
          onTogglePin={(id) => void togglePin(id)}
          onEngagementStatusChanged={(engId, ws) =>
            setEngagements((prev) =>
              prev.map((e) => (e.id === engId ? { ...e, workflowState: ws } : e)),
            )
          }
        />
      )}
      {view === 'day' && (
        <DayView
          engagements={engagements}
          clients={clients}
          workCodes={workCodes}
          roundingHours={roundingHours}
        />
      )}
      {view === 'week' && (
        <WeekView
          engagements={engagements}
          clients={clients}
          workCodes={workCodes}
          roundingHours={roundingHours}
        />
      )}
      {view === 'month' && <MonthView />}
      {view === 'expenses' && <ExpensesView engagements={engagements} clients={clients} />}
    </div>
  );
}

// v2 Sprint E — last-used client persisted per timekeeper-day. Used by
// the Quick log combobox so a CPA's first time entry of the day starts
// where they left off the day before. Server-side preference comes in
// a later sprint; localStorage is the v1 of this.
const LAST_CLIENT_KEY = '__vibe_last_client_id';

// 0050 — inline edit input style for the entries table.
const inlineInputStyle: React.CSSProperties = {
  padding: '4px 6px',
  background: tokens.color.surface,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  fontSize: 13,
  width: 80,
  boxSizing: 'border-box',
};

// Date filters in the "My entries" toolbar. Fill their grid cell and match the
// other controls' height so the full mm/dd/yyyy value + calendar icon show
// (the shared inlineInputStyle is 80px — too narrow, it truncates to "mm/dd,").
const dateFilterStyle: React.CSSProperties = {
  padding: '7px 10px',
  background: tokens.color.surface,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  fontSize: 13,
  width: '100%',
  boxSizing: 'border-box',
  colorScheme: 'light dark',
};

// 0050 — sortable column-header button style. Looks like a plain header
// label but is keyboard-focusable and triggers toggleSort.
function ViewTabs({
  view,
  onChange,
}: {
  view: ViewMode;
  onChange: (v: ViewMode) => void;
}): JSX.Element {
  const tabs: { id: ViewMode; label: string }[] = [
    { id: 'log', label: 'Quick log' },
    { id: 'day', label: 'Day' },
    { id: 'week', label: 'Week' },
    { id: 'month', label: 'Month' },
    { id: 'expenses', label: 'Expenses' },
  ];
  return (
    <div
      role="tablist"
      style={{
        display: 'inline-flex',
        gap: 2,
        padding: 2,
        background: tokens.color.surface,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md,
        width: 'fit-content',
      }}
    >
      {tabs.map((t) => {
        const active = view === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            style={{
              padding: '6px 14px',
              border: 'none',
              borderRadius: tokens.radius.sm,
              background: active ? tokens.color.accent : 'transparent',
              color: active ? '#fff' : tokens.color.text,
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function LogView({
  engagements,
  workCodes,
  clients,
  statusOptions,
  pinnedClientIds,
  roundingHours,
  onTogglePin,
  onEngagementStatusChanged,
}: {
  engagements: Engagement[];
  workCodes: WorkCode[];
  clients: Client[];
  statusOptions: StatusOption[];
  pinnedClientIds: Set<string>;
  roundingHours: string;
  onTogglePin: (clientId: string) => void;
  onEngagementStatusChanged: (engagementId: string, workflowState: string) => void;
}): JSX.Element {
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // v2 Sprint E — client-first workflow. The CPA picks a client, then
  // engagement is filtered to that client's ACTIVE engagements. If the
  // client has exactly one active engagement it auto-selects.
  // 0050 — read query params for dashboard "Time" button prefill. URL
  // params override the persisted last-used client on first render.
  const [searchParams, setSearchParams] = useSearchParams();
  const initialClientId = searchParams.get('clientId') ?? '';
  const initialEngagementId = searchParams.get('engagementId') ?? '';
  // CONNECT_INTEGRATION D.6 — pre-fill flow from the untracked
  // messages panel. linkMessageId is carried through submit so the
  // resulting entry is auto-linked to the citing message.
  const initialDescription = searchParams.get('description') ?? '';
  const initialLinkMessageId = searchParams.get('linkMessageId') ?? '';
  // 0179 — appointment "Log time" deep link. Carries the originating
  // appointment (persisted as a back-link on submit) plus a pre-filled
  // duration (hours) and the appointment's date.
  const initialAppointmentId = searchParams.get('appointmentId') ?? '';
  const qpHours = searchParams.get('hours');
  const qpDate = searchParams.get('date');
  const [clientId, setClientId] = useState(() => {
    if (initialClientId) return initialClientId;
    try {
      return localStorage.getItem(LAST_CLIENT_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [engagementId, setEngagementId] = useState(initialEngagementId);
  const [workCodeId, setWorkCodeId] = useState('');
  // Selected client's outstanding A/R (cents) — shown in the log-time box so
  // staff see the balance while working. Same figure as the client header.
  const [outstandingCents, setOutstandingCents] = useState<number | null>(null);
  const [avgDaysPastDue, setAvgDaysPastDue] = useState<number | null>(null);
  useEffect(() => {
    if (!clientId) {
      setOutstandingCents(null);
      setAvgDaysPastDue(null);
      return;
    }
    let alive = true;
    setOutstandingCents(null);
    setAvgDaysPastDue(null);
    void api<{ summary: { outstandingCents: number; avgDaysPastDue?: number } | null }>(
      `/api/staff/stats/client/${clientId}`,
    )
      .then((r) => {
        if (alive) {
          setOutstandingCents(r.summary?.outstandingCents ?? 0);
          setAvgDaysPastDue(r.summary?.avgDaysPastDue ?? 0);
        }
      })
      .catch(() => {
        if (alive) setOutstandingCents(-1); // sentinel: unavailable → render "—"
      });
    return () => {
      alive = false;
    };
  }, [clientId]);
  // 0148 — only offer codes applicable to the engagement's service line.
  // Codes with no service line are universal; engagements without a
  // service line (no engagement type) see every code.
  const selectedEngagement = engagements.find((e) => e.id === engagementId);
  const applicableWorkCodes = workCodes.filter(
    (w) =>
      !w.serviceLineId ||
      !selectedEngagement?.serviceLineId ||
      w.serviceLineId === selectedEngagement.serviceLineId,
  );
  // 0167 — only offer statuses mapped to the engagement's service line.
  // The engagement's current state is always kept so it never disappears.
  const applicableStatusOptions = filterStatuses(
    statusOptions,
    selectedEngagement?.serviceLineId ?? null,
    selectedEngagement?.workflowState,
  );
  // Progress status to set on save; preselected to the engagement's current.
  const [workflowState, setWorkflowState] = useState('');
  // Open tasks on the selected engagement — their status can be changed inline
  // as part of logging time.
  const [engagementTasks, setEngagementTasks] = useState<EngagementTask[]>([]);
  // Process-project print dialog (opened from the green-box button).
  const [processOpen, setProcessOpen] = useState(false);
  const [entryDate, setEntryDate] = useState(
    qpDate && /^\d{4}-\d{2}-\d{2}$/.test(qpDate) ? qpDate : today(),
  );
  const [hours, setHours] = useState(
    qpHours && Number(qpHours) > 0 ? Number(qpHours).toFixed(2) : '1.00',
  );
  const [description, setDescription] = useState(initialDescription);
  const [linkMessageId, setLinkMessageId] = useState(initialLinkMessageId);
  // 0179 — one-shot back-link from the appointment "Log time" deep link;
  // cleared after the first save so a subsequent manual entry isn't linked.
  const [appointmentId, setAppointmentId] = useState(initialAppointmentId);
  // 0050 — user-controlled out-of-scope override.
  const [outOfScope, setOutOfScope] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // 0207 — "Finish on Time page" timer handoff. With ?timerId= present the
  // form prefills from the parked timer (client/engagement/work code/
  // description + exact hours from elapsed) and submit converts it through
  // the timer save endpoint — deleting the timer — instead of a plain
  // create. Hours drop to free-decimal while finishing so an exact 0.31
  // isn't blocked by the firm's rounding step.
  const timerCtx = useTimersOptional();
  const [finishingTimerId, setFinishingTimerId] = useState(searchParams.get('timerId') ?? '');
  const finishingTimer =
    (finishingTimerId && timerCtx?.timers.find((t) => t.id === finishingTimerId)) || null;
  const timerPrefilled = useRef(false);
  // Drop the handoff param from the URL so a refresh doesn't re-enter
  // finish mode after the timer is gone.
  const clearTimerParam = useCallback(() => {
    if (searchParams.has('timerId')) {
      const next = new URLSearchParams(searchParams);
      next.delete('timerId');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);
  // React to later navigations too ("Finish on Time page" clicked while
  // already on /time) — the useState initializer only covers mount.
  const urlTimerId = searchParams.get('timerId') ?? '';
  useEffect(() => {
    if (urlTimerId && urlTimerId !== finishingTimerId) {
      timerPrefilled.current = false;
      setFinishingTimerId(urlTimerId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlTimerId]);
  useEffect(() => {
    if (!finishingTimerId || !timerCtx?.loaded) return;
    if (!finishingTimer) {
      // Saved or discarded elsewhere (another tab, the header popover).
      setFinishingTimerId('');
      clearTimerParam();
      return;
    }
    if (timerPrefilled.current) return;
    timerPrefilled.current = true;
    if (finishingTimer.clientId) setClientId(finishingTimer.clientId);
    if (finishingTimer.engagementId) setEngagementId(finishingTimer.engagementId);
    if (finishingTimer.workCodeId) setWorkCodeId(finishingTimer.workCodeId);
    if (finishingTimer.description) setDescription(finishingTimer.description);
    setHours(elapsedToHours(timerCtx.elapsedSeconds(finishingTimer)).toFixed(2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishingTimerId, finishingTimer, timerCtx?.loaded]);

  // 0050 — inline edit state for "My entries". Click Edit on a row to
  // populate the draft; Save PATCHes the entry; Cancel discards.
  interface EditDraft {
    hours: string;
    description: string;
    billableFlag: boolean;
    outOfScopeOverride: boolean;
    workCodeId: string;
  }
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  // 0050 — broad server-side pre-filters for "My entries" (bound the loaded
  // set). Sort + free-text search run client-side via useColumnView, the
  // standard table view shared with Invoices / Engagements / etc.
  const [filterClientId, setFilterClientId] = useState('');
  const [filterEngagementId, setFilterEngagementId] = useState('');
  const [filterStart, setFilterStart] = useState('');
  const [filterEnd, setFilterEnd] = useState('');
  const [filterBillable, setFilterBillable] = useState<'' | 'true' | 'false'>('');
  const [filterOOS, setFilterOOS] = useState<'' | 'true' | 'false'>('');
  // Search + sort run SERVER-side now (entries accumulate past the old 500
  // cap); `.v2` drops stale pre-migration state.
  const view = useColumnView('vibe.time.view.v2', { sortCol: 'entryDate', sortDir: 'desc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [total, setTotal] = useState(0);
  const [sumHours, setSumHours] = useState(0);
  const [sumAmountCents, setSumAmountCents] = useState(0);

  function beginEdit(e: TimeEntry): void {
    setEditingId(e.id);
    setEditDraft({
      hours: String(e.hours),
      description: e.description ?? '',
      billableFlag: e.billableFlag,
      outOfScopeOverride: Boolean(e.outOfScopeOverride),
      workCodeId: e.workCodeId ?? '',
    });
    setError(null);
  }

  function cancelEdit(): void {
    setEditingId(null);
    setEditDraft(null);
  }

  async function saveEdit(): Promise<void> {
    if (!editingId || !editDraft) return;
    const hours = Number(editDraft.hours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
      setError('Hours must be a positive number ≤ 24.');
      return;
    }
    setSavingEdit(true);
    setError(null);
    try {
      await api(`/api/staff/time-entries/${editingId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          hours,
          description: editDraft.description,
          billableFlag: editDraft.billableFlag,
          outOfScopeOverride: editDraft.outOfScopeOverride,
          workCodeId: editDraft.workCodeId || null,
        }),
      });
      cancelEdit();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save_failed');
    } finally {
      setSavingEdit(false);
    }
  }

  // Engagements for the picked client, ACTIVE only. ACTIVE filter is
  // resilient: many existing engagements were created with status
  // PROPOSED or no status at all — fall back to "include unless
  // explicitly ARCHIVED or CLOSED" to avoid empty dropdowns.
  const filteredEngagements = useMemo(() => {
    if (!clientId) return [];
    return engagements.filter(
      (e) =>
        e.clientId === clientId &&
        e.status !== 'ARCHIVED' &&
        e.status !== 'CLOSED' &&
        e.status !== 'CANCELED',
    );
  }, [clientId, engagements]);

  // Auto-select the engagement when the picked client has exactly one
  // active engagement. If they have more, clear so the user picks.
  // 0050 — skip while the engagements list is still loading so a URL-
  // supplied engagementId (from the dashboard Time button) doesn't get
  // wiped on first render.
  useEffect(() => {
    if (engagements.length === 0) return;
    if (filteredEngagements.length === 1) {
      setEngagementId(filteredEngagements[0]!.id);
    } else if (engagementId && !filteredEngagements.some((e) => e.id === engagementId)) {
      // Current selection no longer belongs to this client.
      setEngagementId('');
    }
  }, [filteredEngagements, engagementId, engagements.length]);

  // Keep the status picker in sync with the selected engagement's current
  // progress status (so "save with no change" doesn't move it).
  const currentWorkflowState = engagements.find((e) => e.id === engagementId)?.workflowState ?? '';
  useEffect(() => {
    setWorkflowState(currentWorkflowState);
  }, [engagementId, currentWorkflowState]);

  // Load the selected engagement's open tasks so their status can be updated
  // while logging time. Cleared when no engagement is selected.
  useEffect(() => {
    if (!engagementId) {
      setEngagementTasks([]);
      return;
    }
    let alive = true;
    void api<{ items: EngagementTask[] }>(
      `/api/staff/tasks?engagementId=${engagementId}&scope=all&pageSize=100`,
    )
      .then((r) => {
        if (alive) setEngagementTasks(r.items ?? []);
      })
      .catch(() => {
        if (alive) setEngagementTasks([]);
      });
    return () => {
      alive = false;
    };
  }, [engagementId]);

  async function setTaskStatus(taskId: string, status: TaskStatus): Promise<void> {
    const prev = engagementTasks;
    setEngagementTasks((ts) => ts.map((t) => (t.id === taskId ? { ...t, status } : t)));
    try {
      await api(`/api/staff/tasks/${taskId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
    } catch {
      setEngagementTasks(prev); // revert on failure
    }
  }

  // Persist last-used client.
  useEffect(() => {
    if (clientId) {
      try {
        localStorage.setItem(LAST_CLIENT_KEY, clientId);
      } catch {
        // Storage might be disabled; non-fatal.
      }
    }
  }, [clientId]);

  // Broad pre-filters + the column view's search/sort, serialized once.
  const listParams = useMemo(() => {
    const params = new URLSearchParams();
    if (filterClientId) params.set('clientId', filterClientId);
    if (filterEngagementId) params.set('engagementId', filterEngagementId);
    if (filterStart) params.set('startDate', filterStart);
    if (filterEnd) params.set('endDate', filterEnd);
    if (filterBillable) params.set('billable', filterBillable);
    if (filterOOS) params.set('outOfScope', filterOOS);
    const vq = viewToPagedQuery(view);
    for (const [k, v] of Object.entries(vq)) if (v != null) params.set(k, v);
    return params;
  }, [filterClientId, filterEngagementId, filterStart, filterEnd, filterBillable, filterOOS, view]);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const params = new URLSearchParams(listParams);
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      const t = await api<{
        rows: TimeEntry[];
        total: number;
        sumHours: number;
        sumAmountCents: number;
      }>(`/api/staff/time-entries/list?${params.toString()}`);
      setEntries(t.rows ?? []);
      setTotal(t.total ?? 0);
      setSumHours(t.sumHours ?? 0);
      setSumAmountCents(t.sumAmountCents ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load_failed');
    } finally {
      setLoading(false);
    }
  }, [listParams, page, pageSize]);

  useEffect(() => {
    void load();
  }, [load]);

  // 0207 — refresh the entries table when a timer is quick-saved from the
  // header popover while this page is open.
  useEffect(() => {
    const onTimerSaved = (): void => void load();
    window.addEventListener('vibe:timer-saved', onTimerSaved);
    return () => window.removeEventListener('vibe:timer-saved', onTimerSaved);
  }, [load]);

  // Any filter/search/sort change snaps back to page 1.
  useEffect(() => {
    setPage(1);
  }, [listParams]);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!engagementId) {
      setError('Pick a client + engagement first.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const statusToSet =
        workflowState && workflowState !== currentWorkflowState ? workflowState : undefined;
      if (finishingTimerId && timerCtx) {
        // 0207 — convert the parked timer into this entry (same create
        // guards server-side; the timer row is deleted on success).
        await timerCtx.saveTimer(finishingTimerId, {
          engagementId,
          workCodeId: workCodeId || undefined,
          entryDate,
          hours: Number(hours),
          description: description || undefined,
          outOfScopeOverride: outOfScope || undefined,
          workflowState: statusToSet,
        });
        if (statusToSet) onEngagementStatusChanged(engagementId, statusToSet);
        setFinishingTimerId('');
        clearTimerParam();
      } else {
        const res = await api<{ workflowState?: string }>('/api/staff/time-entries', {
          method: 'POST',
          body: JSON.stringify({
            engagementId,
            workCodeId: workCodeId || undefined,
            entryDate,
            hours: Number(hours),
            description,
            outOfScopeOverride: outOfScope,
            linkedMessageIds: linkMessageId ? [linkMessageId] : undefined,
            workflowState: statusToSet,
            appointmentId: appointmentId || undefined,
          }),
        });
        if (statusToSet) {
          onEngagementStatusChanged(engagementId, res.workflowState ?? statusToSet);
        }
      }
      setHours('1.00');
      setDescription('');
      setOutOfScope(false);
      setLinkMessageId('');
      setAppointmentId('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setSubmitting(false);
    }
  }

  const pagination = useMemo(
    () => ({
      page,
      pageSize,
      total,
      onPageChange: setPage,
      onPageSizeChange: (s: number) => {
        setPageSize(s);
        setPage(1);
      },
    }),
    [page, pageSize, total],
  );
  // Totals span the whole filtered set (server aggregate), not just the page.
  const totalHours = sumHours;
  const totalAmount = sumAmountCents;

  const clientHasNoActive = clientId && filteredEngagements.length === 0;
  const activeClients = clients.filter((c) => c.status !== 'ARCHIVED');

  return (
    <>
      <Card title="Log time">
        <form
          onSubmit={submit}
          style={{
            display: 'grid',
            gridTemplateColumns: '2fr 2fr 1fr 1fr',
            gap: 12,
            alignItems: 'end',
          }}
        >
          <div>
            <div
              style={{
                fontSize: 12,
                color: tokens.color.textMuted,
                marginBottom: 4,
                display: 'flex',
                gap: 6,
                alignItems: 'center',
              }}
            >
              Client
              {clientId && (
                <button
                  type="button"
                  onClick={() => onTogglePin(clientId)}
                  aria-label={pinnedClientIds.has(clientId) ? 'Unpin client' : 'Pin client'}
                  title={
                    pinnedClientIds.has(clientId)
                      ? 'Unpin (remove from top of list)'
                      : 'Pin (sort to top of list)'
                  }
                  style={{
                    fontSize: 12,
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    color: pinnedClientIds.has(clientId)
                      ? tokens.color.accent
                      : tokens.color.textMuted,
                    padding: 0,
                  }}
                >
                  {pinnedClientIds.has(clientId) ? '★' : '☆'}
                </button>
              )}
            </div>
            <Combobox
              ariaLabel="Client"
              required
              value={clientId}
              onChange={(v) => {
                setClientId(v);
                setEngagementId('');
              }}
              options={activeClients.map<ComboboxOption>((c) => ({
                value: c.id,
                label: pinnedClientIds.has(c.id) ? `★ ${c.name}` : c.name,
              }))}
              placeholder="— select client —"
            />
          </div>
          <div>
            <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
              Engagement
              {filteredEngagements.length === 1 && clientId && (
                <span style={{ color: tokens.color.accent, marginLeft: 6 }}>(auto-selected)</span>
              )}
            </div>
            <Combobox
              ariaLabel="Engagement"
              required
              disabled={!clientId || filteredEngagements.length === 0}
              value={engagementId}
              onChange={setEngagementId}
              options={filteredEngagements.map<ComboboxOption>((e) => ({
                value: e.id,
                label: e.name,
              }))}
              placeholder={
                !clientId
                  ? '— pick client first —'
                  : filteredEngagements.length === 0
                    ? '— no active engagements —'
                    : '— select —'
              }
            />
          </div>
          <Input
            type="date"
            label="Date"
            // iPad Safari: date inputs have an intrinsic min-width that
            // overflows narrow grid columns unless appearance is reset.
            style={{ minWidth: 0, WebkitAppearance: 'none', appearance: 'none' }}
            value={entryDate}
            onChange={(e) => setEntryDate(e.target.value)}
          />
          <Input
            type="number"
            step={finishingTimerId ? 'any' : hoursStepMin(roundingHours).step}
            min={finishingTimerId ? 0.01 : hoursStepMin(roundingHours).min}
            max={24}
            label="Hours"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />
          <div style={{ gridColumn: 'span 3', display: 'grid', gap: 6 }}>
            <div>
              <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
                Work code
              </div>
              <Combobox
                ariaLabel="Work code"
                clearable
                value={workCodeId}
                onChange={setWorkCodeId}
                options={applicableWorkCodes.map<ComboboxOption>((w) => ({
                  value: w.id,
                  label: w.name,
                }))}
                placeholder="— none —"
              />
            </div>
            {engagementId && applicableStatusOptions.length > 0 && (
              <div>
                <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
                  Engagement status
                </div>
                <Combobox
                  ariaLabel="Engagement status"
                  value={workflowState}
                  onChange={setWorkflowState}
                  options={applicableStatusOptions.map<ComboboxOption>((s) => ({
                    value: s.workflowState,
                    label: s.label,
                  }))}
                  placeholder="— status —"
                />
              </div>
            )}
            {engagementId && engagementTasks.length > 0 && (
              <div>
                <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
                  Tasks on this engagement
                </div>
                <div
                  style={{
                    display: 'grid',
                    gap: 6,
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.md,
                    padding: '8px 10px',
                    background: tokens.color.surface,
                    maxHeight: 200,
                    overflowY: 'auto',
                  }}
                >
                  {engagementTasks.map((t) => (
                    <div
                      key={t.id}
                      style={{
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      }}
                    >
                      <span
                        style={{
                          fontSize: 13,
                          color: tokens.color.text,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          textDecoration:
                            t.status === 'DONE' || t.status === 'CANCELED'
                              ? 'line-through'
                              : 'none',
                          opacity: t.status === 'DONE' || t.status === 'CANCELED' ? 0.6 : 1,
                        }}
                        title={t.title}
                      >
                        {t.title}
                      </span>
                      <select
                        value={t.status}
                        onChange={(e) => void setTaskStatus(t.id, e.target.value as TaskStatus)}
                        aria-label={`Status for ${t.title}`}
                        style={{
                          flexShrink: 0,
                          padding: '3px 6px',
                          fontSize: 12,
                          borderRadius: tokens.radius.sm,
                          border: `1px solid ${tokens.color.border}`,
                          background: tokens.color.bg,
                          color: tokens.color.text,
                        }}
                      >
                        {TASK_STATUS_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <Input
              label="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What you worked on"
            />
            <AiDescribeButton
              engagementName={engagements.find((e) => e.id === engagementId)?.name}
              workCodeName={workCodes.find((w) => w.id === workCodeId)?.name}
              hours={hours ? parseFloat(hours) : undefined}
              onPick={(s) => setDescription(s)}
            />
            <label
              htmlFor="oos-override"
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                fontSize: 13,
                color: tokens.color.textMuted,
              }}
            >
              <input
                id="oos-override"
                type="checkbox"
                checked={outOfScope}
                aria-label="Out of scope"
                onChange={(e) => setOutOfScope(e.target.checked)}
              />
              <span>
                Out of scope <span style={{ fontSize: 11 }}>(flag this entry for review)</span>
              </span>
            </label>
          </div>
          <div style={{ gridColumn: 4, display: 'grid', gap: 8, alignContent: 'end' }}>
            <div
              style={{
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                padding: '8px 12px',
                background: tokens.color.surface,
              }}
              title="Open invoice balance for this client (SENT / partially paid / overdue)"
            >
              <div
                style={{
                  fontSize: 11,
                  color: tokens.color.textMuted,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}
              >
                Outstanding A/R
              </div>
              <strong
                style={{
                  fontSize: 18,
                  color:
                    outstandingCents && outstandingCents > 0
                      ? tokens.color.danger
                      : tokens.color.text,
                }}
              >
                {!clientId
                  ? '—'
                  : outstandingCents == null
                    ? '…'
                    : outstandingCents < 0
                      ? '—'
                      : `$${(outstandingCents / 100).toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                        })}`}
              </strong>
              {clientId && outstandingCents != null && outstandingCents > 0 && (
                <div
                  style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 2 }}
                  title="Balance-weighted average days past the due date across outstanding invoices"
                >
                  AVG Days: {avgDaysPastDue ?? '…'}
                </div>
              )}
            </div>
            <Button
              type="button"
              variant="secondary"
              disabled={!clientId || !engagementId}
              title={
                !clientId || !engagementId
                  ? 'Pick a client and engagement first'
                  : 'Print a Process Project sheet'
              }
              onClick={() => setProcessOpen(true)}
            >
              Process project
            </Button>
            {timerCtx?.canUse && !finishingTimerId && (
              <Button
                type="button"
                variant="secondary"
                disabled={submitting}
                title="Start a stopwatch with these details instead of logging manually"
                onClick={() => {
                  void timerCtx
                    .startTimer({
                      clientId: clientId || undefined,
                      engagementId: engagementId || undefined,
                      workCodeId: workCodeId || undefined,
                      description: description || undefined,
                    })
                    .then(() => setDescription(''))
                    .catch(() => setError('timer_start_failed'));
                }}
              >
                ▶ Start timer
              </Button>
            )}
            <Button type="submit" disabled={submitting || !engagementId}>
              {submitting ? 'Saving…' : finishingTimerId ? 'Save timer entry' : 'Log'}
            </Button>
          </div>
          {finishingTimer && (
            <div
              style={{
                gridColumn: '1 / -1',
                padding: '6px 10px',
                fontSize: 12,
                border: `1px solid ${tokens.color.accent}`,
                borderRadius: tokens.radius.sm,
              }}
            >
              ⏱ Finishing timer — {formatHuman(timerCtx?.elapsedSeconds(finishingTimer) ?? 0)}{' '}
              tracked{finishingTimer.status === 'RUNNING' ? ' (still running)' : ''}. Saving
              converts it into this time entry.
            </div>
          )}
          {linkMessageId && (
            <div
              style={{
                gridColumn: '1 / -1',
                padding: '6px 10px',
                fontSize: 12,
                background: 'rgba(67, 56, 202, 0.06)',
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm,
                color: tokens.color.text,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span>
                Will auto-link to message <code>{linkMessageId.slice(0, 8)}…</code> on save.
              </span>
              <button
                type="button"
                onClick={() => setLinkMessageId('')}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: tokens.color.accent,
                  cursor: 'pointer',
                  fontSize: 11,
                }}
              >
                Clear link
              </button>
            </div>
          )}
        </form>
        {processOpen && engagementId && (
          <ProcessProjectDialog
            engagementId={engagementId}
            clientName={clients.find((c) => c.id === clientId)?.name ?? ''}
            engagementName={engagements.find((e) => e.id === engagementId)?.name ?? ''}
            onClose={() => setProcessOpen(false)}
          />
        )}
        {clientHasNoActive && (
          <p
            style={{
              marginTop: 12,
              padding: 10,
              background: tokens.color.surface,
              border: `1px dashed ${tokens.color.border}`,
              borderRadius: tokens.radius.md,
              fontSize: 13,
              color: tokens.color.textMuted,
            }}
          >
            This client has no active engagements.{' '}
            <a
              href={`/engagements/new?clientId=${clientId}`}
              style={{ color: tokens.color.accent }}
            >
              Create one →
            </a>
          </p>
        )}
        {error && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{error}</p>}
      </Card>

      <Card
        title={
          <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span>My entries</span>
            {total > 0 && (
              <span style={{ fontSize: 13, color: tokens.color.textMuted, fontWeight: 400 }}>
                {view.anyFilterActive ? `${total} match${total === 1 ? '' : 'es'}` : `${total}`}
              </span>
            )}
          </span>
        }
        action={
          <span style={{ display: 'inline-flex', gap: 12, alignItems: 'center', fontSize: 12 }}>
            <span style={{ color: tokens.color.textMuted }}>
              {totalHours.toFixed(2)}h • ${(totalAmount / 100).toLocaleString()}
            </span>
            {view.anyFilterActive && (
              <button
                type="button"
                onClick={view.clearFilters}
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
          </span>
        }
      >
        {/* 0050 — filter row */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(6, 1fr)',
            gap: 8,
            marginBottom: 12,
          }}
        >
          <Combobox
            ariaLabel="Filter client"
            clearable
            value={filterClientId}
            onChange={(v) => {
              setFilterClientId(v);
              setFilterEngagementId('');
            }}
            options={clients.map((c) => ({ value: c.id, label: c.name }))}
            placeholder="Any client"
            size="sm"
          />
          <Combobox
            ariaLabel="Filter engagement"
            clearable
            value={filterEngagementId}
            onChange={(v) => {
              setFilterEngagementId(v);
            }}
            options={engagements
              .filter((e) => !filterClientId || e.clientId === filterClientId)
              .map((e) => ({ value: e.id, label: e.name }))}
            placeholder="Any engagement"
            size="sm"
          />
          <input
            type="date"
            aria-label="From date"
            value={filterStart}
            onChange={(e) => {
              setFilterStart(e.target.value);
            }}
            style={dateFilterStyle}
          />
          <input
            type="date"
            aria-label="To date"
            value={filterEnd}
            onChange={(e) => {
              setFilterEnd(e.target.value);
            }}
            style={dateFilterStyle}
          />
          <Combobox
            ariaLabel="Filter billable"
            clearable
            value={filterBillable}
            onChange={(v) => {
              setFilterBillable(v as '' | 'true' | 'false');
            }}
            options={[
              { value: 'true', label: 'Billable only' },
              { value: 'false', label: 'Non-billable only' },
            ]}
            placeholder="All"
            size="sm"
          />
          <Combobox
            ariaLabel="Filter OOS"
            clearable
            value={filterOOS}
            onChange={(v) => {
              setFilterOOS(v as '' | 'true' | 'false');
            }}
            options={[
              { value: 'true', label: 'OOS only' },
              { value: 'false', label: 'In-scope only' },
            ]}
            placeholder="All"
            size="sm"
          />
        </div>
        <div style={{ marginBottom: 12 }}>
          <TableSearch view={view} placeholder="Search description, client, engagement…" />
        </div>
        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <Table<TimeEntry>
            columns={[
              {
                key: 'date',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Date{' '}
                    <ColumnFilter
                      ariaLabel="Sort by date"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={view.sortFor('entryDate')}
                      onApply={(_, dir) => view.apply('entryDate', new Set(), dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (e) => e.entryDate,
              },
              {
                key: 'client',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Client{' '}
                    <ColumnFilter
                      ariaLabel="Sort by client"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={view.sortFor('client')}
                      onApply={(_, dir) => view.apply('client', new Set(), dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (e) =>
                  e.clientId && e.clientName ? (
                    <a href={`/clients/${e.clientId}`}>{e.clientName}</a>
                  ) : (
                    '—'
                  ),
              },
              {
                key: 'engagement',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Engagement{' '}
                    <ColumnFilter
                      ariaLabel="Sort by engagement"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={view.sortFor('engagement')}
                      onApply={(_, dir) => view.apply('engagement', new Set(), dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (e) =>
                  e.engagementName ? (
                    <a href={`/engagements/${e.engagementId}`}>{e.engagementName}</a>
                  ) : (
                    '—'
                  ),
              },
              {
                key: 'hours',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Hours{' '}
                    <ColumnFilter
                      ariaLabel="Sort by hours"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={view.sortFor('hours')}
                      onApply={(_, dir) => view.apply('hours', new Set(), dir)}
                    />
                  </span>
                ) as unknown as string,
                align: 'right',
                render: (e) => {
                  if (editingId === e.id && editDraft) {
                    return (
                      <input
                        type="number"
                        step={hoursStepMin(roundingHours).step}
                        min={hoursStepMin(roundingHours).min}
                        max={24}
                        value={editDraft.hours}
                        onChange={(ev) => setEditDraft({ ...editDraft, hours: ev.target.value })}
                        aria-label="Hours"
                        style={inlineInputStyle}
                      />
                    );
                  }
                  return Number(e.hours).toFixed(2);
                },
              },
              {
                key: 'amount',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Amount{' '}
                    <ColumnFilter
                      ariaLabel="Sort by amount"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={view.sortFor('amount')}
                      onApply={(_, dir) => view.apply('amount', new Set(), dir)}
                    />
                  </span>
                ) as unknown as string,
                align: 'right',
                render: (e) => `$${(e.standardAmountCents / 100).toLocaleString()}`,
              },
              {
                key: 'flags',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Flags{' '}
                    <ColumnFilter
                      ariaLabel="Sort by billable"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={view.sortFor('billable')}
                      onApply={(_, dir) => view.apply('billable', new Set(), dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (e) => {
                  if (editingId === e.id && editDraft) {
                    return (
                      <span style={{ display: 'flex', gap: 8, fontSize: 12, alignItems: 'center' }}>
                        <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                          <input
                            type="checkbox"
                            checked={editDraft.billableFlag}
                            onChange={(ev) =>
                              setEditDraft({ ...editDraft, billableFlag: ev.target.checked })
                            }
                          />
                          billable
                        </label>
                        <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                          <input
                            type="checkbox"
                            checked={editDraft.outOfScopeOverride}
                            onChange={(ev) =>
                              setEditDraft({
                                ...editDraft,
                                outOfScopeOverride: ev.target.checked,
                              })
                            }
                          />
                          OOS
                        </label>
                      </span>
                    );
                  }
                  return (
                    <span style={{ display: 'flex', gap: 4 }}>
                      {e.billableFlag ? (
                        <Pill tone="success">billable</Pill>
                      ) : (
                        <Pill tone="neutral">non-bill</Pill>
                      )}
                      {(!e.inScopeFlag || e.outOfScopeOverride) && <Pill tone="warning">OOS</Pill>}
                      {(e.lockedAt || e.billingBatchId) && <Pill tone="neutral">billed</Pill>}
                    </span>
                  );
                },
              },
              {
                key: 'desc',
                header: 'Description',
                render: (e) => {
                  if (editingId === e.id && editDraft) {
                    return (
                      <input
                        value={editDraft.description}
                        onChange={(ev) =>
                          setEditDraft({ ...editDraft, description: ev.target.value })
                        }
                        aria-label="Description"
                        style={{ ...inlineInputStyle, width: '100%' }}
                      />
                    );
                  }
                  return e.description;
                },
              },
              {
                key: 'actions',
                header: '',
                align: 'right',
                render: (e) => {
                  const editable = !e.lockedAt && !e.billingBatchId;
                  // 0207 — Toggl-style "continue": a NEW timer prefilled
                  // from this row (fresh entry on save; the original is
                  // untouched). Available on locked/billed rows too.
                  const continueBtn = timerCtx?.canUse ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      title="Start a timer from this entry"
                      onClick={() => {
                        void timerCtx
                          .startTimer({
                            clientId: e.clientId,
                            engagementId: e.engagementId,
                            workCodeId: e.workCodeId ?? undefined,
                            description: e.description || undefined,
                          })
                          .catch(() => setError('timer_start_failed'));
                      }}
                    >
                      ▶
                    </Button>
                  ) : null;
                  if (!editable) return continueBtn;
                  if (editingId === e.id) {
                    return (
                      <span style={{ display: 'inline-flex', gap: 4 }}>
                        <Button size="sm" disabled={savingEdit} onClick={() => void saveEdit()}>
                          {savingEdit ? 'Saving…' : 'Save'}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={cancelEdit}
                          disabled={savingEdit}
                        >
                          Cancel
                        </Button>
                      </span>
                    );
                  }
                  return (
                    <span style={{ display: 'inline-flex', gap: 4 }}>
                      {continueBtn}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => beginEdit(e)}
                        disabled={editingId !== null}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={editingId !== null}
                        onClick={() => {
                          if (!confirm('Delete this time entry?')) return;
                          void api(`/api/staff/time-entries/${e.id}`, { method: 'DELETE' })
                            .then(() => load())
                            .catch((err) =>
                              setError(err instanceof Error ? err.message : 'delete_failed'),
                            );
                        }}
                      >
                        Delete
                      </Button>
                    </span>
                  );
                },
              },
            ]}
            rows={entries}
            pagination={pagination}
            rowKey={(e) => e.id}
            empty="No time logged yet."
          />
        )}
      </Card>
    </>
  );
}

// ── Shared time-view building blocks ──────────────────────────────────
//
// Day + Week both render individual entries that the timekeeper can edit
// in place (hours / work code / description / billable / scope) or delete.
// The editor PATCHes/DELETEs `/api/staff/time-entries/:id` — the same
// mutable-field set the "My entries" inline editor uses — and calls
// `onChanged` so the parent view refetches. Locked/billed rows are
// read-only (the API rejects those edits anyway).

function isEntryLocked(e: TimeEntry): boolean {
  return Boolean(e.lockedAt) || Boolean(e.billingBatchId);
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// Small labelled metric tiles shown above the Day/Week detail. Gives the
// billable/non-billable split the numeric prominence competing timesheets
// (Harvest, Toggl) put front-and-center.
function SummaryTiles({
  items,
}: {
  items: { label: string; value: string; tone?: 'success' | 'warning' | 'danger' }[];
}): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: tokens.space.sm,
        marginBottom: tokens.space.md,
      }}
    >
      {items.map((it) => (
        <div
          key={it.label}
          style={{
            flex: '1 1 110px',
            minWidth: 100,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
            padding: '8px 12px',
            background: tokens.color.bg,
          }}
        >
          <div
            style={{
              fontSize: 11,
              color: tokens.color.textMuted,
              textTransform: 'uppercase',
              letterSpacing: 0.4,
            }}
          >
            {it.label}
          </div>
          <div
            style={{
              fontSize: 18,
              fontWeight: 700,
              fontVariantNumeric: 'tabular-nums',
              color:
                it.tone === 'success'
                  ? tokens.color.success
                  : it.tone === 'warning'
                    ? tokens.color.warning
                    : it.tone === 'danger'
                      ? tokens.color.danger
                      : tokens.color.text,
            }}
          >
            {it.value}
          </div>
        </div>
      ))}
    </div>
  );
}

const entryRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '7px 2px',
  fontSize: 13,
  borderTop: `1px solid ${tokens.color.border}`,
};

const checkboxLabelStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 12,
  color: tokens.color.textMuted,
  whiteSpace: 'nowrap',
  cursor: 'pointer',
};

interface RowEditDraft {
  hours: string;
  description: string;
  billableFlag: boolean;
  outOfScopeOverride: boolean;
  workCodeId: string;
}

// 0207 follow-up — ▶ start-timer button for the Day/Week views. Same
// "continue" semantics as the Quick log rows: starts a NEW prefilled timer;
// nothing on the source entry changes. Owns its failure state so callers
// need no error plumbing. Renders nothing without time_entry:create.
function StartTimerButton({
  prefill,
  label,
}: {
  prefill: TimerStartPrefill;
  label: string;
}): JSX.Element | null {
  const timers = useTimersOptional();
  const [failed, setFailed] = useState(false);
  if (!timers?.canUse) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      title={failed ? 'Could not start timer — try again' : label}
      style={failed ? { color: tokens.color.danger } : undefined}
      onClick={() => {
        setFailed(false);
        void timers.startTimer(prefill).catch(() => setFailed(true));
      }}
    >
      ▶
    </Button>
  );
}

function EditableEntryRow({
  entry,
  workCodes,
  roundingHours,
  onChanged,
}: {
  entry: TimeEntry;
  workCodes: WorkCode[];
  roundingHours: string;
  onChanged: () => void | Promise<void>;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<RowEditDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const locked = isEntryLocked(entry);
  const { step, min } = hoursStepMin(roundingHours);
  const wcName = workCodes.find((w) => w.id === entry.workCodeId)?.name;
  const wcOptions: ComboboxOption[] = useMemo(
    () => workCodes.map((w) => ({ value: w.id, label: w.name })),
    [workCodes],
  );

  function begin(): void {
    setDraft({
      hours: String(entry.hours),
      description: entry.description ?? '',
      billableFlag: entry.billableFlag,
      outOfScopeOverride: Boolean(entry.outOfScopeOverride),
      workCodeId: entry.workCodeId ?? '',
    });
    setError(null);
    setEditing(true);
  }

  function cancel(): void {
    setEditing(false);
    setDraft(null);
    setError(null);
  }

  async function save(): Promise<void> {
    if (!draft) return;
    const hours = Number(draft.hours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
      setError('Hours must be a positive number ≤ 24.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api(`/api/staff/time-entries/${entry.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          hours,
          description: draft.description,
          billableFlag: draft.billableFlag,
          outOfScopeOverride: draft.outOfScopeOverride,
          workCodeId: draft.workCodeId || null,
        }),
      });
      setEditing(false);
      setDraft(null);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save_failed');
    } finally {
      setSaving(false);
    }
  }

  async function remove(): Promise<void> {
    if (!window.confirm('Delete this time entry? It will be archived.')) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/time-entries/${entry.id}`, { method: 'DELETE' });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'delete_failed');
      setBusy(false);
    }
  }

  if (editing && draft) {
    return (
      <div style={{ ...entryRowStyle, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <input
          type="number"
          value={draft.hours}
          step={step}
          min={min}
          max={24}
          onChange={(e) => setDraft({ ...draft, hours: e.target.value })}
          style={{ ...inlineInputStyle, width: 72 }}
          aria-label="Hours"
        />
        {workCodes.length > 0 && (
          <Combobox
            size="sm"
            width={160}
            clearable
            options={wcOptions}
            value={draft.workCodeId}
            onChange={(v) => setDraft({ ...draft, workCodeId: v })}
            placeholder="Work code"
          />
        )}
        <input
          type="text"
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          placeholder="Description"
          style={{ ...inlineInputStyle, width: 'auto', flex: 1, minWidth: 160 }}
          aria-label="Description"
        />
        <label style={checkboxLabelStyle}>
          <input
            type="checkbox"
            checked={draft.billableFlag}
            onChange={(e) => setDraft({ ...draft, billableFlag: e.target.checked })}
          />
          Billable
        </label>
        <label style={checkboxLabelStyle}>
          <input
            type="checkbox"
            checked={draft.outOfScopeOverride}
            onChange={(e) => setDraft({ ...draft, outOfScopeOverride: e.target.checked })}
          />
          Out of scope
        </label>
        <span style={{ display: 'flex', gap: 4 }}>
          <Button size="sm" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button size="sm" variant="secondary" disabled={saving} onClick={cancel}>
            Cancel
          </Button>
        </span>
        {error && (
          <div style={{ width: '100%', color: tokens.color.danger, fontSize: 12 }}>{error}</div>
        )}
      </div>
    );
  }

  return (
    <div style={entryRowStyle}>
      <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums', minWidth: 52 }}>
        {Number(entry.hours).toFixed(2)}h
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ color: entry.description ? tokens.color.text : tokens.color.textMuted }}>
          {entry.description || <em>(no description)</em>}
        </span>
        {wcName && <span style={{ color: tokens.color.textMuted }}> · {wcName}</span>}
      </span>
      <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {entry.billableFlag && entry.standardAmountCents > 0 && (
          <span
            style={{
              color: tokens.color.textMuted,
              fontVariantNumeric: 'tabular-nums',
              fontSize: 12,
            }}
          >
            {money(entry.standardAmountCents)}
          </span>
        )}
        {entry.billableFlag ? (
          <Pill tone="success">billable</Pill>
        ) : (
          <Pill tone="neutral">non-bill</Pill>
        )}
        {!entry.inScopeFlag && <Pill tone="warning">OOS</Pill>}
        {locked ? (
          <span style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
            <StartTimerButton
              prefill={{
                clientId: entry.clientId,
                engagementId: entry.engagementId,
                workCodeId: entry.workCodeId ?? undefined,
                description: entry.description || undefined,
              }}
              label="Start a timer from this entry"
            />
            <Pill tone="neutral">{entry.billingBatchId ? 'billed' : 'locked'}</Pill>
          </span>
        ) : (
          <span style={{ display: 'flex', gap: 2 }}>
            <StartTimerButton
              prefill={{
                clientId: entry.clientId,
                engagementId: entry.engagementId,
                workCodeId: entry.workCodeId ?? undefined,
                description: entry.description || undefined,
              }}
              label="Start a timer from this entry"
            />
            <Button size="sm" variant="ghost" onClick={begin} disabled={busy}>
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void remove()}
              disabled={busy}
              style={{ color: tokens.color.danger }}
            >
              {busy ? '…' : 'Delete'}
            </Button>
          </span>
        )}
      </span>
      {error && (
        <span style={{ color: tokens.color.danger, fontSize: 12, width: '100%' }}>{error}</span>
      )}
    </div>
  );
}

function DayView({
  engagements,
  clients,
  workCodes,
  roundingHours,
}: {
  engagements: Engagement[];
  clients: Client[];
  workCodes: WorkCode[];
  roundingHours: string;
}): JSX.Element {
  const [date, setDate] = useState(today());
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api<{ items: TimeEntry[] }>(`/api/staff/time-entries/mine?start=${date}&end=${date}`)
      .then((r) => {
        if (cancelled) return;
        setEntries(r.items ?? []);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [date]);

  const reload = useCallback(async () => {
    const r = await api<{ items: TimeEntry[] }>(
      `/api/staff/time-entries/mine?start=${date}&end=${date}`,
    );
    setEntries(r.items ?? []);
  }, [date]);

  const total = entries.reduce((s, e) => s + Number(e.hours), 0);
  const billable = entries.filter((e) => e.billableFlag).reduce((s, e) => s + Number(e.hours), 0);
  const nonBillable = total - billable;
  const billablePct = total > 0 ? Math.round((billable / total) * 100) : 0;
  const isToday = date === today();

  const byEngagement = useMemo(() => {
    const m = new Map<string, TimeEntry[]>();
    for (const e of entries) {
      const arr = m.get(e.engagementId) ?? [];
      arr.push(e);
      m.set(e.engagementId, arr);
    }
    return Array.from(m.entries())
      .map(([id, items]) => {
        const eng = engagements.find((e) => e.id === id);
        const cli = clients.find((c) => c.id === eng?.clientId);
        return {
          engagementId: id,
          engagementName: eng?.name ?? id.slice(0, 8),
          clientId: eng?.clientId,
          clientName: cli?.name ?? null,
          items,
          hours: items.reduce((s, e) => s + Number(e.hours), 0),
        };
      })
      .sort((a, b) => {
        const ca = (a.clientName ?? '').toLowerCase();
        const cb = (b.clientName ?? '').toLowerCase();
        if (ca !== cb) return ca.localeCompare(cb);
        return b.hours - a.hours;
      });
  }, [entries, engagements, clients]);

  return (
    <Card
      title="Day"
      action={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setDate(addDays(date, -1))}
            aria-label="Previous day"
          >
            ‹
          </Button>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            style={inputStyle}
            aria-label="Date"
          />
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setDate(addDays(date, 1))}
            aria-label="Next day"
          >
            ›
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setDate(today())} disabled={isToday}>
            Today
          </Button>
        </div>
      }
    >
      <SummaryTiles
        items={[
          {
            label: 'Total',
            value: `${total.toFixed(2)}h`,
            tone: total >= 7 ? 'success' : total >= 4 ? 'warning' : 'danger',
          },
          { label: 'Billable', value: `${billable.toFixed(2)}h` },
          { label: 'Non-billable', value: `${nonBillable.toFixed(2)}h` },
          { label: 'Billable %', value: `${billablePct}%` },
        ]}
      />
      {loading ? (
        <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
      ) : byEngagement.length === 0 ? (
        <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>
          No time logged on {shortDate(date)}. Use <strong>Quick log</strong> to add an entry.
        </p>
      ) : (
        <div style={{ display: 'grid', gap: tokens.space.md }}>
          {byEngagement.map((g) => (
            <div
              key={g.engagementId}
              style={{
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                padding: '10px 12px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  gap: 8,
                }}
              >
                <span>
                  {g.clientName && (
                    <span style={{ color: tokens.color.accent, fontSize: 14, fontWeight: 600 }}>
                      {g.clientName}
                      <span style={{ color: tokens.color.textMuted, margin: '0 6px' }}>·</span>
                    </span>
                  )}
                  <strong style={{ fontSize: 14 }}>{g.engagementName}</strong>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <StartTimerButton
                    prefill={{ clientId: g.clientId, engagementId: g.engagementId }}
                    label={`Start a timer on ${g.engagementName}`}
                  />
                  <span
                    style={{
                      fontSize: 13,
                      color: tokens.color.textMuted,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {g.hours.toFixed(2)}h
                  </span>
                </span>
              </div>
              {g.items.map((e) => (
                <EditableEntryRow
                  key={e.id}
                  entry={e}
                  workCodes={workCodes}
                  roundingHours={roundingHours}
                  onChanged={reload}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function WeekView({
  engagements,
  clients,
  workCodes,
  roundingHours,
}: {
  engagements: Engagement[];
  clients: Client[];
  workCodes: WorkCode[];
  roundingHours: string;
}): JSX.Element {
  const [weekAnchor, setWeekAnchor] = useState(startOfWeek(today()));
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  // Clicking a populated grid cell opens that engagement×day's entries for
  // inline editing below the grid — the grid stays a clean at-a-glance
  // rollup while edits happen at the true (per-entry) grain.
  const [selected, setSelected] = useState<{ engagementId: string; date: string } | null>(null);

  const weekEnd = useMemo(() => addDays(weekAnchor, 6), [weekAnchor]);
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekAnchor, i)),
    [weekAnchor],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSelected(null);
    void api<{ items: TimeEntry[] }>(
      `/api/staff/time-entries/mine?start=${weekAnchor}&end=${weekEnd}`,
    )
      .then((r) => {
        if (cancelled) return;
        setEntries(r.items ?? []);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [weekAnchor, weekEnd]);

  const reload = useCallback(async () => {
    const r = await api<{ items: TimeEntry[] }>(
      `/api/staff/time-entries/mine?start=${weekAnchor}&end=${weekEnd}`,
    );
    setEntries(r.items ?? []);
  }, [weekAnchor, weekEnd]);

  // Build grid: rows = engagementId, columns = day → hours sum
  const grid = useMemo(() => {
    const byEng = new Map<string, Map<string, number>>();
    for (const e of entries) {
      const row = byEng.get(e.engagementId) ?? new Map<string, number>();
      row.set(e.entryDate, (row.get(e.entryDate) ?? 0) + Number(e.hours));
      byEng.set(e.engagementId, row);
    }
    const rows = Array.from(byEng.entries()).map(([id, dayMap]) => {
      const eng = engagements.find((e) => e.id === id);
      const cli = clients.find((c) => c.id === eng?.clientId);
      return {
        engagementId: id,
        engagementName: eng?.name ?? id.slice(0, 8),
        clientId: eng?.clientId,
        clientName: cli?.name ?? null,
        cells: days.map((d) => dayMap.get(d) ?? 0),
        total: Array.from(dayMap.values()).reduce((s, v) => s + v, 0),
      };
    });
    // Sort by client name (alphabetical) so each client's engagements
    // cluster — easier scan than pure hours-desc.
    rows.sort((a, b) => {
      const ca = (a.clientName ?? '').toLowerCase();
      const cb = (b.clientName ?? '').toLowerCase();
      if (ca !== cb) return ca.localeCompare(cb);
      return b.total - a.total;
    });
    return rows;
  }, [entries, days, engagements, clients]);

  const dailyTotals = useMemo(
    () =>
      days.map((d) =>
        entries.filter((e) => e.entryDate === d).reduce((s, e) => s + Number(e.hours), 0),
      ),
    [entries, days],
  );
  const weekTotal = dailyTotals.reduce((s, v) => s + v, 0);
  const billableTotal = entries
    .filter((e) => e.billableFlag)
    .reduce((s, e) => s + Number(e.hours), 0);
  const daysLogged = dailyTotals.filter((h) => h > 0).length;
  const avgPerLoggedDay = daysLogged > 0 ? weekTotal / daysLogged : 0;

  // Entries backing the currently-selected cell (engagement × day).
  const selectedEntries = useMemo(
    () =>
      selected
        ? entries.filter(
            (e) => e.engagementId === selected.engagementId && e.entryDate === selected.date,
          )
        : [],
    [selected, entries],
  );
  const selectedEng = selected
    ? engagements.find((e) => e.id === selected.engagementId)
    : undefined;
  const selectedClient = selectedEng
    ? clients.find((c) => c.id === selectedEng.clientId)
    : undefined;

  return (
    <Card
      title="Week"
      action={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setWeekAnchor(addDays(weekAnchor, -7))}
            aria-label="Previous week"
          >
            ‹ Prev
          </Button>
          <span style={{ fontSize: 13, color: tokens.color.textMuted }}>
            {shortDate(weekAnchor)} – {shortDate(weekEnd)}
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setWeekAnchor(addDays(weekAnchor, 7))}
            aria-label="Next week"
          >
            Next ›
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setWeekAnchor(startOfWeek(today()))}>
            This week
          </Button>
        </div>
      }
    >
      <SummaryTiles
        items={[
          {
            label: 'Week total',
            value: `${weekTotal.toFixed(2)}h`,
            tone: weekTotal >= 35 ? 'success' : weekTotal >= 20 ? 'warning' : 'danger',
          },
          { label: 'Billable', value: `${billableTotal.toFixed(2)}h` },
          { label: 'Days logged', value: `${daysLogged}/7` },
          { label: 'Avg / day', value: `${avgPerLoggedDay.toFixed(2)}h` },
        ]}
      />
      {loading ? (
        <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
      ) : (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 13,
                minWidth: 700,
              }}
            >
              <thead>
                <tr>
                  <th style={th('left')}>Engagement</th>
                  {days.map((d) => (
                    <th key={d} style={th('right')}>
                      <div style={{ fontWeight: 600 }}>{dayLabel(d)}</div>
                      <div style={{ fontSize: 11, color: tokens.color.textMuted, fontWeight: 400 }}>
                        {shortDate(d)}
                      </div>
                    </th>
                  ))}
                  <th style={th('right')}>Total</th>
                </tr>
              </thead>
              <tbody>
                {grid.length === 0 ? (
                  <tr>
                    <td
                      colSpan={9}
                      style={{ padding: 16, textAlign: 'center', color: tokens.color.textMuted }}
                    >
                      No time logged this week.
                    </td>
                  </tr>
                ) : (
                  grid.map((r) => (
                    <tr key={r.engagementId}>
                      <td style={td('left')}>
                        <span
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            justifyContent: 'space-between',
                          }}
                        >
                          <span>
                            {r.clientName && (
                              <span style={{ color: tokens.color.accent, fontWeight: 600 }}>
                                {r.clientName}
                                <span style={{ color: tokens.color.textMuted, margin: '0 6px' }}>
                                  ·
                                </span>
                              </span>
                            )}
                            {r.engagementName}
                          </span>
                          <StartTimerButton
                            prefill={{ clientId: r.clientId, engagementId: r.engagementId }}
                            label={`Start a timer on ${r.engagementName}`}
                          />
                        </span>
                      </td>
                      {r.cells.map((h, i) => {
                        // reason: r.cells is days.map(...), so index i is always in-bounds.
                        const cellDate = days[i] as string;
                        const isSel =
                          selected?.engagementId === r.engagementId && selected?.date === cellDate;
                        return (
                          <td key={i} style={{ ...td('right', h > 0), padding: 0 }}>
                            {h > 0 ? (
                              <button
                                type="button"
                                onClick={() =>
                                  setSelected(
                                    isSel ? null : { engagementId: r.engagementId, date: cellDate },
                                  )
                                }
                                aria-label={`Edit ${r.engagementName} on ${shortDate(cellDate)}, ${h.toFixed(2)} hours`}
                                aria-pressed={isSel}
                                style={{
                                  width: '100%',
                                  border: 'none',
                                  cursor: 'pointer',
                                  background: isSel ? tokens.color.accentMuted : 'transparent',
                                  color: tokens.color.text,
                                  font: 'inherit',
                                  fontWeight: isSel ? 700 : 500,
                                  fontVariantNumeric: 'tabular-nums',
                                  padding: '6px 8px',
                                  textAlign: 'right',
                                }}
                              >
                                {h.toFixed(2)}
                              </button>
                            ) : (
                              <span
                                style={{
                                  display: 'block',
                                  padding: '6px 8px',
                                  color: tokens.color.textMuted,
                                }}
                              >
                                –
                              </span>
                            )}
                          </td>
                        );
                      })}
                      <td style={{ ...td('right'), fontWeight: 600 }}>{r.total.toFixed(2)}</td>
                    </tr>
                  ))
                )}
                <tr style={{ background: tokens.color.surface, fontWeight: 600 }}>
                  <td style={td('left')}>Daily total</td>
                  {dailyTotals.map((h, i) => (
                    <td
                      key={i}
                      style={{
                        ...td('right'),
                        color:
                          h >= 7
                            ? tokens.color.success
                            : h >= 4
                              ? tokens.color.warning
                              : tokens.color.textMuted,
                      }}
                    >
                      {h > 0 ? h.toFixed(2) : '–'}
                    </td>
                  ))}
                  <td style={td('right')}>{weekTotal.toFixed(2)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {grid.length > 0 && !selected && (
            <p style={{ marginTop: tokens.space.sm, fontSize: 12, color: tokens.color.textMuted }}>
              Tip: click any cell with hours to edit that day&rsquo;s entries.
            </p>
          )}
          {selected && (
            <div
              style={{
                marginTop: tokens.space.lg,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                padding: '10px 12px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  gap: 8,
                }}
              >
                <span>
                  {selectedClient && (
                    <span style={{ color: tokens.color.accent, fontSize: 14, fontWeight: 600 }}>
                      {selectedClient.name}
                      <span style={{ color: tokens.color.textMuted, margin: '0 6px' }}>·</span>
                    </span>
                  )}
                  <strong style={{ fontSize: 14 }}>
                    {selectedEng?.name ?? selected.engagementId.slice(0, 8)}
                  </strong>
                  <span style={{ color: tokens.color.textMuted, marginLeft: 6, fontSize: 13 }}>
                    — {dayLabel(selected.date)} {shortDate(selected.date)}
                  </span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
                  Close
                </Button>
              </div>
              {selectedEntries.length === 0 ? (
                <p style={{ color: tokens.color.textMuted, fontSize: 13, marginBottom: 0 }}>
                  No entries remain for this day.
                </p>
              ) : (
                selectedEntries.map((e) => (
                  <EditableEntryRow
                    key={e.id}
                    entry={e}
                    workCodes={workCodes}
                    roundingHours={roundingHours}
                    onChanged={reload}
                  />
                ))
              )}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function MonthView(): JSX.Element {
  const [monthsBack, setMonthsBack] = useState(6);
  const [days, setDays] = useState<DayTotal[]>([]);
  const [months, setMonths] = useState<MonthTotal[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([
      api<{ items: MonthTotal[] }>(
        `/api/staff/time-entries/totals/by-month?monthsBack=${monthsBack}`,
      ),
      // pull last ~62 days of day totals for the heatmap
      (async () => {
        const end = today();
        const start = addDays(end, -62);
        return api<{ items: DayTotal[] }>(
          `/api/staff/time-entries/totals/by-day?start=${start}&end=${end}`,
        );
      })(),
    ]).then(([m, d]) => {
      if (cancelled) return;
      setMonths(m.items ?? []);
      setDays(d.items ?? []);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [monthsBack]);

  const dayMap = useMemo(() => new Map(days.map((d) => [d.entryDate, d])), [days]);
  const heatmapDays = useMemo(() => {
    const end = today();
    return Array.from({ length: 62 }, (_, i) => addDays(end, -(61 - i)));
  }, []);

  function heatColor(hours: number): string {
    if (hours <= 0) return tokens.color.surface;
    if (hours < 4) return 'rgba(245, 158, 11, 0.3)'; // warning low
    if (hours < 7) return 'rgba(245, 158, 11, 0.7)'; // warning mid
    if (hours < 9) return 'rgba(34, 197, 94, 0.7)'; // success
    return 'rgba(34, 197, 94, 1)'; // success high
  }

  return (
    <>
      <Card
        title="Recent activity (62-day heatmap)"
        action={
          <Pill tone="neutral">
            {days.reduce((s, d) => s + d.hours, 0).toFixed(2)}h over {days.length} active days
          </Pill>
        }
      >
        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(31, 1fr)',
              gap: 2,
            }}
          >
            {heatmapDays.map((d) => {
              const h = dayMap.get(d)?.hours ?? 0;
              return (
                <div
                  key={d}
                  title={`${d}: ${h.toFixed(2)}h`}
                  style={{
                    aspectRatio: '1 / 1',
                    background: heatColor(h),
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: 2,
                  }}
                />
              );
            })}
          </div>
        )}
      </Card>

      <Card
        title="Month rollup"
        action={
          <select
            value={monthsBack}
            onChange={(e) => setMonthsBack(Number(e.target.value))}
            style={inputStyle}
            aria-label="Months back"
          >
            <option value={3}>Last 3 months</option>
            <option value={6}>Last 6 months</option>
            <option value={12}>Last 12 months</option>
            <option value={24}>Last 24 months</option>
          </select>
        }
      >
        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : months.length === 0 ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>No time in this window.</p>
        ) : (
          <Table<MonthTotal>
            columns={[
              { key: 'month', header: 'Month', render: (m) => m.month },
              {
                key: 'hours',
                header: 'Hours',
                align: 'right',
                render: (m) => m.hours.toFixed(2),
              },
              {
                key: 'amount',
                header: 'Standard $',
                align: 'right',
                render: (m) => `$${(m.amountCents / 100).toLocaleString()}`,
              },
              {
                key: 'count',
                header: 'Entries',
                align: 'right',
                render: (m) => m.count.toString(),
              },
            ]}
            rows={months}
            rowKey={(m) => m.month}
            empty="No months in window."
          />
        )}
      </Card>
    </>
  );
}

const inputStyle = {
  padding: '6px 10px',
  background: tokens.color.surface,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  fontSize: 13,
} as const;

function th(align: 'left' | 'right'): React.CSSProperties {
  return {
    textAlign: align,
    padding: '8px',
    borderBottom: `1px solid ${tokens.color.border}`,
    fontSize: 12,
    fontWeight: 600,
    color: tokens.color.textMuted,
  };
}

function td(align: 'left' | 'right', emphasized = false): React.CSSProperties {
  return {
    textAlign: align,
    padding: '6px 8px',
    borderBottom: `1px solid ${tokens.color.border}`,
    color: emphasized ? tokens.color.text : tokens.color.textMuted,
    fontWeight: emphasized ? 500 : 400,
  };
}

function AiDescribeButton({
  engagementName,
  workCodeName,
  hours,
  onPick,
}: {
  engagementName: string | undefined;
  workCodeName: string | undefined;
  hours: number | undefined;
  onPick: (s: string) => void;
}): JSX.Element | null {
  const aiStatus = useAiStatus();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [last, setLast] = useState<string | null>(null);

  async function suggest(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ suggestion: string }>('/api/staff/ai/suggest-description', {
        method: 'POST',
        body: JSON.stringify({ engagementName, workCodeName, hours }),
      });
      if (r.suggestion) {
        setLast(r.suggestion);
        onPick(r.suggestion);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  if (!aiUsable(aiStatus)) return null;
  return (
    <AiPanel
      title="Describe this entry"
      providerId={aiStatus?.providerId ?? undefined}
      busy={busy}
      error={err}
      action={
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void suggest()}
          disabled={busy || !engagementName}
        >
          {last ? 'Regenerate' : 'Suggest'}
        </Button>
      }
    >
      {last ? (
        <p style={{ margin: 0, fontSize: 12 }}>{last}</p>
      ) : (
        <p style={{ margin: 0, fontSize: 11, color: tokens.color.textMuted }}>
          Pick an engagement + work code, then ask the model for a description suggestion based on
          recent entries.
        </p>
      )}
    </AiPanel>
  );
}
