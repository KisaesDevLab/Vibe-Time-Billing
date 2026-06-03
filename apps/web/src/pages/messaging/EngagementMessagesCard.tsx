// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Embedded engagement-level messages card. Resolves the thread from
// the engagement id (the API auto-provisions one thread per engagement
// at engagement-creation time), then renders the reusable ThreadView.

import { useEffect, useState } from 'react';

import { Card, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';

import { ThreadView } from './ThreadView';

interface ThreadLookup {
  threadId: string;
  title: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
}

export function EngagementMessagesCard({ engagementId }: { engagementId: string }): JSX.Element {
  const [lookup, setLookup] = useState<ThreadLookup | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<ThreadLookup>(
          `/api/staff/engagement-messaging/engagements/${engagementId}/thread`,
        );
        setLookup(r);
        setMissing(false);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'lookup_failed';
        if (msg === 'no_thread_for_engagement') {
          setMissing(true);
        } else {
          setError(`Could not load messages: ${msg}`);
        }
      }
    })();
  }, [engagementId]);

  if (missing) {
    return (
      <Card title="Messages">
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
          No message thread exists yet for this engagement. Threads are created automatically when
          an engagement is opened with at least one portal contact assigned.
        </p>
      </Card>
    );
  }

  if (error) {
    return (
      <Card title="Messages">
        <p style={{ color: tokens.color.danger, fontSize: 13, margin: 0 }} role="alert">
          {error}
        </p>
      </Card>
    );
  }

  if (!lookup) {
    return (
      <Card title="Messages">
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>
      </Card>
    );
  }

  return (
    <Card
      title="Messages"
      action={
        lookup.status === 'ARCHIVED' ? (
          <Pill tone="neutral">Thread archived</Pill>
        ) : (
          <a
            href="/messages"
            style={{ fontSize: 12, color: tokens.color.accent, textDecoration: 'none' }}
          >
            Open in inbox →
          </a>
        )
      }
    >
      <ThreadView threadId={lookup.threadId} embedded maxHeight={360} />
    </Card>
  );
}
