/* eslint-disable jsx-a11y/label-has-associated-control -- labels and controls are siblings inside grid containers; revisit with htmlFor/id pairs in a polish pass */
// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Top-level "Tasks" view. Lists tasks across all clients with a My/All
// toggle plus status / priority / client / overdue filters and search, and
// lets staff create a task directly (picking the client via a typeahead).
// The per-client task UI still lives on the client detail page (TasksCard);
// both read/write the same client_task table.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button, Card, Combobox, Input, Pill, Table, tokens, type ComboboxOption } from '@vibe/ui';

import { api } from '../api-client';
import {
  PRIORITY_TONE,
  STATUS_TONE,
  type TaskPriority,
  type TaskStatus,
} from './clients/task-tones';

interface TaskRow {
  id: string;
  clientId: string;
  clientName: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  title: string;
  description: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  dueDate: string | null;
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

const PRIORITY_OPTS: ComboboxOption[] = [
  { value: '', label: 'Any priority' },
  { value: 'URGENT', label: 'Urgent' },
  { value: 'HIGH', label: 'High' },
  { value: 'MEDIUM', label: 'Medium' },
  { value: 'LOW', label: 'Low' },
];

function todayIso(): string {
  // Local date, YYYY-MM-DD — matches the server's CURRENT_DATE comparison
  // closely enough for the overdue highlight.
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function TasksPage(): JSX.Element {
  const navigate = useNavigate();
  const [rows, setRows] = useState<TaskRow[]>([]);
  const [total, setTotal] = useState(0);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Filters
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [assigneeId, setAssigneeId] = useState('');
  const [priority, setPriority] = useState('');
  const [includeClosed, setIncludeClosed] = useState(false);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [q, setQ] = useState('');

  const [createOpen, setCreateOpen] = useState(false);

  const today = useMemo(() => todayIso(), []);

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('scope', scope);
      if (assigneeId) params.set('assigneeId', assigneeId);
      if (priority) params.set('priority', priority);
      if (includeClosed) params.set('includeClosed', '1');
      if (overdueOnly) params.set('overdue', '1');
      if (q.trim()) params.set('q', q.trim());
      params.set('pageSize', '200');
      const r = await api<{ items: TaskRow[]; total: number }>(
        `/api/staff/tasks?${params.toString()}`,
      );
      setRows(r.items ?? []);
      setTotal(r.total ?? 0);
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
  }, [scope, assigneeId, priority, includeClosed, overdueOnly]);

  async function setStatus(id: string, status: TaskStatus): Promise<void> {
    setBusyId(id);
    try {
      await api(`/api/staff/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'update_failed');
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

  const assigneeOpts: ComboboxOption[] = [
    { value: '', label: scope === 'mine' ? 'Me' : 'Anyone' },
    ...users.map((u) => ({ value: u.id, label: u.fullName })),
  ];

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg }}>
      <Card title="Tasks" action={<Button onClick={() => setCreateOpen(true)}>+ New task</Button>}>
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
            {error}
          </p>
        )}

        {/* Scope toggle */}
        <div style={{ display: 'inline-flex', gap: 4, marginBottom: 12 }}>
          {(['mine', 'all'] as const).map((s) => (
            <button
              key={s}
              onClick={() => {
                setScope(s);
                setAssigneeId('');
              }}
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

        {/* Filter bar */}
        <div
          style={{
            display: 'flex',
            gap: 12,
            flexWrap: 'wrap',
            alignItems: 'end',
            marginBottom: 12,
          }}
        >
          <div style={{ minWidth: 200, flex: 1 }}>
            <Input
              label="Search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void load();
              }}
              placeholder="Search title…"
            />
          </div>
          {scope === 'all' && (
            <div style={{ minWidth: 180 }}>
              <label style={{ fontSize: 12, color: tokens.color.textMuted }}>Assignee</label>
              <Combobox
                ariaLabel="Assignee"
                value={assigneeId}
                onChange={setAssigneeId}
                options={assigneeOpts}
              />
            </div>
          )}
          <div style={{ minWidth: 150 }}>
            <label style={{ fontSize: 12, color: tokens.color.textMuted }}>Priority</label>
            <Combobox
              ariaLabel="Priority"
              value={priority}
              onChange={setPriority}
              options={PRIORITY_OPTS}
            />
          </div>
          <label style={{ display: 'flex', gap: 6, fontSize: 13, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={overdueOnly}
              onChange={(e) => setOverdueOnly(e.target.checked)}
            />
            Overdue only
          </label>
          <label style={{ display: 'flex', gap: 6, fontSize: 13, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={includeClosed}
              onChange={(e) => setIncludeClosed(e.target.checked)}
            />
            Show done / canceled
          </label>
        </div>

        {loading ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
        ) : (
          <>
            <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 6 }}>
              {total} task{total === 1 ? '' : 's'}
            </div>
            <Table<TaskRow>
              rows={rows}
              rowKey={(t) => t.id}
              empty={
                <span style={{ fontSize: 13, color: tokens.color.textMuted }}>
                  No tasks match these filters.
                </span>
              }
              columns={[
                {
                  key: 'title',
                  header: 'Task',
                  render: (t) => (
                    <div style={{ display: 'grid', gap: 2 }}>
                      <strong style={{ fontSize: 13 }}>{t.title}</strong>
                      {t.description && (
                        <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                          {t.description.length > 80
                            ? `${t.description.slice(0, 80)}…`
                            : t.description}
                        </span>
                      )}
                    </div>
                  ),
                },
                {
                  key: 'client',
                  header: 'Client',
                  render: (t) => (
                    <button
                      onClick={() => navigate(`/clients/${t.clientId}`)}
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
                  ),
                },
                {
                  key: 'assignee',
                  header: 'Assignee',
                  render: (t) => (
                    <span style={{ fontSize: 13 }}>{t.assigneeName ?? 'Unassigned'}</span>
                  ),
                },
                {
                  key: 'priority',
                  header: 'Priority',
                  render: (t) => <Pill tone={PRIORITY_TONE[t.priority]}>{t.priority}</Pill>,
                },
                {
                  key: 'status',
                  header: 'Status',
                  render: (t) => (
                    <Pill tone={STATUS_TONE[t.status]}>{t.status.replace('_', ' ')}</Pill>
                  ),
                },
                {
                  key: 'due',
                  header: 'Due',
                  render: (t) =>
                    t.dueDate ? (
                      <span
                        style={{
                          fontSize: 12,
                          color:
                            t.dueDate < today && t.status !== 'DONE' && t.status !== 'CANCELED'
                              ? tokens.color.danger
                              : tokens.color.textMuted,
                          fontWeight:
                            t.dueDate < today && t.status !== 'DONE' && t.status !== 'CANCELED'
                              ? 600
                              : 400,
                        }}
                      >
                        {t.dueDate}
                      </span>
                    ) : (
                      <span style={{ fontSize: 12, color: tokens.color.textMuted }}>—</span>
                    ),
                },
                {
                  key: 'actions',
                  header: '',
                  align: 'right',
                  render: (t) => (
                    <span style={{ display: 'inline-flex', gap: 4 }}>
                      {t.status === 'OPEN' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busyId === t.id}
                          onClick={() => void setStatus(t.id, 'IN_PROGRESS')}
                        >
                          Start
                        </Button>
                      )}
                      {t.status !== 'DONE' && t.status !== 'CANCELED' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busyId === t.id}
                          onClick={() => void setStatus(t.id, 'DONE')}
                        >
                          Done
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busyId === t.id}
                        onClick={() => void remove(t.id)}
                      >
                        Remove
                      </Button>
                    </span>
                  ),
                },
              ]}
            />
          </>
        )}
      </Card>

      {createOpen && (
        <NewTaskDialog
          users={users}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function NewTaskDialog({
  users,
  onClose,
  onCreated,
}: {
  users: AppUser[];
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const [clientQuery, setClientQuery] = useState('');
  const [clientHits, setClientHits] = useState<ClientHit[]>([]);
  const [clientId, setClientId] = useState('');
  const [clientLabel, setClientLabel] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('MEDIUM');
  const [dueDate, setDueDate] = useState('');
  const [assigneeUserId, setAssigneeUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounced client typeahead against the existing clients search.
  useEffect(() => {
    if (clientId) return; // already picked
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
  }, [clientQuery, clientId]);

  async function create(): Promise<void> {
    if (!clientId || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api('/api/staff/tasks', {
        method: 'POST',
        body: JSON.stringify({
          clientId,
          title: title.trim(),
          description: description.trim() || null,
          priority,
          dueDate: dueDate || null,
          assigneeUserId: assigneeUserId || null,
        }),
      });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'create_failed');
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
        <Card title="New task">
          {error && (
            <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
              {error}
            </p>
          )}
          <div style={{ display: 'grid', gap: 10 }}>
            {/* Client picker */}
            <div>
              <label style={{ fontSize: 12, color: tokens.color.textMuted }}>Client *</label>
              {clientId ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Pill tone="accent">{clientLabel}</Pill>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setClientId('');
                      setClientLabel('');
                      setClientQuery('');
                    }}
                  >
                    Change
                  </Button>
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

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
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
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={() => void create()} disabled={busy || !clientId || !title.trim()}>
                {busy ? 'Creating…' : 'Create task'}
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
