/* eslint-disable jsx-a11y/label-has-associated-control -- labels and controls are siblings inside grid containers; revisit with htmlFor/id pairs in a polish pass */
// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Client-scoped Requests view. Mounted on the Requests tab of the
// client dashboard. Mirrors the ClientMessagesCard pattern: lists
// requests across every engagement on this client, exposes a
// lightweight "New request" composer, and lets staff jump to the
// full RequestDetail page for items, fulfillments, and timeline.
//
// Backed by /api/staff/requests?clientId=X for the list and the
// existing POST /api/staff/requests for create. Anything richer
// (templates, multi-item checklists, bulk-send, reminder cadence)
// still lives on the standalone /requests page; this card is the
// fast inline access from inside a client.

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button, Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
type ItemKind = 'QUESTION' | 'DOCUMENT' | 'SIGNATURE';

const ITEM_KIND_OPTIONS: Array<{ value: ItemKind; label: string }> = [
  { value: 'DOCUMENT', label: 'Document upload' },
  { value: 'QUESTION', label: 'Question / answer' },
  { value: 'SIGNATURE', label: 'Signature' },
];

interface ChecklistItemDraft {
  label: string;
  itemKind: ItemKind;
  required: boolean;
  body: string;
}

interface RequestTemplate {
  id: string;
  key: string;
  name: string;
  items: Array<{
    ordinal: number;
    label: string;
    itemKind: ItemKind;
    required: boolean;
    body: string;
  }>;
}

interface RequestRow {
  id: string;
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
}

interface EngagementOption {
  id: string;
  name: string;
  status: string;
}

interface FirmUser {
  id: string;
  fullName: string;
}

const STATUS_FILTERS = ['OPEN_ONLY', 'ALL', 'FULFILLED', 'DISMISSED'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const PRIORITIES: Priority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

function statusTone(s: string): 'success' | 'warning' | 'neutral' | 'accent' {
  switch (s) {
    case 'OPEN':
      return 'warning';
    case 'FULFILLED':
      return 'success';
    case 'NEEDS_INFO':
      return 'accent';
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
    default:
      return 'neutral';
  }
}

export function ClientRequestsCard({ clientId }: { clientId: string }): JSX.Element {
  const navigate = useNavigate();
  const [rows, setRows] = useState<RequestRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('OPEN_ONLY');
  const [composing, setComposing] = useState(false);
  const [engagements, setEngagements] = useState<EngagementOption[]>([]);
  const [users, setUsers] = useState<FirmUser[]>([]);
  const [templates, setTemplates] = useState<RequestTemplate[]>([]);

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ clientId, limit: '100' });
      if (statusFilter === 'OPEN_ONLY') qs.set('status', 'OPEN');
      else if (statusFilter === 'FULFILLED') qs.set('status', 'FULFILLED');
      else if (statusFilter === 'DISMISSED') qs.set('status', 'DISMISSED');
      const r = await api<{ items: RequestRow[]; total: number }>(
        `/api/staff/requests?${qs.toString()}`,
      );
      setRows(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load_failed');
      setRows([]);
    }
  }, [clientId, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  // Lazy-load engagements + firm users + request templates the first
  // time the composer opens. Templates ship a pre-built item checklist
  // (e.g. "1040 client documents" → 6 DOCUMENT items, 1 SIGNATURE) so
  // the partner can spin a thorough request with one click.
  useEffect(() => {
    if (!composing || engagements.length > 0) return;
    void (async () => {
      try {
        const [e, u, t] = await Promise.all([
          api<{ items: EngagementOption[] }>(`/api/staff/engagements?clientId=${clientId}`),
          api<{ items: FirmUser[] }>('/api/staff/users').catch(() => ({ items: [] })),
          api<{ items: RequestTemplate[] }>('/api/staff/admin/templates/request').catch(() => ({
            items: [],
          })),
        ]);
        setEngagements(e.items ?? []);
        setUsers(u.items ?? []);
        setTemplates(t.items ?? []);
      } catch {
        // Empty lists surface a helpful error on submit.
      }
    })();
  }, [composing, engagements.length, clientId]);

  return (
    <div style={{ display: 'grid', gap: tokens.space.md }}>
      <Card
        title="Requests"
        action={
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              style={{
                padding: '6px 8px',
                fontSize: 12,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm,
                background: tokens.color.surface,
                color: tokens.color.text,
              }}
            >
              <option value="OPEN_ONLY">Open only</option>
              <option value="ALL">All</option>
              <option value="FULFILLED">Fulfilled</option>
              <option value="DISMISSED">Dismissed</option>
            </select>
            <Button
              size="sm"
              variant={composing ? 'ghost' : 'secondary'}
              onClick={() => setComposing((v) => !v)}
            >
              {composing ? 'Cancel' : '+ New request'}
            </Button>
          </div>
        }
      >
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
            {error}
          </p>
        )}
        {composing && (
          <NewRequestForm
            engagements={engagements}
            users={users}
            templates={templates}
            onCancel={() => setComposing(false)}
            onCreated={(requestId) => {
              setComposing(false);
              void load();
              navigate(`/requests/${requestId}`);
            }}
            onError={setError}
          />
        )}
        {rows == null ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
        ) : rows.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
            No {statusFilter === 'OPEN_ONLY' ? 'open ' : ''}requests for this client. Click{' '}
            <strong>+ New request</strong> to ask the client for documents, answers, or signatures.
            For richer templates and bulk-send, use the top-level <strong>Requests</strong> page.
          </p>
        ) : (
          <Table<RequestRow>
            columns={[
              {
                key: 'title',
                header: 'Title',
                render: (r) => (
                  <button
                    type="button"
                    onClick={() => navigate(`/requests/${r.id}`)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: tokens.color.accent,
                      padding: 0,
                      cursor: 'pointer',
                      textAlign: 'left',
                      fontSize: 13,
                    }}
                  >
                    {r.title}
                  </button>
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
              {
                key: 'due',
                header: 'Due',
                render: (r) =>
                  r.dueDate ? (
                    new Date(r.dueDate).toLocaleDateString()
                  ) : (
                    <span style={{ color: tokens.color.textMuted, fontSize: 12 }}>—</span>
                  ),
              },
              {
                key: 'created',
                header: 'Created',
                render: (r) => new Date(r.createdAt).toLocaleDateString(),
              },
            ]}
            rows={rows}
            rowKey={(r) => r.id}
            empty=""
          />
        )}
      </Card>
    </div>
  );
}

interface NewRequestFormProps {
  clientId: string;
  engagements: EngagementOption[];
  users: FirmUser[];
  templates: RequestTemplate[];
  onCancel: () => void;
  onCreated: (requestId: string) => void;
  onError: (msg: string) => void;
}

function NewRequestForm({
  engagements,
  users,
  templates,
  onCancel,
  onCreated,
  onError,
}: Omit<NewRequestFormProps, 'clientId'>): JSX.Element {
  // Default-select the first active engagement so the common path is a
  // one-click submit.
  const firstActive = engagements.find((e) => e.status === 'ACTIVE') ?? engagements[0];
  const [engagementId, setEngagementId] = useState<string>(firstActive?.id ?? '');
  const [templateId, setTemplateId] = useState<string>('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<Priority>('MEDIUM');
  const [dueDate, setDueDate] = useState('');
  const [assignee, setAssignee] = useState<string>('');
  const [items, setItems] = useState<ChecklistItemDraft[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!engagementId && firstActive) setEngagementId(firstActive.id);
  }, [engagementId, firstActive]);

  // Template picker prefills title (template name) + items checklist.
  // The user can still edit any of it before submitting; explicit
  // fields override template defaults server-side.
  function applyTemplate(id: string): void {
    setTemplateId(id);
    if (!id) {
      setItems([]);
      return;
    }
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    if (!title.trim()) setTitle(t.name);
    setItems(
      t.items
        .slice()
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((it) => ({
          label: it.label,
          itemKind: it.itemKind,
          required: it.required,
          body: it.body ?? '',
        })),
    );
  }

  function addItem(kind: ItemKind): void {
    setItems((prev) => [...prev, { label: '', itemKind: kind, required: true, body: '' }]);
  }
  function updateItem<K extends keyof ChecklistItemDraft>(
    i: number,
    key: K,
    v: ChecklistItemDraft[K],
  ): void {
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, [key]: v } : it)));
  }
  function removeItem(i: number): void {
    setItems((prev) => prev.filter((_, idx) => idx !== i));
  }
  function moveItem(i: number, delta: number): void {
    setItems((prev) => {
      const j = i + delta;
      if (j < 0 || j >= prev.length) return prev;
      const next = prev.slice();
      const [moved] = next.splice(i, 1);
      next.splice(j, 0, moved!);
      return next;
    });
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!engagementId) {
      onError('Pick an engagement — requests attach to one engagement on this client.');
      return;
    }
    if (!title.trim() && !templateId) {
      onError('Title is required.');
      return;
    }
    const cleaned = items
      .map((it) => ({ ...it, label: it.label.trim(), body: it.body.trim() }))
      .filter((it) => it.label.length > 0);
    if (items.length > 0 && cleaned.length === 0) {
      onError('Each checklist item needs a label, or remove the empty rows.');
      return;
    }
    setBusy(true);
    try {
      const body_: Record<string, unknown> = {
        engagementId,
        title: title.trim() || undefined,
        body: body.trim(),
        priority,
      };
      if (templateId) body_['templateId'] = templateId;
      if (dueDate) body_['dueDate'] = dueDate;
      if (assignee) body_['assignedAppUserId'] = assignee;
      if (cleaned.length > 0) {
        body_['items'] = cleaned.map((it, idx) => ({
          ordinal: idx,
          label: it.label,
          body: it.body || undefined,
          itemKind: it.itemKind,
          required: it.required,
        }));
      }
      const r = await api<{ id?: string }>('/api/staff/requests', {
        method: 'POST',
        body: JSON.stringify(body_),
      });
      if (r.id) onCreated(r.id);
      else onCancel();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'create_failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      style={{
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.sm,
        padding: 12,
        marginBottom: 8,
        background: tokens.color.surface,
        display: 'grid',
        gap: 10,
      }}
    >
      {templates.length > 0 && (
        <div style={{ display: 'grid', gap: 4 }}>
          <label style={{ fontSize: 11, color: tokens.color.textMuted }}>
            Start from template (optional — prefills title + checklist)
          </label>
          <select
            value={templateId}
            onChange={(e) => applyTemplate(e.target.value)}
            style={selectStyle()}
          >
            <option value="">— blank request —</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.items.length} item{t.items.length === 1 ? '' : 's'})
              </option>
            ))}
          </select>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div style={{ display: 'grid', gap: 4 }}>
          <label style={{ fontSize: 11, color: tokens.color.textMuted }}>Engagement</label>
          <select
            value={engagementId}
            onChange={(e) => setEngagementId(e.target.value)}
            style={selectStyle()}
          >
            <option value="">Select…</option>
            {engagements.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} {e.status !== 'ACTIVE' ? `(${e.status})` : ''}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: 'grid', gap: 4 }}>
          <label style={{ fontSize: 11, color: tokens.color.textMuted }}>
            Assign to (optional)
          </label>
          <select
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            style={selectStyle()}
          >
            <option value="">— unassigned —</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.fullName}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div style={{ display: 'grid', gap: 4 }}>
        <label style={{ fontSize: 11, color: tokens.color.textMuted }}>Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What do you need from the client?"
          style={inputStyle()}
        />
      </div>
      <div style={{ display: 'grid', gap: 4 }}>
        <label style={{ fontSize: 11, color: tokens.color.textMuted }}>Details (optional)</label>
        <textarea
          rows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Context, links, instructions"
          style={{ ...inputStyle(), resize: 'vertical' }}
        />
      </div>

      <fieldset
        style={{
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.sm,
          padding: 10,
          display: 'grid',
          gap: 8,
          background: tokens.color.bg,
        }}
      >
        <legend
          style={{
            padding: '0 6px',
            fontSize: 11,
            color: tokens.color.textMuted,
            textTransform: 'uppercase',
            letterSpacing: 0.4,
          }}
        >
          Checklist items ({items.length})
        </legend>
        <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
          Each item appears as a separate row in the client portal. Document items let the client
          upload files; question items capture a typed answer; signature items capture an
          attestation. Without items, the request is a single open ask the client marks fulfilled.
        </p>
        {items.length > 0 && (
          <div style={{ display: 'grid', gap: 6 }}>
            {items.map((it, i) => (
              <div
                key={i}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'auto 1fr 160px auto auto',
                  gap: 6,
                  alignItems: 'center',
                  padding: 6,
                  borderRadius: tokens.radius.sm,
                  background: tokens.color.surface,
                }}
              >
                <span
                  style={{
                    width: 18,
                    textAlign: 'right',
                    color: tokens.color.textMuted,
                    fontSize: 11,
                  }}
                >
                  {i + 1}.
                </span>
                <input
                  type="text"
                  value={it.label}
                  onChange={(e) => updateItem(i, 'label', e.target.value)}
                  placeholder={
                    it.itemKind === 'DOCUMENT'
                      ? 'e.g. 2024 W-2 (PDF)'
                      : it.itemKind === 'SIGNATURE'
                        ? 'e.g. Engagement letter signature'
                        : 'e.g. Did you receive any K-1s in 2024?'
                  }
                  style={inputStyle()}
                />
                <select
                  value={it.itemKind}
                  onChange={(e) => updateItem(i, 'itemKind', e.target.value as ItemKind)}
                  style={selectStyle()}
                >
                  {ITEM_KIND_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 11 }}>
                  <input
                    type="checkbox"
                    checked={it.required}
                    onChange={(e) => updateItem(i, 'required', e.target.checked)}
                  />
                  required
                </label>
                <div style={{ display: 'flex', gap: 2 }}>
                  <button
                    type="button"
                    onClick={() => moveItem(i, -1)}
                    disabled={i === 0}
                    title="Move up"
                    style={iconBtnStyle()}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => moveItem(i, +1)}
                    disabled={i === items.length - 1}
                    title="Move down"
                    style={iconBtnStyle()}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => removeItem(i)}
                    title="Remove"
                    style={{ ...iconBtnStyle(), color: tokens.color.danger }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Button type="button" size="sm" variant="ghost" onClick={() => addItem('DOCUMENT')}>
            + Document
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => addItem('QUESTION')}>
            + Question
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => addItem('SIGNATURE')}>
            + Signature
          </Button>
        </div>
      </fieldset>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div style={{ display: 'grid', gap: 4 }}>
          <label style={{ fontSize: 11, color: tokens.color.textMuted }}>Priority</label>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as Priority)}
            style={selectStyle()}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: 'grid', gap: 4 }}>
          <label style={{ fontSize: 11, color: tokens.color.textMuted }}>Due (optional)</label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            style={inputStyle()}
          />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button type="submit" size="sm" disabled={busy || !engagementId || !title.trim()}>
          {busy ? 'Creating…' : 'Create request'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function inputStyle(): React.CSSProperties {
  return {
    padding: '8px 10px',
    fontSize: 13,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.sm,
    background: tokens.color.bg,
    color: tokens.color.text,
  };
}
function selectStyle(): React.CSSProperties {
  return { ...inputStyle() };
}
function iconBtnStyle(): React.CSSProperties {
  return {
    background: 'none',
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.sm,
    padding: '2px 6px',
    fontSize: 12,
    cursor: 'pointer',
    color: tokens.color.text,
  };
}
