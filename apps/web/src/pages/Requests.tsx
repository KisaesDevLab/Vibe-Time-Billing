// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Staff Requests page — 0084 overhaul. Filterable, sortable,
// paginated list backed by /api/staff/requests, with a much richer
// create form that supports templates, priority, tags, reminder
// days, multi-item checklists, and a bulk-send mode that posts to
// /api/staff/requests/bulk.
//
// Row click navigates to /requests/:id (RequestDetail page).

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button, Card, Combobox, Pill, Table, tokens, type ComboboxOption } from '@vibe/ui';

import { api } from '../api-client';

type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
type ItemKind = 'QUESTION' | 'DOCUMENT' | 'SIGNATURE';

interface LinkedTimeEntry {
  id: string;
  hours: string;
  entryDate: string;
  staffName: string | null;
}

interface RequestRow {
  id: string;
  firmId: string;
  engagementId: string;
  assignedAppUserId: string | null;
  title: string;
  body: string;
  status: string;
  priority: Priority;
  tags: string[];
  dueDate: string | null;
  fulfilledAt: string | null;
  createdAt: string;
  linkedTimeEntry: LinkedTimeEntry | null;
}

interface ClientLite {
  id: string;
  name: string;
}

interface EngagementLite {
  id: string;
  name: string;
  clientId: string;
}

interface FirmUser {
  id: string;
  fullName: string;
}

interface RequestTemplate {
  id: string;
  key: string;
  name: string;
  titlePattern: string;
  bodyPattern: string;
  defaultPriority: Priority;
  defaultDueOffsetDays: number | null;
  defaultReminderDaysBefore: number | null;
  defaultAssignedAppUserId: string | null;
  status: string;
  items: Array<{
    id: string;
    ordinal: number;
    label: string;
    body: string;
    itemKind: ItemKind;
    required: boolean;
    defaultDueOffsetDays: number | null;
  }>;
}

const STATUS_OPTIONS = [
  'ALL',
  'OPEN',
  'NEEDS_INFO',
  'PENDING',
  'FULFILLED',
  'DISMISSED',
  'EXPIRED',
] as const;
type StatusFilter = (typeof STATUS_OPTIONS)[number];

const PRIORITIES: Priority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
const SORT_OPTIONS = [
  { value: 'created_at', label: 'Created' },
  { value: 'due_date', label: 'Due date' },
  { value: 'priority', label: 'Priority' },
  { value: 'status', label: 'Status' },
  { value: 'title', label: 'Title' },
];

function statusTone(status: string): 'success' | 'warning' | 'neutral' | 'danger' | 'accent' {
  switch (status) {
    case 'OPEN':
      return 'warning';
    case 'FULFILLED':
      return 'success';
    case 'NEEDS_INFO':
      return 'accent';
    case 'PENDING':
      return 'neutral';
    case 'DISMISSED':
    case 'EXPIRED':
      return 'neutral';
    default:
      return 'neutral';
  }
}

function priorityTone(p: Priority): 'neutral' | 'warning' | 'danger' | 'accent' {
  switch (p) {
    case 'URGENT':
      return 'danger';
    case 'HIGH':
      return 'warning';
    case 'MEDIUM':
      return 'accent';
    case 'LOW':
    default:
      return 'neutral';
  }
}

interface NewItemDraft {
  ordinal: number;
  label: string;
  body: string;
  itemKind: ItemKind;
  required: boolean;
}

function emptyItem(ord: number): NewItemDraft {
  return { ordinal: ord, label: '', body: '', itemKind: 'QUESTION', required: true };
}

// Session-persisted filter/sort state — survives refresh + navigation,
// matching the other table views.
const VIEW_KEY = 'vibe.requests.view';

interface PersistedRequestsView {
  status: StatusFilter;
  priority: Priority | '';
  assigned: string;
  client: string;
  search: string;
  tag: string;
  dueAfter: string;
  dueBefore: string;
  sort: string;
  dir: 'asc' | 'desc';
}

const DEFAULT_REQUESTS_VIEW: PersistedRequestsView = {
  status: 'OPEN',
  priority: '',
  assigned: '',
  client: '',
  search: '',
  tag: '',
  dueAfter: '',
  dueBefore: '',
  sort: 'created_at',
  dir: 'desc',
};

function loadRequestsView(): PersistedRequestsView {
  try {
    const raw = sessionStorage.getItem(VIEW_KEY);
    if (!raw) return DEFAULT_REQUESTS_VIEW;
    return { ...DEFAULT_REQUESTS_VIEW, ...(JSON.parse(raw) as Partial<PersistedRequestsView>) };
  } catch {
    return DEFAULT_REQUESTS_VIEW;
  }
}

export function RequestsPage(): JSX.Element {
  const navigate = useNavigate();
  const [items, setItems] = useState<RequestRow[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Filter / sort / pagination state (hydrated from sessionStorage).
  const initialView = useMemo(() => loadRequestsView(), []);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(initialView.status);
  const [priorityFilter, setPriorityFilter] = useState<Priority | ''>(initialView.priority);
  const [assignedFilter, setAssignedFilter] = useState<string>(initialView.assigned);
  const [clientFilter, setClientFilter] = useState<string>(initialView.client);
  const [search, setSearch] = useState(initialView.search);
  const [tagFilter, setTagFilter] = useState(initialView.tag);
  const [dueAfter, setDueAfter] = useState(initialView.dueAfter);
  const [dueBefore, setDueBefore] = useState(initialView.dueBefore);
  const [sort, setSort] = useState<string>(initialView.sort);
  const [dir, setDir] = useState<'asc' | 'desc'>(initialView.dir);
  const [limit, setLimit] = useState(25);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    try {
      sessionStorage.setItem(
        VIEW_KEY,
        JSON.stringify({
          status: statusFilter,
          priority: priorityFilter,
          assigned: assignedFilter,
          client: clientFilter,
          search,
          tag: tagFilter,
          dueAfter,
          dueBefore,
          sort,
          dir,
        } satisfies PersistedRequestsView),
      );
    } catch {
      /* storage unavailable — in-memory only */
    }
  }, [
    statusFilter,
    priorityFilter,
    assignedFilter,
    clientFilter,
    search,
    tagFilter,
    dueAfter,
    dueBefore,
    sort,
    dir,
  ]);

  // Reference data.
  const [clients, setClients] = useState<ClientLite[]>([]);
  const [engagements, setEngagements] = useState<EngagementLite[]>([]);
  const [users, setUsers] = useState<FirmUser[]>([]);
  const [templates, setTemplates] = useState<RequestTemplate[]>([]);

  // Create form.
  const [showCreate, setShowCreate] = useState(false);
  const [bulkMode, setBulkMode] = useState(false);
  const [createClientId, setCreateClientId] = useState('');
  const [createEngagementId, setCreateEngagementId] = useState('');
  const [createTemplateId, setCreateTemplateId] = useState('');
  const [createTitle, setCreateTitle] = useState('');
  const [createBody, setCreateBody] = useState('');
  const [createPriority, setCreatePriority] = useState<Priority>('MEDIUM');
  const [createTags, setCreateTags] = useState('');
  const [createDue, setCreateDue] = useState('');
  const [createActivationDate, setCreateActivationDate] = useState('');
  const [createReminder, setCreateReminder] = useState('');
  const [createAssignee, setCreateAssignee] = useState('');
  const [createItems, setCreateItems] = useState<NewItemDraft[]>([]);
  const [bulkClientIds, setBulkClientIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  async function load(): Promise<void> {
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (statusFilter !== 'ALL') qs.set('status', statusFilter);
      if (priorityFilter) qs.set('priority', priorityFilter);
      if (assignedFilter) qs.set('assignedAppUserId', assignedFilter);
      if (clientFilter) qs.set('clientId', clientFilter);
      if (search.trim()) qs.set('search', search.trim());
      if (tagFilter.trim()) qs.set('tag', tagFilter.trim());
      if (dueBefore) qs.set('dueBefore', dueBefore);
      if (dueAfter) qs.set('dueAfter', dueAfter);
      qs.set('sort', sort);
      qs.set('dir', dir);
      qs.set('limit', String(limit));
      qs.set('offset', String(offset));
      const r = await api<{ items: RequestRow[]; total: number }>(
        `/api/staff/requests?${qs.toString()}`,
      );
      setItems(r.items ?? []);
      setTotal(r.total ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function loadRefData(): Promise<void> {
    try {
      const [c, e, u, t] = await Promise.all([
        api<{ rows: ClientLite[] } | { items: ClientLite[] }>('/api/staff/clients?limit=500').catch(
          () => ({ items: [] as ClientLite[] }),
        ),
        api<{ items: EngagementLite[] }>('/api/staff/engagements?limit=500').catch(() => ({
          items: [] as EngagementLite[],
        })),
        api<{ items: FirmUser[] }>('/api/staff/firm-users').catch(() => ({
          items: [] as FirmUser[],
        })),
        api<{ items: RequestTemplate[] }>('/api/staff/admin/templates/request').catch(() => ({
          items: [] as RequestTemplate[],
        })),
      ]);
      const cRows: ClientLite[] =
        (c as { rows?: ClientLite[]; items?: ClientLite[] }).rows ??
        (c as { items?: ClientLite[] }).items ??
        [];
      setClients(cRows);
      setEngagements(e.items ?? []);
      setUsers(u.items ?? []);
      setTemplates((t.items ?? []).filter((tpl) => tpl.status !== 'ARCHIVED'));
    } catch {
      // Reference data is non-critical; the form still works with raw input.
    }
  }

  useEffect(() => {
    void loadRefData();
  }, []);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    statusFilter,
    priorityFilter,
    assignedFilter,
    clientFilter,
    tagFilter,
    dueBefore,
    dueAfter,
    sort,
    dir,
    limit,
    offset,
  ]);

  // Search-on-Enter rather than every keystroke to avoid hammering.
  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      setOffset(0);
      void load();
    }
  }

  // When template chosen, prefill priority/reminder/items.
  function applyTemplate(tplId: string): void {
    setCreateTemplateId(tplId);
    if (!tplId) {
      setCreateItems([]);
      return;
    }
    const tpl = templates.find((t) => t.id === tplId);
    if (!tpl) return;
    setCreatePriority(tpl.defaultPriority);
    if (tpl.defaultReminderDaysBefore != null) {
      setCreateReminder(String(tpl.defaultReminderDaysBefore));
    }
    if (tpl.defaultAssignedAppUserId) {
      setCreateAssignee(tpl.defaultAssignedAppUserId);
    }
    setCreateItems(
      tpl.items.map((i, idx) => ({
        ordinal: idx,
        label: i.label,
        body: i.body ?? '',
        itemKind: i.itemKind,
        required: i.required,
      })),
    );
  }

  const filteredEngagements = useMemo(
    () => (createClientId ? engagements.filter((e) => e.clientId === createClientId) : engagements),
    [engagements, createClientId],
  );

  function resetCreateForm(): void {
    setCreateClientId('');
    setCreateEngagementId('');
    setCreateTemplateId('');
    setCreateTitle('');
    setCreateBody('');
    setCreatePriority('MEDIUM');
    setCreateTags('');
    setCreateDue('');
    setCreateActivationDate('');
    setCreateReminder('');
    setCreateAssignee('');
    setCreateItems([]);
    setBulkClientIds([]);
    setBulkMode(false);
    setShowCreate(false);
  }

  async function submitCreate(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const tagsArr = createTags
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      const itemsPayload = createItems
        .filter((i) => i.label.trim().length > 0)
        .map((i, idx) => ({
          ordinal: idx,
          label: i.label.trim(),
          body: i.body.trim() || undefined,
          itemKind: i.itemKind,
          required: i.required,
        }));

      if (bulkMode) {
        if (!createTemplateId) {
          setError('Bulk send requires a template.');
          return;
        }
        if (bulkClientIds.length === 0) {
          setError('Pick at least one client.');
          return;
        }
        const targets = bulkClientIds
          .map((cid) => {
            const eng = engagements.find((e) => e.clientId === cid);
            if (!eng) return null;
            return {
              clientId: cid,
              engagementId: eng.id,
              priorityOverride: createPriority,
              dueDateOverride: createDue || undefined,
              assignedAppUserIdOverride: createAssignee || undefined,
              tags: tagsArr.length > 0 ? tagsArr : undefined,
            };
          })
          .filter((t): t is NonNullable<typeof t> => t !== null);
        const resp = await api<{ created: number; skipped: Array<{ reason: string }> }>(
          '/api/staff/requests/bulk',
          {
            method: 'POST',
            body: JSON.stringify({ templateId: createTemplateId, targets }),
          },
        );
        if (resp.skipped.length > 0) {
          setError(`Created ${resp.created}; skipped ${resp.skipped.length}.`);
        }
      } else {
        if (!createEngagementId) {
          setError('Pick an engagement.');
          return;
        }
        if (!createTemplateId && !createTitle.trim()) {
          setError('Title is required when no template is picked.');
          return;
        }
        await api('/api/staff/requests', {
          method: 'POST',
          body: JSON.stringify({
            engagementId: createEngagementId,
            templateId: createTemplateId || undefined,
            title: createTitle.trim() || undefined,
            body: createBody.trim() || undefined,
            priority: createPriority,
            tags: tagsArr.length > 0 ? tagsArr : undefined,
            dueDate: createDue || undefined,
            activationDate: createActivationDate || undefined,
            reminderDaysBefore: createReminder ? Number(createReminder) : undefined,
            assignedAppUserId: createAssignee || undefined,
            items: itemsPayload.length > 0 ? itemsPayload : undefined,
          }),
        });
      }
      resetCreateForm();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'create_failed');
    } finally {
      setSubmitting(false);
    }
  }

  const clientOptions: ComboboxOption[] = useMemo(
    () =>
      clients.map((c) => ({
        value: c.id,
        label: c.name,
      })),
    [clients],
  );
  const engagementOptions: ComboboxOption[] = useMemo(
    () =>
      filteredEngagements.map((e) => ({
        value: e.id,
        label: e.name,
      })),
    [filteredEngagements],
  );
  const userOptions: ComboboxOption[] = useMemo(
    () => users.map((u) => ({ value: u.id, label: u.fullName })),
    [users],
  );
  const templateOptions: ComboboxOption[] = useMemo(
    () => templates.map((t) => ({ value: t.id, label: t.name, description: t.key })),
    [templates],
  );
  // engagementId → client name (a request is tied to an engagement, which
  // belongs to a client) and appUserId → name, for the list columns.
  const clientNameByEngagement = useMemo(() => {
    const clientById = new Map(clients.map((c) => [c.id, c.name]));
    const m = new Map<string, string>();
    for (const e of engagements) {
      const cn = clientById.get(e.clientId);
      if (cn) m.set(e.id, cn);
    }
    return m;
  }, [clients, engagements]);
  const userNameById = useMemo(() => new Map(users.map((u) => [u.id, u.fullName])), [users]);

  const page = Math.floor(offset / limit) + 1;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg }}>
      {error && (
        <Card>
          <p style={{ color: tokens.color.danger, fontSize: 13, margin: 0 }}>{error}</p>
        </Card>
      )}

      <Card title="Filters">
        {/* Button groups get their own full-width rows so they wrap freely;
            the inputs sit in a separate consistent grid that never overlaps. */}
        <div style={{ display: 'grid', gap: tokens.space.md }}>
          <div>
            <div style={{ fontSize: 11, marginBottom: 4 }}>Status</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {STATUS_OPTIONS.map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={statusFilter === s ? 'primary' : 'secondary'}
                  onClick={() => {
                    setStatusFilter(s);
                    setOffset(0);
                  }}
                >
                  {s}
                </Button>
              ))}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11, marginBottom: 4 }}>Priority</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <Button
                size="sm"
                variant={priorityFilter === '' ? 'primary' : 'secondary'}
                onClick={() => {
                  setPriorityFilter('');
                  setOffset(0);
                }}
              >
                Any
              </Button>
              {PRIORITIES.map((p) => (
                <Button
                  key={p}
                  size="sm"
                  variant={priorityFilter === p ? 'primary' : 'secondary'}
                  onClick={() => {
                    setPriorityFilter(p);
                    setOffset(0);
                  }}
                >
                  {p}
                </Button>
              ))}
            </div>
          </div>
          <div
            style={{
              display: 'grid',
              gap: tokens.space.sm,
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              alignItems: 'end',
            }}
          >
            <div>
              <div style={{ fontSize: 11, marginBottom: 4 }}>Assigned to</div>
              <Combobox
                options={[{ value: '', label: 'Anyone' }, ...userOptions]}
                value={assignedFilter}
                onChange={(v) => {
                  setAssignedFilter(v);
                  setOffset(0);
                }}
                placeholder="Anyone"
                clearable
              />
            </div>
            <div>
              <div style={{ fontSize: 11, marginBottom: 4 }}>Client</div>
              <Combobox
                options={[{ value: '', label: 'All clients' }, ...clientOptions]}
                value={clientFilter}
                onChange={(v) => {
                  setClientFilter(v);
                  setOffset(0);
                }}
                placeholder="All clients"
                clearable
              />
            </div>
            <div>
              <div style={{ fontSize: 11, marginBottom: 4 }}>Due after</div>
              <input
                type="date"
                value={dueAfter}
                onChange={(e) => {
                  setDueAfter(e.target.value);
                  setOffset(0);
                }}
                style={fieldStyle()}
              />
            </div>
            <div>
              <div style={{ fontSize: 11, marginBottom: 4 }}>Due before</div>
              <input
                type="date"
                value={dueBefore}
                onChange={(e) => {
                  setDueBefore(e.target.value);
                  setOffset(0);
                }}
                style={fieldStyle()}
              />
            </div>
            <div>
              <div style={{ fontSize: 11, marginBottom: 4 }}>Tag</div>
              <input
                type="text"
                value={tagFilter}
                onChange={(e) => {
                  setTagFilter(e.target.value);
                  setOffset(0);
                }}
                placeholder="e.g. urgent"
                style={fieldStyle()}
              />
            </div>
            <div>
              <div style={{ fontSize: 11, marginBottom: 4 }}>Search</div>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={onSearchKey}
                placeholder="title / body (Enter)"
                style={fieldStyle()}
              />
            </div>
          </div>
        </div>
      </Card>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: tokens.space.sm, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: tokens.color.textMuted }}>Sort by</span>
          <Combobox options={SORT_OPTIONS} value={sort} onChange={(v) => setSort(v)} width={160} />
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
          >
            {dir === 'asc' ? '↑ asc' : '↓ desc'}
          </Button>
        </div>
        <Button onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? 'Cancel' : 'New request'}
        </Button>
      </div>

      {showCreate && (
        <Card title={bulkMode ? 'Bulk send' : 'Create request'}>
          <div style={{ display: 'grid', gap: tokens.space.sm }}>
            <div style={{ display: 'flex', gap: tokens.space.sm, alignItems: 'center' }}>
              <Button
                size="sm"
                variant={bulkMode ? 'secondary' : 'primary'}
                onClick={() => setBulkMode(false)}
              >
                Single
              </Button>
              <Button
                size="sm"
                variant={bulkMode ? 'primary' : 'secondary'}
                onClick={() => setBulkMode(true)}
              >
                Bulk (template only)
              </Button>
            </div>

            <label style={fieldLabel()}>
              <span>
                Template {bulkMode && <span style={{ color: tokens.color.danger }}>*</span>}
              </span>
              <Combobox
                options={[{ value: '', label: '— none —' }, ...templateOptions]}
                value={createTemplateId}
                onChange={(v) => applyTemplate(v)}
                placeholder="— none —"
                clearable
              />
            </label>

            {!bulkMode ? (
              <>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: tokens.space.sm,
                  }}
                >
                  <div style={{ fontSize: 12 }}>
                    <div style={{ marginBottom: 4 }}>Client</div>
                    <Combobox
                      ariaLabel="Client"
                      options={clientOptions}
                      value={createClientId}
                      onChange={(v) => {
                        setCreateClientId(v);
                        setCreateEngagementId('');
                      }}
                      placeholder="Pick client"
                    />
                  </div>
                  <div style={{ fontSize: 12 }}>
                    <div style={{ marginBottom: 4 }}>
                      Engagement <span style={{ color: tokens.color.danger }}>*</span>
                    </div>
                    <Combobox
                      ariaLabel="Engagement"
                      options={engagementOptions}
                      value={createEngagementId}
                      onChange={setCreateEngagementId}
                      placeholder={
                        createClientId ? 'Pick engagement' : 'Pick client first (or pick any)'
                      }
                    />
                  </div>
                </div>
                <label style={fieldLabel()}>
                  <span>
                    Title{' '}
                    {!createTemplateId && <span style={{ color: tokens.color.danger }}>*</span>}
                  </span>
                  <input
                    type="text"
                    value={createTitle}
                    onChange={(e) => setCreateTitle(e.target.value)}
                    placeholder={
                      createTemplateId ? '(template title used if blank)' : 'Send 2026 W-2s'
                    }
                    style={fieldStyle()}
                  />
                </label>
                <label style={fieldLabel()}>
                  <span>Body</span>
                  <textarea
                    value={createBody}
                    onChange={(e) => setCreateBody(e.target.value)}
                    rows={3}
                    placeholder={createTemplateId ? '(template body used if blank)' : ''}
                    style={{ ...fieldStyle(), resize: 'vertical', minHeight: 72 }}
                  />
                </label>
              </>
            ) : (
              <label style={fieldLabel()}>
                <span>Clients to send to</span>
                <div
                  style={{
                    maxHeight: 200,
                    overflow: 'auto',
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.md,
                    padding: tokens.space.sm,
                    display: 'grid',
                    gap: 4,
                  }}
                >
                  {clients.map((c) => (
                    <label
                      key={c.id}
                      style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}
                    >
                      <input
                        type="checkbox"
                        checked={bulkClientIds.includes(c.id)}
                        onChange={(e) => {
                          setBulkClientIds((prev) =>
                            e.target.checked ? [...prev, c.id] : prev.filter((id) => id !== c.id),
                          );
                        }}
                      />
                      {c.name}
                    </label>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
                  {bulkClientIds.length} selected. The first active engagement on each client will
                  be used.
                </div>
              </label>
            )}

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                gap: tokens.space.sm,
              }}
            >
              <div style={{ fontSize: 12 }}>
                <div style={{ marginBottom: 4 }}>Priority</div>
                <Combobox
                  ariaLabel="Priority"
                  options={PRIORITIES.map((p) => ({ value: p, label: p }))}
                  value={createPriority}
                  onChange={(v) => setCreatePriority(v as Priority)}
                />
              </div>
              <label style={fieldLabel()}>
                <span>Due date</span>
                <input
                  type="date"
                  value={createDue}
                  onChange={(e) => setCreateDue(e.target.value)}
                  style={fieldStyle()}
                />
              </label>
              <label style={fieldLabel()}>
                <span>Hide until (schedule / activation date — optional)</span>
                <input
                  type="date"
                  value={createActivationDate}
                  onChange={(e) => setCreateActivationDate(e.target.value)}
                  style={fieldStyle()}
                  title="If set, the request stays hidden (Scheduled) until this date, then opens and is submitted to the client."
                />
              </label>
              <label style={fieldLabel()}>
                <span>Reminder days before due</span>
                <input
                  type="number"
                  min={0}
                  max={365}
                  value={createReminder}
                  onChange={(e) => setCreateReminder(e.target.value)}
                  placeholder="e.g. 3"
                  style={fieldStyle()}
                />
              </label>
              <div style={{ fontSize: 12 }}>
                <div style={{ marginBottom: 4 }}>Assigned to</div>
                <Combobox
                  ariaLabel="Assigned to"
                  options={[{ value: '', label: 'Nobody' }, ...userOptions]}
                  value={createAssignee}
                  onChange={setCreateAssignee}
                  placeholder="Nobody"
                  clearable
                />
              </div>
              <label style={fieldLabel()}>
                <span>Tags (comma-separated)</span>
                <input
                  type="text"
                  value={createTags}
                  onChange={(e) => setCreateTags(e.target.value)}
                  placeholder="urgent, audit"
                  style={fieldStyle()}
                />
              </label>
            </div>

            {!bulkMode && (
              <div>
                <div
                  style={{
                    fontSize: 12,
                    marginBottom: 4,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <span>Checklist items ({createItems.length})</span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setCreateItems((prev) => [...prev, emptyItem(prev.length)])}
                  >
                    + Item
                  </Button>
                </div>
                {createItems.length === 0 ? (
                  <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
                    No items. Pick a template above or add items here.
                  </div>
                ) : (
                  <div style={{ display: 'grid', gap: 4 }}>
                    {createItems.map((it, idx) => (
                      <div
                        key={idx}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'minmax(0, 1fr) 140px auto auto auto',
                          gap: 6,
                          alignItems: 'center',
                        }}
                      >
                        <input
                          type="text"
                          value={it.label}
                          onChange={(e) =>
                            setCreateItems((prev) =>
                              prev.map((x, i) => (i === idx ? { ...x, label: e.target.value } : x)),
                            )
                          }
                          placeholder={`Item ${idx + 1}`}
                          style={fieldStyle()}
                        />
                        <select
                          value={it.itemKind}
                          onChange={(e) =>
                            setCreateItems((prev) =>
                              prev.map((x, i) =>
                                i === idx ? { ...x, itemKind: e.target.value as ItemKind } : x,
                              ),
                            )
                          }
                          style={fieldStyle()}
                        >
                          <option value="QUESTION">Question</option>
                          <option value="DOCUMENT">Document</option>
                          <option value="SIGNATURE">Signature</option>
                        </select>
                        <label
                          style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}
                        >
                          <input
                            type="checkbox"
                            checked={it.required}
                            onChange={(e) =>
                              setCreateItems((prev) =>
                                prev.map((x, i) =>
                                  i === idx ? { ...x, required: e.target.checked } : x,
                                ),
                              )
                            }
                          />
                          required
                        </label>
                        <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                          #{idx + 1}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setCreateItems((prev) => prev.filter((_, i) => i !== idx))}
                        >
                          ✕
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div style={{ display: 'flex', gap: tokens.space.sm }}>
              <Button onClick={() => void submitCreate()} disabled={submitting}>
                {submitting ? 'Sending…' : bulkMode ? 'Send to all' : 'Create'}
              </Button>
              <Button variant="ghost" onClick={resetCreateForm}>
                Cancel
              </Button>
            </div>
          </div>
        </Card>
      )}

      <Card title={`Requests (${total})`}>
        <Table<RequestRow>
          rows={items}
          rowKey={(r) => r.id}
          empty="No requests match the filter."
          columns={[
            {
              key: 'title',
              header: 'Title',
              render: (r) => (
                <div
                  onClick={() => navigate(`/requests/${r.id}`)}
                  style={{ cursor: 'pointer' }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') navigate(`/requests/${r.id}`);
                  }}
                >
                  <div style={{ fontWeight: 500, fontSize: 13 }}>{r.title}</div>
                  {r.body && (
                    <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
                      {r.body.slice(0, 120)}
                      {r.body.length > 120 ? '…' : ''}
                    </div>
                  )}
                  {r.tags.length > 0 && (
                    <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                      {r.tags.map((t) => (
                        <Pill key={t} tone="neutral">
                          {t}
                        </Pill>
                      ))}
                    </div>
                  )}
                  {r.linkedTimeEntry && (
                    <div style={{ fontSize: 11, color: tokens.color.success, marginTop: 4 }}>
                      Linked time entry: {r.linkedTimeEntry.hours} hrs
                      {r.linkedTimeEntry.staffName ? ` by ${r.linkedTimeEntry.staffName}` : ''} (
                      {r.linkedTimeEntry.entryDate})
                    </div>
                  )}
                </div>
              ),
            },
            {
              key: 'client',
              header: 'Client',
              render: (r) => (
                <span style={{ fontSize: 13 }}>
                  {clientNameByEngagement.get(r.engagementId) ?? '—'}
                </span>
              ),
            },
            {
              key: 'assigned',
              header: 'Assigned',
              render: (r) => (
                <span style={{ fontSize: 13, color: tokens.color.textMuted }}>
                  {r.assignedAppUserId ? (userNameById.get(r.assignedAppUserId) ?? '—') : '—'}
                </span>
              ),
            },
            {
              key: 'priority',
              header: 'Priority',
              render: (r) => <Pill tone={priorityTone(r.priority)}>{r.priority}</Pill>,
            },
            {
              key: 'status',
              header: 'Status',
              render: (r) => <Pill tone={statusTone(r.status)}>{r.status}</Pill>,
            },
            { key: 'due', header: 'Due', render: (r) => r.dueDate ?? '—' },
            {
              key: 'created',
              header: 'Created',
              render: (r) => new Date(r.createdAt).toLocaleDateString(),
            },
            {
              key: 'open',
              header: '',
              render: (r) => (
                <Button size="sm" variant="ghost" onClick={() => navigate(`/requests/${r.id}`)}>
                  Open
                </Button>
              ),
            },
          ]}
        />

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: tokens.space.sm,
            fontSize: 12,
          }}
        >
          <div style={{ display: 'flex', gap: tokens.space.sm, alignItems: 'center' }}>
            <span>
              Page {page} of {totalPages}
            </span>
            <Combobox
              options={[25, 50, 100, 200].map((n) => ({ value: String(n), label: `${n}/page` }))}
              value={String(limit)}
              onChange={(v) => {
                setLimit(Number(v));
                setOffset(0);
              }}
              width={110}
            />
          </div>
          <div style={{ display: 'flex', gap: tokens.space.sm }}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setOffset(Math.max(0, offset - limit))}
              disabled={offset === 0}
            >
              ← Prev
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setOffset(offset + limit)}
              disabled={offset + limit >= total}
            >
              Next →
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

// Shared form-control styling. The raw inputs/selects/textarea on this
// page previously had no box-sizing (width:100% + padding overflowed
// their grid cells and overlapped neighbours) and no border/background.
// `fieldStyle` fixes the box model + matches the design tokens;
// `fieldLabel` stacks a caption above its control with spacing (the
// inline <label> wrappers used to glue the caption to the input).
function fieldStyle(): React.CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    padding: '8px 10px',
    fontSize: 13,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.sm,
    background: tokens.color.surface,
    color: tokens.color.text,
    fontFamily: tokens.font.body,
  };
}

function fieldLabel(): React.CSSProperties {
  return { display: 'grid', gap: 4, fontSize: 12 };
}
