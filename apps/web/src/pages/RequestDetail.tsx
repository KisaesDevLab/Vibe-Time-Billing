// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Staff Request detail page — 0084. Header card with status / priority
// / due / assigned + re-attach engagement combobox. Tabs:
//   Items — per-item fulfill / dismiss + add item.
//   Activity — quick view of fulfilled / dismissed metadata.
// Plus a Reply pane that POSTs needs-info to flip the request back to
// NEEDS_INFO with a typed comment.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { Button, Card, Combobox, Pill, Tabs, tokens, type ComboboxOption } from '@vibe/ui';

import { api } from '../api-client';
import { uploadOneClientFile } from '../lib/client-files-upload';

type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

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
  reminderDaysBefore: number | null;
  clientReplyText: string | null;
  activationDate: string | null;
}

interface RequestItem {
  id: string;
  ordinal: number;
  label: string;
  body: string;
  itemKind: 'QUESTION' | 'DOCUMENT' | 'SIGNATURE';
  required: boolean;
  status: string;
  dueDate: string | null;
  fulfilledAt: string | null;
  fulfilledText: string | null;
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

function statusTone(s: string): 'success' | 'warning' | 'neutral' | 'accent' {
  switch (s) {
    case 'FULFILLED':
      return 'success';
    case 'OPEN':
      return 'warning';
    case 'NEEDS_INFO':
      return 'accent';
    default:
      return 'neutral';
  }
}

export function RequestDetailPage(): JSX.Element {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const id = params.id ?? '';
  const [request, setRequest] = useState<RequestRow | null>(null);
  const [clientName, setClientName] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [items, setItems] = useState<RequestItem[]>([]);
  const [engagements, setEngagements] = useState<EngagementLite[]>([]);
  const [users, setUsers] = useState<FirmUser[]>([]);
  const [tab, setTab] = useState<'items' | 'activity'>('items');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newItemLabel, setNewItemLabel] = useState('');
  const [needsInfoText, setNeedsInfoText] = useState('');
  const [showNeedsInfo, setShowNeedsInfo] = useState(false);
  const [reassignEng, setReassignEng] = useState('');
  const [reassignUser, setReassignUser] = useState('');
  // Full edit mode for the request's core fields.
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editBody, setEditBody] = useState('');
  const [editPriority, setEditPriority] = useState<Priority>('MEDIUM');
  const [editStatus, setEditStatus] = useState<string>('OPEN');
  const [editDue, setEditDue] = useState('');
  const [editReminder, setEditReminder] = useState('');
  const [editTags, setEditTags] = useState('');

  async function load(): Promise<void> {
    setError(null);
    try {
      const [detail, itemList] = await Promise.all([
        api<{ request: RequestRow; clientName?: string | null; clientId?: string | null }>(
          `/api/staff/requests/${id}`,
        ),
        api<{ items: RequestItem[] }>(`/api/staff/requests/${id}/items`).catch(() => ({
          items: [] as RequestItem[],
        })),
      ]);
      setRequest(detail.request);
      setClientName(detail.clientName ?? null);
      setClientId(detail.clientId ?? null);
      setItems(itemList.items ?? []);
      setReassignEng(detail.request.engagementId);
      setReassignUser(detail.request.assignedAppUserId ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load_failed');
    }
  }

  async function loadRef(): Promise<void> {
    try {
      const [eng, u] = await Promise.all([
        api<{ items: EngagementLite[] }>('/api/staff/engagements/picker').catch(() => ({
          items: [] as EngagementLite[],
        })),
        api<{ items: FirmUser[] }>('/api/staff/firm-users').catch(() => ({
          items: [] as FirmUser[],
        })),
      ]);
      setEngagements(eng.items ?? []);
      setUsers(u.items ?? []);
    } catch {
      // optional
    }
  }

  useEffect(() => {
    if (id) void load();
    void loadRef();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function patchRequest(body: Record<string, unknown>): Promise<void> {
    await api(`/api/staff/requests/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  function startEdit(): void {
    if (!request) return;
    setEditTitle(request.title);
    setEditBody(request.body ?? '');
    setEditPriority(request.priority);
    setEditStatus(request.status);
    setEditDue(request.dueDate ?? '');
    setEditReminder(request.reminderDaysBefore != null ? String(request.reminderDaysBefore) : '');
    setEditTags(request.tags.join(', '));
    setEditing(true);
  }

  async function saveEdit(): Promise<void> {
    if (!editTitle.trim()) {
      setError('Title is required.');
      return;
    }
    setBusy('edit');
    setError(null);
    try {
      await patchRequest({
        title: editTitle.trim(),
        body: editBody,
        priority: editPriority,
        status: editStatus,
        dueDate: editDue || null,
        reminderDaysBefore: editReminder.trim() ? Number(editReminder) : null,
        tags: editTags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      });
      setEditing(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save_failed');
    } finally {
      setBusy(null);
    }
  }

  async function fulfillItem(itemId: string, fileId?: string): Promise<void> {
    setBusy(itemId);
    try {
      await api(`/api/staff/requests/${id}/items/${itemId}/fulfill`, {
        method: 'POST',
        body: JSON.stringify(fileId ? { fileId } : {}),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'fulfill_failed');
    } finally {
      setBusy(null);
    }
  }

  // DS-4 — drop a file from Explorer onto an item: it lands in the client's
  // File Manager (normal presigned upload) and fulfils the item with it.
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  async function dropOnItem(itemId: string, files: FileList | null): Promise<void> {
    setDropTarget(null);
    const file = files?.[0];
    if (!file || !clientId) return;
    setBusy(itemId);
    try {
      const { fileId } = await uploadOneClientFile(clientId, file, 'other');
      await fulfillItem(itemId, fileId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'upload_failed');
      setBusy(null);
    }
  }

  async function deleteItem(itemId: string): Promise<void> {
    if (!window.confirm('Remove this checklist item?')) return;
    setBusy(itemId);
    try {
      await api(`/api/staff/requests/${id}/items/${itemId}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'delete_failed');
    } finally {
      setBusy(null);
    }
  }

  async function addItem(): Promise<void> {
    if (!newItemLabel.trim()) return;
    setBusy('add');
    try {
      // Replace items endpoint expects the full set, so build current+new.
      const payload = [
        ...items.map((it) => ({
          ordinal: it.ordinal,
          label: it.label,
          body: it.body,
          itemKind: it.itemKind,
          required: it.required,
        })),
        {
          ordinal: items.length,
          label: newItemLabel.trim(),
          body: '',
          itemKind: 'QUESTION' as const,
          required: true,
        },
      ];
      // The staff route exposes per-item PATCH but not bulk-add — issue
      // a fresh PATCH on each ordinal mismatch isn't ideal. Instead use
      // the dedicated /items endpoint if available; otherwise fall back
      // by creating via the dedicated item-create path. The current
      // backend exposes POST /:id/items as a *replace* operation when
      // the schema validator accepts the array shape. Until a true
      // append endpoint lands, we use replace semantics.
      await api(`/api/staff/requests/${id}/items`, {
        method: 'POST',
        body: JSON.stringify({ items: payload }),
      });
      setNewItemLabel('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'add_item_failed');
    } finally {
      setBusy(null);
    }
  }

  async function dismissReq(): Promise<void> {
    const reason = window.prompt('Reason for dismissing?') ?? '';
    if (!reason) return;
    setBusy('dismiss');
    try {
      await api(`/api/staff/requests/${id}/dismiss`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'dismiss_failed');
    } finally {
      setBusy(null);
    }
  }

  async function reopen(): Promise<void> {
    setBusy('reopen');
    try {
      await api(`/api/staff/requests/${id}/reopen`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'reopen_failed');
    } finally {
      setBusy(null);
    }
  }

  async function activateRequest(): Promise<void> {
    if (!window.confirm('Open this request now and make it visible to the client?')) return;
    setBusy('activate');
    try {
      await api(`/api/staff/requests/${id}/activate`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'activate_failed');
    } finally {
      setBusy(null);
    }
  }

  async function fulfillRequest(): Promise<void> {
    setBusy('fulfill');
    try {
      await api(`/api/staff/requests/${id}/fulfill`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'fulfill_failed');
    } finally {
      setBusy(null);
    }
  }

  async function submitNeedsInfo(): Promise<void> {
    if (!needsInfoText.trim()) return;
    setBusy('needs-info');
    try {
      await api(`/api/staff/requests/${id}/needs-info`, {
        method: 'POST',
        body: JSON.stringify({ text: needsInfoText.trim() }),
      });
      setNeedsInfoText('');
      setShowNeedsInfo(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'needs_info_failed');
    } finally {
      setBusy(null);
    }
  }

  // Only the request's client's engagements (fall back to all if the client
  // isn't resolved yet).
  const engOptions: ComboboxOption[] = useMemo(
    () =>
      engagements
        .filter((e) => !clientId || e.clientId === clientId)
        .map((e) => ({ value: e.id, label: e.name })),
    [engagements, clientId],
  );
  const userOptions: ComboboxOption[] = useMemo(
    () => users.map((u) => ({ value: u.id, label: u.fullName })),
    [users],
  );

  if (!request) {
    return (
      <Card>
        <p style={{ fontSize: 13 }}>{error ?? 'Loading…'}</p>
      </Card>
    );
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg }}>
      <div>
        <Button variant="ghost" onClick={() => navigate('/requests')}>
          ← Back to requests
        </Button>
      </div>

      {error && (
        <Card>
          <p style={{ color: tokens.color.danger, fontSize: 13, margin: 0 }}>{error}</p>
        </Card>
      )}

      <Card>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'start',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: 18 }}>{request.title}</h2>
            {clientName && (
              <div style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 2 }}>
                {clientId ? <a href={`/clients/${clientId}`}>{clientName}</a> : clientName}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
              <Pill tone={statusTone(request.status)}>
                {request.status === 'PENDING' ? 'SCHEDULED' : request.status}
              </Pill>
              {request.status === 'PENDING' && request.activationDate && (
                <Pill tone="warning">opens {request.activationDate}</Pill>
              )}
              <Pill tone={priorityTone(request.priority)}>{request.priority}</Pill>
              {request.dueDate && <Pill tone="neutral">due {request.dueDate}</Pill>}
              {request.reminderDaysBefore != null && (
                <Pill tone="neutral">remind {request.reminderDaysBefore}d before</Pill>
              )}
              {request.tags.map((t) => (
                <Pill key={t}>{t}</Pill>
              ))}
            </div>
            {request.body && (
              <p style={{ fontSize: 13, marginTop: 12, whiteSpace: 'pre-wrap' }}>{request.body}</p>
            )}
            {request.clientReplyText && (
              <div
                style={{
                  marginTop: 12,
                  padding: 10,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.md,
                  background: tokens.color.surface,
                }}
              >
                <div style={{ fontSize: 11, color: tokens.color.textMuted }}>Last client reply</div>
                <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>
                  {request.clientReplyText}
                </div>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6, flexDirection: 'column' }}>
            {!editing && (
              <Button variant="secondary" onClick={startEdit}>
                Edit
              </Button>
            )}
            {request.status === 'PENDING' && (
              <Button onClick={() => void activateRequest()} disabled={busy != null}>
                Activate now
              </Button>
            )}
            {request.status === 'OPEN' && (
              <>
                <Button onClick={() => void fulfillRequest()} disabled={busy != null}>
                  Mark fulfilled
                </Button>
                <Button variant="secondary" onClick={() => setShowNeedsInfo((v) => !v)}>
                  Needs info
                </Button>
                <Button variant="ghost" onClick={() => void dismissReq()}>
                  Dismiss
                </Button>
              </>
            )}
            {request.status === 'NEEDS_INFO' && (
              <Button onClick={() => void reopen()}>Reopen</Button>
            )}
            {(request.status === 'FULFILLED' || request.status === 'DISMISSED') && (
              <Button variant="secondary" onClick={() => void reopen()}>
                Reopen
              </Button>
            )}
          </div>
        </div>

        {editing && (
          <div
            style={{
              marginTop: 12,
              padding: 12,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.md,
              display: 'grid',
              gap: 8,
            }}
          >
            <label style={{ fontSize: 12 }}>
              Title
              <input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                maxLength={200}
                style={{ width: '100%', padding: 6, marginTop: 4 }}
              />
            </label>
            <label style={{ fontSize: 12 }}>
              Description
              <textarea
                value={editBody}
                onChange={(e) => setEditBody(e.target.value)}
                rows={4}
                style={{ width: '100%', padding: 6, marginTop: 4, fontFamily: 'inherit' }}
              />
            </label>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <label style={{ fontSize: 12 }}>
                Priority
                <select
                  value={editPriority}
                  onChange={(e) => setEditPriority(e.target.value as Priority)}
                  style={{ display: 'block', padding: 6, marginTop: 4 }}
                >
                  {(['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as Priority[]).map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ fontSize: 12 }}>
                Status
                <select
                  value={editStatus}
                  onChange={(e) => setEditStatus(e.target.value)}
                  style={{ display: 'block', padding: 6, marginTop: 4 }}
                >
                  {['OPEN', 'PENDING', 'NEEDS_INFO', 'FULFILLED', 'DISMISSED', 'EXPIRED'].map(
                    (s) => (
                      <option key={s} value={s}>
                        {s === 'PENDING' ? 'PENDING (scheduled)' : s}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <label style={{ fontSize: 12 }}>
                Due date
                <input
                  type="date"
                  value={editDue}
                  onChange={(e) => setEditDue(e.target.value)}
                  style={{ display: 'block', padding: 6, marginTop: 4 }}
                />
              </label>
              <label style={{ fontSize: 12 }}>
                Remind (days before)
                <input
                  type="number"
                  min={0}
                  max={365}
                  value={editReminder}
                  onChange={(e) => setEditReminder(e.target.value)}
                  style={{ display: 'block', padding: 6, marginTop: 4, width: 100 }}
                />
              </label>
            </div>
            <label style={{ fontSize: 12 }}>
              Tags (comma-separated)
              <input
                value={editTags}
                onChange={(e) => setEditTags(e.target.value)}
                style={{ width: '100%', padding: 6, marginTop: 4 }}
              />
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              <Button onClick={() => void saveEdit()} disabled={busy === 'edit'}>
                {busy === 'edit' ? 'Saving…' : 'Save changes'}
              </Button>
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {showNeedsInfo && (
          <div
            style={{
              marginTop: 12,
              padding: 10,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.md,
            }}
          >
            <label style={{ fontSize: 12 }}>
              Tell the client what&apos;s needed:
              <textarea
                value={needsInfoText}
                onChange={(e) => setNeedsInfoText(e.target.value)}
                rows={3}
                style={{ width: '100%', padding: tokens.space.sm, marginTop: 4 }}
              />
            </label>
            <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
              <Button onClick={() => void submitNeedsInfo()} disabled={busy === 'needs-info'}>
                {busy === 'needs-info' ? 'Sending…' : 'Send'}
              </Button>
              <Button variant="ghost" onClick={() => setShowNeedsInfo(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        <div
          style={{
            marginTop: 16,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))',
            gap: tokens.space.sm,
          }}
        >
          <div style={{ fontSize: 12 }}>
            <div style={{ marginBottom: 4 }}>Engagement</div>
            <Combobox
              ariaLabel="Engagement"
              options={engOptions}
              value={reassignEng}
              onChange={async (v) => {
                setReassignEng(v);
                try {
                  await patchRequest({ engagementId: v });
                  await load();
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'patch_failed');
                }
              }}
            />
          </div>
          <div style={{ fontSize: 12 }}>
            <div style={{ marginBottom: 4 }}>Assigned to</div>
            <Combobox
              ariaLabel="Assigned to"
              options={[{ value: '', label: 'Nobody' }, ...userOptions]}
              value={reassignUser}
              onChange={async (v) => {
                setReassignUser(v);
                try {
                  await patchRequest({ assignedAppUserId: v || null });
                  await load();
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'patch_failed');
                }
              }}
              clearable
            />
          </div>
        </div>
      </Card>

      <Tabs
        tabs={[
          { key: 'items', label: `Items (${items.length})` },
          { key: 'activity', label: 'Activity' },
        ]}
        active={tab}
        onChange={(k) => setTab(k as 'items' | 'activity')}
      />

      {tab === 'items' && (
        <Card title="Checklist">
          {items.length === 0 ? (
            <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No items on this request.</p>
          ) : (
            <div style={{ display: 'grid', gap: 6 }}>
              {items.map((it) => (
                <div
                  key={it.id}
                  onDragOver={(e) => {
                    if (it.status === 'FULFILLED' || !clientId) return;
                    if (Array.from(e.dataTransfer.types).includes('Files')) {
                      e.preventDefault();
                      setDropTarget(it.id);
                    }
                  }}
                  onDragLeave={() => setDropTarget((t) => (t === it.id ? null : t))}
                  onDrop={(e) => {
                    if (it.status === 'FULFILLED' || !clientId) return;
                    e.preventDefault();
                    void dropOnItem(it.id, e.dataTransfer.files);
                  }}
                  title={
                    it.status !== 'FULFILLED' && clientId
                      ? 'Drop a file here to attach it and fulfil this item'
                      : undefined
                  }
                  style={{
                    padding: 10,
                    border: `1px ${dropTarget === it.id ? 'dashed' : 'solid'} ${
                      dropTarget === it.id ? tokens.color.accent : tokens.color.border
                    }`,
                    borderRadius: tokens.radius.md,
                    display: 'flex',
                    gap: 10,
                    alignItems: 'center',
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{it.label}</div>
                    {it.body && (
                      <div style={{ fontSize: 12, color: tokens.color.textMuted }}>{it.body}</div>
                    )}
                    {it.fulfilledText && (
                      <div style={{ fontSize: 12, color: tokens.color.success, marginTop: 4 }}>
                        Reply: {it.fulfilledText}
                      </div>
                    )}
                  </div>
                  <Pill>{it.itemKind}</Pill>
                  {it.required && <Pill tone="warning">required</Pill>}
                  <Pill tone={statusTone(it.status)}>{it.status}</Pill>
                  {it.status !== 'FULFILLED' && (
                    <Button
                      size="sm"
                      onClick={() => void fulfillItem(it.id)}
                      disabled={busy === it.id}
                    >
                      Fulfill
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void deleteItem(it.id)}
                    disabled={busy === it.id}
                    aria-label="Delete item"
                  >
                    ✕
                  </Button>
                </div>
              ))}
            </div>
          )}
          <div style={{ marginTop: 12, display: 'flex', gap: 6 }}>
            <input
              type="text"
              value={newItemLabel}
              onChange={(e) => setNewItemLabel(e.target.value)}
              placeholder="Add another item…"
              style={{ flex: 1, padding: tokens.space.sm }}
            />
            <Button
              onClick={() => void addItem()}
              disabled={busy === 'add' || !newItemLabel.trim()}
            >
              Add
            </Button>
          </div>
        </Card>
      )}

      {tab === 'activity' && (
        <Card title="Activity">
          <div style={{ fontSize: 13, display: 'grid', gap: 6 }}>
            <div>
              <strong>Created:</strong> {new Date(request.createdAt).toLocaleString()}
            </div>
            {request.fulfilledAt && (
              <div>
                <strong>Fulfilled:</strong> {new Date(request.fulfilledAt).toLocaleString()}
              </div>
            )}
            <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
              For full audit history use the admin audit log filtered by{' '}
              <code>client_request:{id}</code>.
            </p>
          </div>
        </Card>
      )}
    </div>
  );
}
