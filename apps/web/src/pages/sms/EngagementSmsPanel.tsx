// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Engagement → Activity card: the last few texts on this engagement's
// conversations, with "open thread" links and a "Text client" starter.

import { useCallback, useEffect, useState } from 'react';

import { Button, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { usePermission } from '../../auth-context';
import { useSmsStream } from '../../lib/sms-stream';
import { formatPhone, relativeTime } from './ConversationRow';
import { NewSmsConversationDialog } from './NewSmsConversationDialog';
import type { SmsConversation } from './types';

interface Recent {
  id: string;
  conversationId: string;
  direction: 'inbound' | 'outbound';
  body: string;
  providerStatus: string;
  createdAt: string;
}

export function EngagementSmsPanel({
  engagementId,
  clientId,
  clientName,
}: {
  engagementId: string;
  clientId?: string | null;
  clientName?: string | null;
}): JSX.Element | null {
  const canRead = usePermission('sms:read');
  const canWrite = usePermission('sms:write');
  const stream = useSmsStream();
  const [conversations, setConversations] = useState<SmsConversation[]>([]);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<{ conversations: SmsConversation[]; recent: Recent[] }>(
        `/api/staff/sms/engagements/${engagementId}/conversations`,
      );
      setConversations(r.conversations ?? []);
      setRecent(r.recent ?? []);
    } catch {
      /* card stays empty */
    } finally {
      setLoaded(true);
    }
  }, [engagementId]);

  useEffect(() => {
    if (canRead) void load();
  }, [canRead, load]);
  useEffect(() => stream.subscribe(() => void load()), [stream, load]);

  if (!canRead) return null;
  const byConv = new Map(conversations.map((c) => [c.id, c]));
  return (
    <div style={{ marginTop: 12, borderTop: `1px solid ${tokens.color.border}`, paddingTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <strong style={{ fontSize: 13 }}>Texts</strong>
        {conversations.length > 0 && (
          <Pill tone="neutral">
            {conversations.length} thread{conversations.length === 1 ? '' : 's'}
          </Pill>
        )}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8 }}>
          {conversations[0] && (
            <a
              href={`/messages?tab=sms&c=${conversations[0].id}`}
              style={{ fontSize: 12, color: tokens.color.accent, textDecoration: 'none' }}
            >
              Open thread →
            </a>
          )}
          <Button
            size="sm"
            variant="secondary"
            disabled={!canWrite}
            title={canWrite ? undefined : 'Needs sms:write'}
            onClick={() => setShowNew(true)}
          >
            Text client
          </Button>
        </span>
      </div>
      {loaded && recent.length === 0 ? (
        <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
          No texts on this engagement yet.
        </p>
      ) : (
        <div style={{ display: 'grid', gap: 4 }}>
          {recent.map((m) => {
            const c = byConv.get(m.conversationId);
            return (
              <a
                key={m.id}
                href={`/messages?tab=sms&c=${m.conversationId}`}
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  fontSize: 12,
                  color: tokens.color.text,
                  textDecoration: 'none',
                }}
              >
                <span style={{ color: tokens.color.textMuted, width: 14 }}>
                  {m.direction === 'inbound' ? '↩' : '→'}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {m.body || '(attachment)'}
                </span>
                <span style={{ color: tokens.color.textMuted, whiteSpace: 'nowrap' }}>
                  {c?.contact?.name ?? (c ? formatPhone(c.externalNumberE164) : '')} ·{' '}
                  {relativeTime(m.createdAt)}
                </span>
              </a>
            );
          })}
        </div>
      )}
      {showNew && (
        <NewSmsConversationDialog
          prefill={{ clientId: clientId ?? null, clientName: clientName ?? null, engagementId }}
          onClose={() => setShowNew(false)}
          onCreated={(id) => {
            setShowNew(false);
            window.location.assign(`/messages?tab=sms&c=${id}`);
          }}
        />
      )}
    </div>
  );
}
