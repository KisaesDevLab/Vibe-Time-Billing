// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Client → SMS tab: every text conversation linked to this client, with
// the thread pane beside it (one pane at a time on phones).

import { useCallback, useEffect, useState } from 'react';

import { Button, Card, tokens, useIsNarrow } from '@vibe/ui';

import { api } from '../../api-client';
import { usePermission } from '../../auth-context';
import { useSmsStream } from '../../lib/sms-stream';
import { ConversationRow } from './ConversationRow';
import { NewSmsConversationDialog } from './NewSmsConversationDialog';
import { SmsThreadPane } from './SmsThreadPane';
import type { SmsConversation } from './types';

export function ClientSmsCard({
  clientId,
  clientName,
}: {
  clientId: string;
  clientName: string;
}): JSX.Element {
  const narrow = useIsNarrow();
  const canWrite = usePermission('messaging:write');
  const stream = useSmsStream();
  const [rows, setRows] = useState<SmsConversation[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: SmsConversation[] }>(
        `/api/staff/sms/clients/${clientId}/conversations`,
      );
      setRows(r.items ?? []);
      if (!narrow) setActiveId((cur) => cur ?? r.items?.[0]?.id ?? null);
    } catch {
      setRows([]);
    }
  }, [clientId, narrow]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => stream.subscribe(() => void load()), [stream, load]);

  return (
    <>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: narrow ? '1fr' : '300px 1fr',
          gap: tokens.space.lg,
        }}
      >
        {(!narrow || !activeId) && (
          <Card
            title={`Texts (${rows?.length ?? 0})`}
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
            {rows == null ? (
              <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>
            ) : rows.length === 0 ? (
              <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
                No text conversations with this client yet.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {rows.map((r) => (
                  <ConversationRow
                    key={r.id}
                    row={r}
                    active={activeId === r.id}
                    checked={false}
                    onOpen={() => setActiveId(r.id)}
                    onToggle={() => undefined}
                  />
                ))}
              </div>
            )}
          </Card>
        )}
        {(!narrow || activeId) && (
          <SmsThreadPane
            conversationId={activeId}
            narrow={narrow}
            embedded
            onBack={() => setActiveId(null)}
            onRowChanged={(fresh) =>
              setRows((prev) => (prev ? prev.map((r) => (r.id === fresh.id ? fresh : r)) : prev))
            }
            onMarkUnread={() => undefined}
            onOpenConversation={setActiveId}
            emptyLabel="Pick a conversation on the left."
          />
        )}
      </div>
      {showNew && (
        <NewSmsConversationDialog
          prefill={{ clientId, clientName }}
          onClose={() => setShowNew(false)}
          onCreated={(id) => {
            setShowNew(false);
            void load();
            setActiveId(id);
          }}
        />
      )}
    </>
  );
}
