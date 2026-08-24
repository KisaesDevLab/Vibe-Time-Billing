// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Embedded engagement-level TEAM discussion card (staff-only, never
// visible to the client). Unlike the client thread, the team thread is
// provisioned lazily — this card offers "Start" until someone posts, and
// "Join" to staff who aren't members yet. Members can manage the
// participant list inline (add from the staff directory, remove, leave).
// Hidden entirely when the engagement's client is restricted for the
// viewer.

import { useCallback, useEffect, useState } from 'react';

import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { useAuth } from '../../auth-context';

import { ThreadView } from './ThreadView';

const API_BASE = '/api/staff/internal-messaging';

interface TeamThreadLookup {
  threadId: string;
  title: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  member: boolean;
}

type State =
  | { kind: 'loading' }
  | { kind: 'hidden' }
  | { kind: 'none' }
  | { kind: 'ready'; lookup: TeamThreadLookup }
  | { kind: 'error'; message: string };

export function EngagementTeamThreadCard({
  engagementId,
}: {
  engagementId: string;
}): JSX.Element | null {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<TeamThreadLookup>(
        `/api/staff/internal-messaging/engagements/${engagementId}/thread`,
      );
      setState({ kind: 'ready', lookup: r });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'lookup_failed';
      if (msg === 'no_team_thread') setState({ kind: 'none' });
      else if (msg === 'client_restricted') setState({ kind: 'hidden' });
      else setState({ kind: 'error', message: msg });
    }
  }, [engagementId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createOrJoin(): Promise<void> {
    setBusy(true);
    try {
      await api(`/api/staff/internal-messaging/engagements/${engagementId}/thread`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      await load();
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'failed' });
    } finally {
      setBusy(false);
    }
  }

  if (state.kind === 'hidden') return null;

  const internalHint = (
    <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '0 0 8px' }}>
      Internal — this conversation is never visible to the client.
    </p>
  );

  return (
    <Card
      title="Team discussion"
      action={
        state.kind === 'ready' && state.lookup.status === 'ARCHIVED' ? (
          <Pill tone="neutral">Thread archived</Pill>
        ) : undefined
      }
    >
      {state.kind === 'loading' && (
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>
      )}
      {state.kind === 'error' && (
        <p style={{ color: tokens.color.danger, fontSize: 13, margin: 0 }} role="alert">
          Could not load the team discussion: {state.message}
        </p>
      )}
      {state.kind === 'none' && (
        <>
          {internalHint}
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: '0 0 12px' }}>
            No one has started a team discussion for this engagement yet. Starting one adds the
            assigned team and the client&apos;s partner-in-charge.
          </p>
          <Button onClick={() => void createOrJoin()} disabled={busy}>
            {busy ? 'Starting…' : 'Start team discussion'}
          </Button>
        </>
      )}
      {state.kind === 'ready' && !state.lookup.member && (
        <>
          {internalHint}
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: '0 0 12px' }}>
            A team discussion exists for this engagement, but you aren&apos;t a participant yet.
          </p>
          <Button onClick={() => void createOrJoin()} disabled={busy}>
            {busy ? 'Joining…' : 'Join the discussion'}
          </Button>
        </>
      )}
      {state.kind === 'ready' && state.lookup.member && (
        <>
          {internalHint}
          <ParticipantsSection threadId={state.lookup.threadId} onSelfRemoved={() => void load()} />
          <ThreadView
            threadId={state.lookup.threadId}
            apiBase={API_BASE}
            variant="internal"
            embedded
            maxHeight={360}
          />
        </>
      )}
    </Card>
  );
}

// ── participants ──────────────────────────────────────────────────────

interface MemberRow {
  id: string;
  appUserId: string | null;
  name: string;
}

function ParticipantsSection({
  threadId,
  onSelfRemoved,
}: {
  threadId: string;
  onSelfRemoved: () => void;
}): JSX.Element {
  const { me } = useAuth();
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [directory, setDirectory] = useState<{ id: string; name: string }[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMembers = useCallback(async () => {
    try {
      const r = await api<{ members: MemberRow[] }>(`${API_BASE}/threads/${threadId}`);
      setMembers(r.members ?? []);
    } catch {
      setMembers([]);
    }
  }, [threadId]);

  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);

  useEffect(() => {
    if (!open) return;
    void api<{ staff: { id: string; name: string }[] }>(`${API_BASE}/directory`)
      .then((r) => setDirectory(r.staff ?? []))
      .catch(() => setDirectory([]));
  }, [open]);

  async function addMember(): Promise<void> {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      await api(`${API_BASE}/threads/${threadId}/members`, {
        method: 'POST',
        body: JSON.stringify({ appUserId: selectedId }),
      });
      setSelectedId('');
      await loadMembers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(appUserId: string): Promise<void> {
    const self = appUserId === me?.appUserId;
    if (self && !window.confirm('Leave this discussion? You can rejoin from this card.')) return;
    setBusy(true);
    setError(null);
    try {
      await api(`${API_BASE}/threads/${threadId}/members/${appUserId}`, { method: 'DELETE' });
      if (self) {
        onSelfRemoved();
        return;
      }
      await loadMembers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  const memberIds = new Set(members.map((m) => m.appUserId));
  const addable = directory.filter((s) => !memberIds.has(s.id));

  return (
    <div style={{ marginBottom: 12 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          border: 'none',
          background: 'transparent',
          color: tokens.color.accent,
          cursor: 'pointer',
          fontSize: 12,
          padding: 0,
        }}
      >
        {open ? '▾' : '▸'} Participants ({members.length})
      </button>
      {open && (
        <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
          {members.map((m) => {
            const self = m.appUserId === me?.appUserId;
            return (
              <div
                key={m.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  fontSize: 13,
                  borderBottom: `1px solid ${tokens.color.border}`,
                  padding: '4px 0',
                }}
              >
                <span>
                  {m.name}
                  {self ? ' (you)' : ''}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || !m.appUserId}
                  onClick={() => m.appUserId && void removeMember(m.appUserId)}
                >
                  {self ? 'Leave' : 'Remove'}
                </Button>
              </div>
            );
          })}
          <div style={{ display: 'flex', gap: 6 }}>
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              style={{
                flex: 1,
                padding: '4px 8px',
                fontSize: 13,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm,
                background: tokens.color.surface,
                color: tokens.color.text,
              }}
            >
              <option value="">Add a team member…</option>
              {addable.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <Button size="sm" onClick={() => void addMember()} disabled={!selectedId || busy}>
              Add
            </Button>
          </div>
          {error && (
            <p style={{ fontSize: 12, color: tokens.color.danger, margin: 0 }} role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
