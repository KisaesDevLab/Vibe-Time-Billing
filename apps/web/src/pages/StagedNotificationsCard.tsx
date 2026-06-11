// SPDX-License-Identifier: Elastic-2.0
//
// 0146 — staged client-notification queue, rendered on /approvals for
// staff with notification:approve. Filter pills (pending / scheduled /
// failed / sent / canceled), checkbox bulk selection with a Send now /
// Schedule… / Cancel toolbar, per-row expandable per-channel message
// preview (the snapshot the worker will send verbatim), and a shared
// datetime-local schedule modal for single + bulk.

import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button, Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface StagedItem {
  id: string;
  clientId: string;
  clientName: string;
  entityType: string;
  entityId: string;
  engagementName: string | null;
  triggerKind: string;
  triggerContext: { workflowState?: string; fromState?: string | null; statusLabel?: string };
  mode: 'IMMEDIATE' | 'STAGED';
  status: 'PENDING_APPROVAL' | 'SCHEDULED' | 'SENT' | 'CANCELED' | 'FAILED';
  channels: string[];
  recipientMode: string;
  recipients: Array<{ personId: string; name: string; email: string | null; phone: string | null }>;
  rendered: Record<string, { subject: string | null; body: string } | undefined>;
  scheduledAt: string | null;
  sentAt: string | null;
  canceledReason: string | null;
  channelResults: Record<string, { ok: boolean; sentTo: string[]; error?: string }> | null;
  errorMessage: string | null;
  createdAt: string;
  createdByName: string | null;
}

type Filter = 'ACTIVE' | 'PENDING_APPROVAL' | 'SCHEDULED' | 'FAILED' | 'SENT' | 'CANCELED';

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'ACTIVE', label: 'Queue' },
  { key: 'PENDING_APPROVAL', label: 'Pending approval' },
  { key: 'SCHEDULED', label: 'Scheduled' },
  { key: 'FAILED', label: 'Failed' },
  { key: 'SENT', label: 'Sent' },
  { key: 'CANCELED', label: 'Canceled' },
];

function statusTone(
  s: StagedItem['status'],
): 'accent' | 'warning' | 'success' | 'danger' | 'neutral' {
  switch (s) {
    case 'PENDING_APPROVAL':
      return 'warning';
    case 'SCHEDULED':
      return 'accent';
    case 'SENT':
      return 'success';
    case 'FAILED':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function StagedNotificationsCard(): JSX.Element {
  const [items, setItems] = useState<StagedItem[]>([]);
  const [filter, setFilter] = useState<Filter>('ACTIVE');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Schedule modal target: list of ids it will apply to (empty = closed).
  const [scheduleIds, setScheduleIds] = useState<string[]>([]);
  const [scheduleAt, setScheduleAt] = useState('');

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const qs = filter === 'ACTIVE' ? '' : `?status=${filter}`;
      const r = await api<{ items: StagedItem[] }>(`/api/staff/staged-notifications${qs}`);
      setItems(r.items ?? []);
      setSelected(new Set());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  // Only unsent rows can be acted on (FAILED supports retry-as-send-now).
  const actionable = useMemo(
    () =>
      new Set(items.filter((i) => i.status !== 'SENT' && i.status !== 'CANCELED').map((i) => i.id)),
    [items],
  );

  function toggleRow(id: string): void {
    if (!actionable.has(id)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allSelectable = useMemo(
    () => items.filter((i) => actionable.has(i.id)),
    [items, actionable],
  );
  const allSelected = selected.size > 0 && selected.size === allSelectable.length;

  function toggleAll(): void {
    setSelected(allSelected ? new Set() : new Set(allSelectable.map((i) => i.id)));
  }

  async function act(
    ids: string[],
    action: 'SEND_NOW' | 'SCHEDULE' | 'CANCEL',
    scheduledAt?: string,
  ): Promise<void> {
    if (ids.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      if (ids.length === 1 && action !== 'SCHEDULE') {
        const path = action === 'SEND_NOW' ? 'send-now' : 'cancel';
        await api(`/api/staff/staged-notifications/${ids[0]}/${path}`, { method: 'POST' });
      } else if (ids.length === 1 && action === 'SCHEDULE') {
        await api(`/api/staff/staged-notifications/${ids[0]}/schedule`, {
          method: 'POST',
          body: JSON.stringify({ scheduledAt }),
        });
      } else {
        await api('/api/staff/staged-notifications/bulk', {
          method: 'POST',
          body: JSON.stringify({ ids, action, ...(scheduledAt ? { scheduledAt } : {}) }),
        });
      }
      setScheduleIds([]);
      setScheduleAt('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  function submitSchedule(): void {
    if (!scheduleAt) return;
    const iso = new Date(scheduleAt).toISOString();
    void act(scheduleIds, 'SCHEDULE', iso);
  }

  return (
    <Card title="Client notifications">
      <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: '0 0 12px' }}>
        Status-change notifications staged for review. Send now, schedule for later, or cancel —
        individually or in bulk. Every outcome is logged to the client&apos;s communication
        timeline.
      </p>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            style={{
              padding: '4px 10px',
              fontSize: 12,
              borderRadius: 999,
              cursor: 'pointer',
              border: `1px solid ${tokens.color.border}`,
              background: filter === f.key ? tokens.color.accentMuted : 'transparent',
              fontWeight: filter === f.key ? 600 : 400,
              color: tokens.color.text,
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}

      {selected.size > 0 && (
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
            {selected.size} notification{selected.size === 1 ? '' : 's'} selected
          </span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <Button size="sm" disabled={busy} onClick={() => void act([...selected], 'SEND_NOW')}>
              Send now
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => setScheduleIds([...selected])}
            >
              Schedule…
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={() => void act([...selected], 'CANCEL')}
            >
              Cancel selected
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setSelected(new Set())}
            >
              Clear
            </Button>
          </span>
        </div>
      )}

      {loading ? (
        <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
      ) : (
        <Table<StagedItem>
          columns={[
            {
              key: 'select',
              header: (
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={allSelected}
                  onChange={toggleAll}
                />
              ),
              render: (r) =>
                actionable.has(r.id) ? (
                  <input
                    type="checkbox"
                    checked={selected.has(r.id)}
                    aria-label={`Select notification for ${r.clientName}`}
                    onChange={() => toggleRow(r.id)}
                  />
                ) : (
                  <span />
                ),
            },
            { key: 'client', header: 'Client', render: (r) => r.clientName },
            {
              key: 'about',
              header: 'About',
              render: (r) => (
                <span style={{ fontSize: 13 }}>
                  {r.engagementName ?? r.entityType}
                  {r.triggerContext.statusLabel && (
                    <span style={{ color: tokens.color.textMuted }}>
                      {' → '}
                      {r.triggerContext.statusLabel}
                    </span>
                  )}
                </span>
              ),
            },
            {
              key: 'channels',
              header: 'Methods',
              render: (r) => (
                <span style={{ display: 'flex', gap: 4 }}>
                  {r.channels.map((c) => (
                    <Pill key={c} tone="neutral">
                      {c.toLowerCase()}
                    </Pill>
                  ))}
                </span>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              render: (r) => (
                <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <Pill tone={statusTone(r.status)}>
                    {r.status.replace('_', ' ').toLowerCase()}
                  </Pill>
                  {r.status === 'SCHEDULED' && r.scheduledAt && (
                    <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                      {new Date(r.scheduledAt).toLocaleString()}
                    </span>
                  )}
                </span>
              ),
            },
            {
              key: 'actions',
              header: '',
              align: 'right',
              render: (r) => (
                <span style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}
                  >
                    {expandedId === r.id ? 'Hide' : 'Preview'}
                  </Button>
                  {actionable.has(r.id) && (
                    <>
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => void act([r.id], 'SEND_NOW')}
                      >
                        {r.status === 'FAILED' ? 'Retry' : 'Send now'}
                      </Button>
                      {r.status !== 'FAILED' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => setScheduleIds([r.id])}
                        >
                          Schedule…
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={busy}
                        onClick={() => void act([r.id], 'CANCEL')}
                      >
                        Cancel
                      </Button>
                    </>
                  )}
                </span>
              ),
            },
          ]}
          rows={items}
          rowKey={(r) => r.id}
          empty="Nothing in this view."
        />
      )}

      {expandedId &&
        (() => {
          const r = items.find((i) => i.id === expandedId);
          if (!r) return null;
          return (
            <div
              style={{
                marginTop: 8,
                padding: 12,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                display: 'grid',
                gap: 10,
                fontSize: 13,
              }}
            >
              <div style={{ color: tokens.color.textMuted, fontSize: 12 }}>
                To:{' '}
                {r.recipients.length
                  ? r.recipients
                      .map(
                        (p) =>
                          `${p.name}${p.email ? ` <${p.email}>` : ''}${!p.email && p.phone ? ` (${p.phone})` : ''}`,
                      )
                      .join(', ')
                  : 'no recipients on file'}
                {r.createdByName && ` · staged by ${r.createdByName}`}
              </div>
              {r.channels.map((c) => {
                const msg = r.rendered[c];
                if (!msg) return null;
                const result = r.channelResults?.[c];
                return (
                  <div key={c} style={{ display: 'grid', gap: 4 }}>
                    <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <Pill tone="neutral">{c.toLowerCase()}</Pill>
                      {msg.subject && <strong>{msg.subject}</strong>}
                      {result && !result.ok && (
                        <Pill tone="danger">{result.error ?? 'failed'}</Pill>
                      )}
                      {result?.ok && <Pill tone="success">delivered</Pill>}
                    </span>
                    <pre
                      style={{
                        margin: 0,
                        padding: 8,
                        whiteSpace: 'pre-wrap',
                        fontFamily: 'inherit',
                        fontSize: 13,
                        background: tokens.color.bg,
                        border: `1px solid ${tokens.color.border}`,
                        borderRadius: tokens.radius.sm,
                      }}
                    >
                      {msg.body}
                    </pre>
                  </div>
                );
              })}
            </div>
          );
        })()}

      {scheduleIds.length > 0 && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Schedule notifications"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 60,
          }}
        >
          <button
            type="button"
            aria-label="Close"
            onClick={() => setScheduleIds([])}
            disabled={busy}
            style={{
              position: 'absolute',
              inset: 0,
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
          />
          <div
            style={{
              background: tokens.color.surface,
              borderRadius: tokens.radius.md,
              padding: 20,
              width: 'min(380px, 92vw)',
              boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
              position: 'relative',
              zIndex: 1,
              display: 'grid',
              gap: 12,
            }}
          >
            <h3 style={{ margin: 0, fontSize: 15 }}>
              Schedule {scheduleIds.length} notification{scheduleIds.length === 1 ? '' : 's'}
            </h3>
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
              <span style={{ color: tokens.color.textMuted }}>Send at</span>
              <input
                type="datetime-local"
                value={scheduleAt}
                min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
                onChange={(e) => setScheduleAt(e.target.value)}
                style={{
                  padding: 8,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  fontSize: 14,
                  background: tokens.color.surface,
                  color: tokens.color.text,
                }}
              />
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button variant="secondary" disabled={busy} onClick={() => setScheduleIds([])}>
                Cancel
              </Button>
              <Button disabled={busy || !scheduleAt} onClick={submitSchedule}>
                {busy ? 'Scheduling…' : 'Schedule'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
