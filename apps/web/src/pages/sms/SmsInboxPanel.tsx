// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Messages → SMS tab (addendum Phase 7). Two-pane list + thread with the
// house mobile collapse (one pane at a time under the 720px breakpoint,
// never auto-select on phones). Filters, search, cursor paging, bulk
// actions, live updates from the app-level stream with polling fallback.
// Deep link: /messages?tab=sms&c=<conversationId>&filter=<filter>.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { Button, Card, Combobox, EmptyState, tokens, useIsNarrow } from '@vibe/ui';

import { api } from '../../api-client';
import { useAuth, usePermission } from '../../auth-context';
import { useSmsStream } from '../../lib/sms-stream';
import { A2pBanner } from './A2pBanner';
import { ConversationRow, formatPhone } from './ConversationRow';
import { NewSmsConversationDialog } from './NewSmsConversationDialog';
import { SmsThreadPane } from './SmsThreadPane';
import { markRowRead, upsertRow } from './stream-reducer';
import type { SmsConversation, SmsFilter, SmsStreamEvent } from './types';

const FILTERS: Array<{ key: SmsFilter; label: string }> = [
  { key: 'unread', label: 'Unread' },
  { key: 'unassigned', label: 'Unassigned' },
  { key: 'triage', label: 'Needs triage' },
  { key: 'mine', label: 'Mine' },
  { key: 'all', label: 'All' },
];

interface AppUser {
  id: string;
  fullName: string;
  status?: string;
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '4px 10px',
        borderRadius: tokens.radius.pill,
        border: `1px solid ${active ? tokens.color.accent : tokens.color.border}`,
        background: active ? tokens.color.accentMuted : 'transparent',
        color: active ? tokens.color.accent : tokens.color.text,
        fontSize: 12,
        fontWeight: active ? 600 : 400,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

export function SmsInboxPanel(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const narrow = useIsNarrow();
  const { me } = useAuth();
  const meId = me?.appUserId ?? null;
  const canWrite = usePermission('messaging:write');
  const canSettings = usePermission('firm:settings:write');
  const stream = useSmsStream();

  const filterParam = params.get('filter') as SmsFilter | null;
  const [filter, setFilterState] = useState<SmsFilter>(
    filterParam && FILTERS.some((f) => f.key === filterParam) ? filterParam : 'unread',
  );
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [rows, setRows] = useState<SmsConversation[] | null>(null);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [activeId, setActiveIdState] = useState<string | null>(params.get('c'));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assignPick, setAssignPick] = useState<string>('');
  const [users, setUsers] = useState<AppUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const suppressAutoRead = useRef<string | null>(null);
  const [a2pDismissed, setA2pDismissed] = useState(() => {
    try {
      return sessionStorage.getItem('vibe.sms.a2p.dismissed') === '1';
    } catch {
      return false;
    }
  });

  // URL ↔ state
  const setFilter = (f: SmsFilter): void => {
    setFilterState(f);
    setSelected(new Set());
    const next = new URLSearchParams(params);
    next.set('tab', 'sms');
    next.set('filter', f);
    setParams(next, { replace: true });
  };
  const setActiveId = useCallback(
    (id: string | null): void => {
      setActiveIdState(id);
      stream.setActiveConversation(id);
      const next = new URLSearchParams(params);
      next.set('tab', 'sms');
      if (id) next.set('c', id);
      else next.delete('c');
      setParams(next, { replace: true });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params, setParams],
  );
  useEffect(() => () => stream.setActiveConversation(null), [stream]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(
    async (opts: { cursor?: string | null } = {}): Promise<void> => {
      try {
        const qs = new URLSearchParams({ filter, limit: '50' });
        if (debouncedQ) qs.set('q', debouncedQ);
        if (opts.cursor) qs.set('cursor', opts.cursor);
        const r = await api<{ items: SmsConversation[]; total: number; nextCursor: string | null }>(
          `/api/staff/sms/conversations?${qs.toString()}`,
        );
        setRows((prev) => (opts.cursor && prev ? [...prev, ...r.items] : r.items));
        setTotal(r.total);
        setNextCursor(r.nextCursor);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'load_failed');
        setRows((prev) => prev ?? []);
      }
    },
    [filter, debouncedQ],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void api<{ users: AppUser[] }>('/api/staff/admin/users')
      .then((r) => setUsers((r.users ?? []).filter((u) => u.status !== 'DISABLED')))
      .catch(() => undefined);
  }, []);

  // Live updates: refetch the one row an event names; full reload on refresh.
  useEffect(() => {
    return stream.subscribe((evt: SmsStreamEvent) => {
      if (evt.type === 'sms.refresh') {
        void load();
        return;
      }
      if (evt.type === 'sms.message.status') return;
      void api<SmsConversation>(`/api/staff/sms/conversations/${evt.conversationId}`)
        .then((fresh) => {
          setRows((prev) =>
            prev ? upsertRow({ rows: prev, filter, meId, activeId }, fresh) : prev,
          );
        })
        .catch(() => undefined);
    });
  }, [stream, load, filter, meId, activeId]);

  function open(id: string): void {
    setActiveId(id);
    if (suppressAutoRead.current === id) return;
    setRows((prev) => (prev ? markRowRead(prev, id) : prev));
    void api(`/api/staff/sms/conversations/${id}/read`, { method: 'POST' })
      .then(() => stream.refreshUnread())
      .catch(() => undefined);
  }

  async function bulk(action: 'read' | 'assign' | 'close' | 'spam' | 'reopen'): Promise<void> {
    if (selected.size === 0) return;
    setBulkBusy(true);
    try {
      await api('/api/staff/sms/conversations/bulk', {
        method: 'POST',
        body: JSON.stringify({
          ids: [...selected],
          action,
          assignedUserId: action === 'assign' ? assignPick || null : undefined,
        }),
      });
      setSelected(new Set());
      await load();
      stream.refreshUnread();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'bulk_failed');
    } finally {
      setBulkBusy(false);
    }
  }

  const visible = rows ?? [];
  const configured = stream.health ? stream.health.configured : true;
  const listMaxHeight = 'calc(100vh / var(--vibe-font-scale, 1) - 300px)';
  const emptyCopy: Record<SmsFilter, string> = useMemo(
    () => ({
      unread: 'No unread conversations.',
      unassigned: 'Every conversation is linked to a client.',
      triage: 'Nothing needs triage.',
      mine: 'Nothing is assigned to you.',
      all: 'No text conversations yet.',
    }),
    [],
  );

  return (
    <>
      {!a2pDismissed && (
        <A2pBanner
          status={stream.health?.a2p?.status}
          configured={configured}
          showAdminLink={canSettings}
          onDismiss={() => {
            setA2pDismissed(true);
            try {
              sessionStorage.setItem('vibe.sms.a2p.dismissed', '1');
            } catch {
              /* ignore */
            }
          }}
        />
      )}
      {stream.health?.webhookGap && (
        <p style={{ fontSize: 12, color: tokens.color.warning, margin: 0 }} role="status">
          Twilio&apos;s webhook is not reaching this appliance — texts arrive by polling every few
          minutes.{' '}
          {canSettings && (
            <a href="/admin/sms-inbox" style={{ color: tokens.color.accent }}>
              Check SMS inbox settings →
            </a>
          )}
        </p>
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: narrow ? '1fr' : '340px 1fr',
          gap: tokens.space.lg,
        }}
      >
        {(!narrow || !activeId) && (
          <Card
            title={`Conversations (${total})`}
            action={
              <Button
                size="sm"
                disabled={!canWrite}
                title={canWrite ? undefined : 'Needs messaging:write'}
                onClick={() => setShowNew(true)}
              >
                New text
              </Button>
            }
          >
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
              {FILTERS.map((f) => (
                <FilterChip key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>
                  {f.label}
                </FilterChip>
              ))}
            </div>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, number, or message…"
              aria-label="Search text conversations"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '8px 10px',
                marginBottom: 8,
                background: tokens.color.surface,
                color: tokens.color.text,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                fontSize: 13,
              }}
            />
            {selected.size > 0 && (
              <div
                style={{
                  display: 'flex',
                  gap: 6,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  padding: '6px 8px',
                  marginBottom: 8,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.md,
                  fontSize: 12,
                }}
              >
                <span>{selected.size} selected</span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={bulkBusy}
                  onClick={() => void bulk('read')}
                >
                  Mark read
                </Button>
                <Combobox
                  ariaLabel="Assign selected conversations"
                  size="sm"
                  width={160}
                  value={assignPick}
                  onChange={setAssignPick}
                  placeholder="Assign to…"
                  options={[
                    { value: '', label: '— unassign —' },
                    ...users.map((u) => ({ value: u.id, label: u.fullName })),
                  ]}
                  disabled={!canWrite}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={bulkBusy || !canWrite}
                  title={canWrite ? undefined : 'Needs messaging:write'}
                  onClick={() => void bulk('assign')}
                >
                  Assign
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={bulkBusy || !canWrite}
                  onClick={() => void bulk('close')}
                >
                  Close
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={bulkBusy || !canWrite}
                  onClick={() => void bulk('spam')}
                >
                  Spam
                </Button>
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  style={{
                    marginLeft: 'auto',
                    background: 'none',
                    border: 'none',
                    color: tokens.color.textMuted,
                    cursor: 'pointer',
                    fontSize: 12,
                  }}
                >
                  Clear
                </button>
              </div>
            )}
            {error && (
              <p style={{ color: tokens.color.danger, fontSize: 12 }} role="alert">
                {error}
              </p>
            )}
            {rows == null ? (
              <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>
            ) : !configured && visible.length === 0 ? (
              <EmptyState
                title="Texting isn't set up yet"
                body="Add Twilio credentials and a Messaging Service, then enable the inbox."
                cta={
                  canSettings ? (
                    <a href="/admin/sms-inbox" style={{ color: tokens.color.accent, fontSize: 13 }}>
                      SMS inbox settings →
                    </a>
                  ) : (
                    <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                      Ask an administrator.
                    </span>
                  )
                }
              />
            ) : visible.length === 0 ? (
              <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
                {debouncedQ ? `No conversations match “${debouncedQ}”.` : emptyCopy[filter]}
              </p>
            ) : (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  maxHeight: listMaxHeight,
                  overflowY: 'auto',
                }}
              >
                {visible.map((r) => (
                  <ConversationRow
                    key={r.id}
                    row={r}
                    active={activeId === r.id}
                    checked={selected.has(r.id)}
                    onOpen={() => open(r.id)}
                    onToggle={() =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(r.id)) next.delete(r.id);
                        else next.add(r.id);
                        return next;
                      })
                    }
                  />
                ))}
                {nextCursor && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={loadingMore}
                    onClick={() => {
                      setLoadingMore(true);
                      void load({ cursor: nextCursor }).finally(() => setLoadingMore(false));
                    }}
                  >
                    {loadingMore ? 'Loading…' : 'Load more'}
                  </Button>
                )}
              </div>
            )}
          </Card>
        )}

        {(!narrow || activeId) && (
          <SmsThreadPane
            conversationId={activeId}
            narrow={narrow}
            onBack={() => setActiveId(null)}
            onRowChanged={(fresh) =>
              setRows((prev) =>
                prev ? upsertRow({ rows: prev, filter, meId, activeId }, fresh) : prev,
              )
            }
            onMarkUnread={(id) => {
              suppressAutoRead.current = id;
            }}
            onOpenConversation={(id) => open(id)}
            emptyLabel={
              rows && rows.length > 0 ? 'Pick a conversation on the left.' : 'Nothing to show yet.'
            }
          />
        )}
      </div>
      {showNew && (
        <NewSmsConversationDialog
          onClose={() => setShowNew(false)}
          onCreated={(id) => {
            setShowNew(false);
            void load();
            open(id);
          }}
        />
      )}
    </>
  );
}

export { formatPhone };
