// SPDX-License-Identifier: Elastic-2.0
//
// Client tasks card + full tab (v2 Sprint C, workstream 1.3). The same
// component renders in two modes:
//   compact=true  — top 3 active for the Home tab
//   compact=false — full list view for the Tasks tab
//
// Status pills + priority pills are color-coded; clicking the status
// pill cycles through the workflow (OPEN → IN_PROGRESS → DONE).

import { useEffect, useState } from 'react';

import { Button, Card, Combobox, Pill, tokens, type ComboboxOption } from '@vibe/ui';

import { api } from '../../api-client';
import {
  PRIORITY_TONE,
  RECURRENCE_LABEL,
  RECURRENCE_OPTIONS,
  STATUS_TONE,
  type TaskPriority as Priority,
  type TaskRecurrence,
  type TaskStatus as Status,
} from './task-tones';

interface Task {
  id: string;
  title: string;
  description: string | null;
  priority: Priority;
  status: Status;
  dueDate: string | null;
  recurrence: TaskRecurrence | null;
  assigneeUserId: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface AppUser {
  id: string;
  fullName: string;
}

interface Props {
  clientId: string;
  compact?: boolean;
  users?: AppUser[];
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

export function TasksCard({ clientId, compact = false, users = [] }: Props): JSX.Element {
  const [items, setItems] = useState<Task[]>([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    title: '',
    description: '',
    priority: 'MEDIUM' as Priority,
    dueDate: '',
    assigneeUserId: '',
    recurrence: '' as TaskRecurrence | '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState({
    title: '',
    description: '',
    priority: 'MEDIUM' as Priority,
    status: 'OPEN' as Status,
    dueDate: '',
    assigneeUserId: '',
    recurrence: '' as TaskRecurrence | '',
  });

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: Task[] }>(`/api/staff/clients/${clientId}/tasks`);
      setItems(r.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  async function add(): Promise<void> {
    if (!draft.title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/clients/${clientId}/tasks`, {
        method: 'POST',
        body: JSON.stringify({
          title: draft.title.trim(),
          description: draft.description.trim() || null,
          priority: draft.priority,
          dueDate: draft.dueDate || null,
          assigneeUserId: draft.assigneeUserId || null,
          recurrence: draft.recurrence || null,
        }),
      });
      setDraft({
        title: '',
        description: '',
        priority: 'MEDIUM',
        dueDate: '',
        assigneeUserId: '',
        recurrence: '',
      });
      setAdding(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'add_failed');
    } finally {
      setBusy(false);
    }
  }

  function startEdit(t: Task): void {
    setEditingId(t.id);
    setEditDraft({
      title: t.title,
      description: t.description ?? '',
      priority: t.priority,
      status: t.status,
      dueDate: t.dueDate ?? '',
      assigneeUserId: t.assigneeUserId ?? '',
      recurrence: t.recurrence ?? '',
    });
    setError(null);
  }

  async function saveEdit(): Promise<void> {
    if (!editingId || !editDraft.title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/clients/${clientId}/tasks/${editingId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: editDraft.title.trim(),
          description: editDraft.description.trim() || null,
          priority: editDraft.priority,
          status: editDraft.status,
          dueDate: editDraft.dueDate || null,
          assigneeUserId: editDraft.assigneeUserId || null,
          recurrence: editDraft.recurrence || null,
        }),
      });
      setEditingId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'update_failed');
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(taskId: string, status: Status): Promise<void> {
    setBusy(true);
    try {
      await api(`/api/staff/clients/${clientId}/tasks/${taskId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'patch_failed');
    } finally {
      setBusy(false);
    }
  }

  async function remove(taskId: string): Promise<void> {
    if (!confirm('Remove this task?')) return;
    setBusy(true);
    try {
      await api(`/api/staff/clients/${clientId}/tasks/${taskId}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'remove_failed');
    } finally {
      setBusy(false);
    }
  }

  const visible = compact
    ? items.filter((t) => t.status !== 'DONE' && t.status !== 'CANCELED').slice(0, 3)
    : items;
  const activeCount = items.filter((t) => t.status !== 'DONE' && t.status !== 'CANCELED').length;

  return (
    <Card
      title={
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span>Tasks</span>
          <Pill>{`${activeCount} active`}</Pill>
        </span>
      }
      action={
        <Button size="sm" onClick={() => setAdding(!adding)}>
          {adding ? 'Cancel' : '+ Add task'}
        </Button>
      }
    >
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
          {error}
        </p>
      )}

      {adding && (
        <div
          style={{
            display: 'grid',
            gap: 8,
            padding: 12,
            marginBottom: 12,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
          }}
        >
          <input
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder="Task title *"
            style={fieldStyle}
          />
          <textarea
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            placeholder="Description (optional)"
            rows={2}
            style={{ ...fieldStyle, resize: 'vertical' }}
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            <Combobox
              ariaLabel="Priority"
              value={draft.priority}
              onChange={(val) => setDraft({ ...draft, priority: val as Priority })}
              options={[
                { value: 'LOW', label: 'Low' },
                { value: 'MEDIUM', label: 'Medium' },
                { value: 'HIGH', label: 'High' },
                { value: 'URGENT', label: 'Urgent' },
              ]}
            />
            <input
              type="date"
              value={draft.dueDate}
              onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })}
              style={fieldStyle}
            />
            <Combobox
              ariaLabel="Assignee"
              clearable
              value={draft.assigneeUserId}
              onChange={(val) => setDraft({ ...draft, assigneeUserId: val })}
              options={users.map<ComboboxOption>((u) => ({ value: u.id, label: u.fullName }))}
              placeholder="Assignee…"
            />
          </div>
          <div style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 11, color: tokens.color.textMuted }}>Repeats</span>
            <Combobox
              ariaLabel="Repeats"
              value={draft.recurrence}
              onChange={(val) => setDraft({ ...draft, recurrence: val as TaskRecurrence | '' })}
              options={RECURRENCE_OPTIONS.map<ComboboxOption>((o) => ({
                value: o.value,
                label: o.label,
              }))}
            />
            <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
              When completed, the next task opens automatically.
            </span>
          </div>
          <div>
            <Button size="sm" onClick={() => void add()} disabled={busy || !draft.title.trim()}>
              Add task
            </Button>
          </div>
        </div>
      )}

      {visible.length === 0 ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
          {compact ? 'No active tasks.' : 'No tasks yet.'}
        </p>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {visible.map((t) => {
            const assignee = users.find((u) => u.id === t.assigneeUserId)?.fullName;
            if (editingId === t.id) {
              return (
                <div
                  key={t.id}
                  style={{
                    display: 'grid',
                    gap: 8,
                    padding: 12,
                    border: `1px solid ${tokens.color.accent}`,
                    borderRadius: tokens.radius.md,
                  }}
                >
                  <input
                    value={editDraft.title}
                    onChange={(e) => setEditDraft({ ...editDraft, title: e.target.value })}
                    placeholder="Task title *"
                    style={fieldStyle}
                  />
                  <textarea
                    value={editDraft.description}
                    onChange={(e) => setEditDraft({ ...editDraft, description: e.target.value })}
                    placeholder="Description (optional)"
                    rows={2}
                    style={{ ...fieldStyle, resize: 'vertical' }}
                  />
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <Combobox
                      ariaLabel="Priority"
                      value={editDraft.priority}
                      onChange={(val) => setEditDraft({ ...editDraft, priority: val as Priority })}
                      options={[
                        { value: 'LOW', label: 'Low' },
                        { value: 'MEDIUM', label: 'Medium' },
                        { value: 'HIGH', label: 'High' },
                        { value: 'URGENT', label: 'Urgent' },
                      ]}
                    />
                    <Combobox
                      ariaLabel="Status"
                      value={editDraft.status}
                      onChange={(val) => setEditDraft({ ...editDraft, status: val as Status })}
                      options={[
                        { value: 'OPEN', label: 'Open' },
                        { value: 'IN_PROGRESS', label: 'In progress' },
                        { value: 'BLOCKED', label: 'Blocked' },
                        { value: 'DONE', label: 'Done' },
                        { value: 'CANCELED', label: 'Canceled' },
                      ]}
                    />
                    <input
                      type="date"
                      value={editDraft.dueDate}
                      onChange={(e) => setEditDraft({ ...editDraft, dueDate: e.target.value })}
                      style={fieldStyle}
                    />
                    <Combobox
                      ariaLabel="Assignee"
                      clearable
                      value={editDraft.assigneeUserId}
                      onChange={(val) => setEditDraft({ ...editDraft, assigneeUserId: val })}
                      options={users.map<ComboboxOption>((u) => ({
                        value: u.id,
                        label: u.fullName,
                      }))}
                      placeholder="Assignee…"
                    />
                  </div>
                  <div style={{ display: 'grid', gap: 4 }}>
                    <span style={{ fontSize: 11, color: tokens.color.textMuted }}>Repeats</span>
                    <Combobox
                      ariaLabel="Repeats"
                      value={editDraft.recurrence}
                      onChange={(val) =>
                        setEditDraft({ ...editDraft, recurrence: val as TaskRecurrence | '' })
                      }
                      options={RECURRENCE_OPTIONS.map<ComboboxOption>((o) => ({
                        value: o.value,
                        label: o.label,
                      }))}
                    />
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Button
                      size="sm"
                      onClick={() => void saveEdit()}
                      disabled={busy || !editDraft.title.trim()}
                    >
                      Save changes
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditingId(null)}
                      disabled={busy}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              );
            }
            return (
              <div
                key={t.id}
                style={{
                  padding: 10,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.md,
                  display: 'grid',
                  gap: 4,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 13 }}>{t.title}</strong>
                  <Pill tone={STATUS_TONE[t.status]}>{t.status.replace('_', ' ')}</Pill>
                  <Pill tone={PRIORITY_TONE[t.priority]}>{t.priority}</Pill>
                  {t.dueDate && (
                    <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                      due {t.dueDate}
                    </span>
                  )}
                  {t.recurrence && (
                    <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                      ↻ {RECURRENCE_LABEL[t.recurrence]}
                    </span>
                  )}
                  {assignee && (
                    <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                      → {assignee}
                    </span>
                  )}
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                    {t.status !== 'DONE' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void setStatus(t.id, 'DONE')}
                        disabled={busy}
                      >
                        Done
                      </Button>
                    )}
                    {t.status === 'OPEN' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void setStatus(t.id, 'IN_PROGRESS')}
                        disabled={busy}
                      >
                        Start
                      </Button>
                    )}
                    {!compact && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => startEdit(t)}
                        disabled={busy}
                      >
                        Edit
                      </Button>
                    )}
                    {!compact && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void remove(t.id)}
                        disabled={busy}
                      >
                        Remove
                      </Button>
                    )}
                  </span>
                </div>
                {t.description && !compact && (
                  <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
                    {t.description}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
