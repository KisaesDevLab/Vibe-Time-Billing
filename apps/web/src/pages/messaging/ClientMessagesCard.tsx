/* eslint-disable jsx-a11y/label-has-associated-control -- labels and controls are siblings inside grid containers; revisit with htmlFor/id pairs in a polish pass */
// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Client-scoped Messages view. Lists every thread for this client that
// the signed-in staff user is a member of — both client-direct threads
// and engagement-scoped ones. "New thread" opens a composer that lets
// the user pick (optionally) an engagement to link, which portal
// contacts to include, and write a first message.

import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Combobox, Input, Pill, tokens, type ComboboxOption } from '@vibe/ui';

import { api } from '../../api-client';

import { ThreadView } from './ThreadView';

interface ThreadRow {
  threadId: string;
  engagementId: string | null;
  title: string | null;
  status: string;
  updatedAt: string;
}

interface EngagementRow {
  id: string;
  name: string;
  status: string;
}

interface PortalAccessRow {
  id: string;
  portalIdentityId: string;
  fullName: string;
  primaryEmail: string | null;
  primaryPhone: string | null;
  status: 'INVITED' | 'ACTIVE' | 'INACTIVE';
}

export function ClientMessagesCard({ clientId }: { clientId: string }): JSX.Element {
  const [threads, setThreads] = useState<ThreadRow[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [engagements, setEngagements] = useState<EngagementRow[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: ThreadRow[] }>(
        `/api/staff/engagement-messaging/clients/${clientId}/threads`,
      );
      const items = r.items ?? [];
      setThreads(items);
      if (!activeId && items[0]) setActiveId(items[0].threadId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load_failed');
      setThreads([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: EngagementRow[] }>(
          `/api/staff/engagements?clientId=${clientId}`,
        );
        setEngagements((r.items ?? []).filter((e) => e.status !== 'ARCHIVED'));
      } catch {
        // Assign picker stays empty; threads still usable client-scoped.
      }
    })();
  }, [clientId]);

  const activeThread = threads?.find((t) => t.threadId === activeId) ?? null;

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg }}>
      {composing && (
        <NewThreadForm
          clientId={clientId}
          onCancel={() => setComposing(false)}
          onCreated={(threadId) => {
            setComposing(false);
            setActiveId(threadId);
            void load();
          }}
          onError={setError}
        />
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: tokens.space.lg }}>
        <Card
          title={`Threads${threads ? ` (${threads.length})` : ''}`}
          action={
            <Button
              size="sm"
              variant={composing ? 'ghost' : 'secondary'}
              onClick={() => setComposing((v) => !v)}
            >
              {composing ? 'Cancel' : '+ New thread'}
            </Button>
          }
        >
          {error && (
            <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
              {error}
            </p>
          )}
          {threads == null ? (
            <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>
          ) : threads.length === 0 ? (
            <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
              No threads yet for this client. Click <strong>+ New thread</strong> to start one.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {threads.map((t) => {
                const isActive = activeId === t.threadId;
                return (
                  <button
                    key={t.threadId}
                    type="button"
                    onClick={() => setActiveId(t.threadId)}
                    style={{
                      textAlign: 'left',
                      padding: '8px 10px',
                      borderRadius: tokens.radius.sm,
                      background: isActive ? tokens.color.accentMuted : 'transparent',
                      color: isActive ? tokens.color.accent : tokens.color.text,
                      border: 'none',
                      cursor: 'pointer',
                      fontSize: 13,
                      display: 'grid',
                      gap: 2,
                    }}
                  >
                    <div style={{ fontWeight: 500 }}>{t.title ?? 'Untitled thread'}</div>
                    <div
                      style={{
                        fontSize: 11,
                        color: tokens.color.textMuted,
                        display: 'flex',
                        gap: 6,
                        alignItems: 'center',
                      }}
                    >
                      {t.status === 'ARCHIVED' && <Pill tone="neutral">Archived</Pill>}
                      {t.engagementId ? <Pill tone="accent">Engagement</Pill> : <Pill>Client</Pill>}
                      <span>{new Date(t.updatedAt).toLocaleString()}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </Card>

        <Card
          title={activeId ? (activeThread?.title ?? 'Thread') : 'Pick or start a thread'}
          action={
            activeThread && !activeThread.engagementId ? (
              <AssignEngagement
                threadId={activeThread.threadId}
                engagements={engagements}
                onAssigned={() => void load()}
                onError={setError}
              />
            ) : activeThread?.engagementId ? (
              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <Pill tone="accent">Engagement</Pill>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (!confirm('Unlink this thread from its engagement?')) return;
                    void api(
                      `/api/staff/engagement-messaging/threads/${activeThread.threadId}/engagement`,
                      { method: 'DELETE' },
                    )
                      .then(() => void load())
                      .catch((e) => setError(e instanceof Error ? e.message : 'unassign_failed'));
                  }}
                >
                  Unassign
                </Button>
              </span>
            ) : null
          }
        >
          {activeId ? (
            <ThreadView threadId={activeId} embedded maxHeight={520} onSent={() => void load()} />
          ) : (
            <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
              Pick a thread on the left, or click <strong>+ New thread</strong> above to start one.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}

function AssignEngagement({
  threadId,
  engagements,
  onAssigned,
  onError,
}: {
  threadId: string;
  engagements: EngagementRow[];
  onAssigned: () => void;
  onError: (msg: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [engagementId, setEngagementId] = useState('');
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Assign to engagement
      </Button>
    );
  }

  async function assign(): Promise<void> {
    if (!engagementId) return;
    setBusy(true);
    onError('');
    try {
      await api(`/api/staff/engagement-messaging/threads/${threadId}/engagement`, {
        method: 'POST',
        body: JSON.stringify({ engagementId }),
      });
      setOpen(false);
      setEngagementId('');
      onAssigned();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'assign_failed';
      const friendly =
        msg === 'engagement_thread_exists'
          ? 'That engagement already has a thread.'
          : msg === 'thread_already_linked'
            ? 'This thread is already linked to an engagement.'
            : msg === 'engagement_client_mismatch'
              ? "That engagement doesn't belong to this client."
              : msg;
      onError(`Could not assign: ${friendly}`);
    } finally {
      setBusy(false);
    }
  }

  const options: ComboboxOption[] = [
    { value: '', label: '— Pick an engagement —' },
    ...engagements.map((e) => ({ value: e.id, label: e.name })),
  ];

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <div style={{ minWidth: 200 }}>
        <Combobox
          ariaLabel="Engagement to assign"
          value={engagementId}
          onChange={setEngagementId}
          options={options}
        />
      </div>
      <Button size="sm" onClick={() => void assign()} disabled={busy || !engagementId}>
        {busy ? 'Assigning…' : 'Assign'}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
        Cancel
      </Button>
    </div>
  );
}

interface NewThreadFormProps {
  clientId: string;
  onCancel: () => void;
  onCreated: (threadId: string) => void;
  onError: (msg: string) => void;
}

function NewThreadForm({
  clientId,
  onCancel,
  onCreated,
  onError,
}: NewThreadFormProps): JSX.Element {
  const [title, setTitle] = useState('');
  const [engagementId, setEngagementId] = useState('');
  const [body, setBody] = useState('');
  const [engagements, setEngagements] = useState<EngagementRow[]>([]);
  const [accesses, setAccesses] = useState<PortalAccessRow[]>([]);
  const [selectedIdentityIds, setSelectedIdentityIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [warn, setWarn] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: EngagementRow[] }>(
          `/api/staff/engagements?clientId=${clientId}`,
        );
        setEngagements((r.items ?? []).filter((e) => e.status !== 'ARCHIVED'));
      } catch {
        // Engagement picker stays empty — thread can still be created client-scoped.
      }
      try {
        const r = await api<{ accesses: PortalAccessRow[] }>(
          `/api/staff/portal-invites/by-client/${clientId}`,
        );
        const active = (r.accesses ?? []).filter((a) => a.status === 'ACTIVE');
        setAccesses(active);
        // Default: all active contacts pre-selected.
        setSelectedIdentityIds(new Set(active.map((a) => a.portalIdentityId)));
        if (active.length === 0) {
          setWarn(
            'This client has no active portal contacts yet. The thread will still be created but only you will see it until a contact is invited and accepts.',
          );
        }
      } catch {
        // Carry on.
      }
    })();
  }, [clientId]);

  function toggle(identityId: string): void {
    setSelectedIdentityIds((cur) => {
      const next = new Set(cur);
      if (next.has(identityId)) next.delete(identityId);
      else next.add(identityId);
      return next;
    });
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    onError('');
    try {
      const payload: Record<string, unknown> = {
        clientId,
      };
      if (title.trim()) payload['title'] = title.trim();
      if (engagementId) payload['engagementId'] = engagementId;
      if (body.trim()) payload['body'] = body.trim();
      if (accesses.length > 0) {
        payload['portalIdentityIds'] = Array.from(selectedIdentityIds);
      }
      const r = await api<{ threadId: string }>('/api/staff/engagement-messaging/threads', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      onCreated(r.threadId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'create_failed';
      const friendly =
        msg === 'engagement_thread_exists'
          ? 'That engagement already has a thread. Open it from the existing thread list or the engagement detail page.'
          : msg === 'engagement_client_mismatch'
            ? "The selected engagement doesn't belong to this client."
            : msg;
      onError(`Could not create thread: ${friendly}`);
    } finally {
      setSubmitting(false);
    }
  }

  const engagementOptions: ComboboxOption[] = [
    { value: '', label: '— No engagement (client-level thread) —' },
    ...engagements.map((e) => ({ value: e.id, label: e.name })),
  ];

  return (
    <Card title="New message thread">
      <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        <Input
          label="Title (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What is this conversation about?"
        />
        <div>
          <label
            style={{
              fontSize: 11,
              color: tokens.color.textMuted,
              display: 'block',
              marginBottom: 4,
            }}
          >
            Associate with engagement (optional)
          </label>
          <Combobox
            ariaLabel="Engagement"
            value={engagementId}
            onChange={setEngagementId}
            options={engagementOptions}
          />
          <p style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 4 }}>
            Leave blank for a general client conversation. Each engagement can only have one thread
            — if you pick one that already has a thread you&apos;ll get an error.
          </p>
        </div>

        <div>
          <div
            style={{
              fontSize: 12,
              color: tokens.color.textMuted,
              marginBottom: 6,
              display: 'flex',
              justifyContent: 'space-between',
            }}
          >
            <span>Portal contacts to include (you&apos;re always included)</span>
            {accesses.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  setSelectedIdentityIds(
                    selectedIdentityIds.size === accesses.length
                      ? new Set()
                      : new Set(accesses.map((a) => a.portalIdentityId)),
                  )
                }
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: tokens.color.accent,
                  cursor: 'pointer',
                  fontSize: 12,
                  padding: 0,
                }}
              >
                {selectedIdentityIds.size === accesses.length ? 'Deselect all' : 'Select all'}
              </button>
            )}
          </div>
          {accesses.length === 0 ? (
            <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
              No active portal contacts yet.
            </p>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                gap: 6,
                background: tokens.color.surface,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm,
                padding: 8,
              }}
            >
              {accesses.map((a) => (
                <label
                  key={a.portalIdentityId}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedIdentityIds.has(a.portalIdentityId)}
                    onChange={() => toggle(a.portalIdentityId)}
                  />
                  <span style={{ fontWeight: 500 }}>{a.fullName}</span>
                  <span style={{ color: tokens.color.textMuted }}>
                    {a.primaryEmail ?? a.primaryPhone ?? ''}
                  </span>
                </label>
              ))}
            </div>
          )}
          {warn && (
            <p style={{ fontSize: 11, color: tokens.color.warning, marginTop: 4 }}>{warn}</p>
          )}
        </div>

        <div>
          <label
            style={{
              fontSize: 11,
              color: tokens.color.textMuted,
              display: 'block',
              marginBottom: 4,
            }}
          >
            First message (optional)
          </label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            placeholder="Hi! We're getting started on …"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: tokens.space.sm,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
              background: tokens.color.surface,
              color: tokens.color.text,
              fontSize: 13,
              fontFamily: tokens.font.body,
              resize: 'vertical',
            }}
          />
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create thread'}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
