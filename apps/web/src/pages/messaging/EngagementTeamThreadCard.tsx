// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Embedded engagement-level TEAM discussion card (staff-only, never
// visible to the client). Unlike the client thread, the team thread is
// provisioned lazily — this card offers "Start" until someone posts, and
// "Join" to staff who aren't members yet. Hidden entirely when the
// engagement's client is restricted for the viewer.

import { useCallback, useEffect, useState } from 'react';

import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';

import { ThreadView } from './ThreadView';

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
          <ThreadView
            threadId={state.lookup.threadId}
            apiBase="/api/staff/internal-messaging"
            variant="internal"
            embedded
            maxHeight={360}
          />
        </>
      )}
    </Card>
  );
}
