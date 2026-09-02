// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Right pane of the SMS inbox (Phase 7 read-only thread; Phase 8 adds the
// header actions and the reply composer). Loads the conversation detail
// and messages, subscribes to the stream for live appends/status changes.

import { useCallback, useEffect, useState } from 'react';

import { Card, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { useSmsStream } from '../../lib/sms-stream';
import { formatPhone } from './ConversationRow';
import type { SmsConversation, SmsConversationDetail, SmsMessage } from './types';

export interface SmsThreadPaneProps {
  conversationId: string | null;
  narrow: boolean;
  onBack: () => void;
  onRowChanged: (row: SmsConversation) => void;
  onMarkUnread: (id: string) => void;
  onOpenConversation: (id: string) => void;
  emptyLabel: string;
}

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'danger' | 'warning'> = {
  delivered: 'success',
  undelivered: 'danger',
  failed: 'danger',
  dead_letter: 'danger',
  received: 'neutral',
};

export function describeTwilioError(code: number | null): string | null {
  switch (code) {
    case 21610:
      return 'Recipient has opted out (STOP).';
    case 30003:
      return 'Unreachable — device off or out of coverage.';
    case 30005:
      return 'Unknown destination number.';
    case 30006:
      return 'Landline or unreachable carrier.';
    case 30007:
      return 'Filtered by the carrier (possible spam classification).';
    case 30034:
      return 'Blocked: US A2P 10DLC registration incomplete.';
    default:
      return code ? `Twilio error ${code}` : null;
  }
}

export function MessageBubble({
  m,
  contactName,
}: {
  m: SmsMessage;
  contactName: string;
}): JSX.Element {
  const out = m.direction === 'outbound';
  const tone = STATUS_TONE[m.providerStatus] ?? 'neutral';
  const err = describeTwilioError(m.providerErrorCode);
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: out ? 'flex-end' : 'flex-start',
      }}
    >
      <div
        style={{
          maxWidth: '85%',
          padding: '8px 12px',
          borderRadius: tokens.radius.md,
          background: out ? tokens.color.accentMuted : tokens.color.surface,
          border: `1px solid ${out ? tokens.color.accent : tokens.color.border}`,
          color: tokens.color.text,
          fontSize: 13,
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
        }}
      >
        {m.body || (m.numMedia > 0 ? '' : '(empty)')}
        {m.media.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: m.body ? 6 : 0 }}>
            {m.media.map((md) => {
              const isImg = (md.contentType ?? '').startsWith('image/');
              const href = md.intakeSessionId ? `/intake?session=${md.intakeSessionId}` : md.url;
              const inner =
                isImg && md.url ? (
                  <img
                    src={md.url}
                    alt="attachment"
                    style={{
                      maxWidth: 160,
                      maxHeight: 160,
                      borderRadius: tokens.radius.sm,
                      display: 'block',
                    }}
                  />
                ) : (
                  <span style={{ fontSize: 12 }}>
                    📎 {md.contentType ?? 'file'}
                    {md.status === 'pending'
                      ? ' (processing…)'
                      : md.status === 'failed'
                        ? ' (failed)'
                        : ''}
                  </span>
                );
              return href ? (
                <a
                  key={md.id}
                  href={href}
                  style={{ color: tokens.color.accent }}
                  title={md.intakeSessionId ? 'Open in Intake' : 'Open'}
                >
                  {inner}
                </a>
              ) : (
                <span key={md.id}>{inner}</span>
              );
            })}
          </div>
        )}
      </div>
      <div
        style={{
          display: 'flex',
          gap: 6,
          alignItems: 'center',
          fontSize: 11,
          color: tokens.color.textMuted,
          marginTop: 2,
        }}
      >
        <span>
          {out
            ? (m.sentBy?.name ?? (m.contextKind === 'auto_reply' ? 'Auto-reply' : 'System'))
            : contactName}
        </span>
        <span>· {new Date(m.createdAt).toLocaleString()}</span>
        {out && (
          <span title={err ?? undefined}>
            <Pill tone={tone}>{m.providerStatus.replace('_', ' ')}</Pill>
          </span>
        )}
        {out && m.numSegments != null && m.numSegments > 1 && (
          <span>· {m.numSegments} segments</span>
        )}
        {m.parsedIntent === 'confirm' && <Pill tone="success">Confirmed appointment</Pill>}
        {m.parsedIntent === 'reschedule' && <Pill tone="warning">Reschedule requested</Pill>}
        {m.redactionFlags?.length > 0 && <Pill tone="neutral">PII pattern</Pill>}
      </div>
    </div>
  );
}

export function useSmsThread(conversationId: string | null): {
  detail: SmsConversationDetail | null;
  messages: SmsMessage[];
  error: string | null;
  reloadDetail: () => Promise<SmsConversationDetail | null>;
  reloadMessages: () => Promise<void>;
  appendMessage: (m: SmsMessage) => void;
} {
  const [detail, setDetail] = useState<SmsConversationDetail | null>(null);
  const [messages, setMessages] = useState<SmsMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const stream = useSmsStream();

  const reloadDetail = useCallback(async (): Promise<SmsConversationDetail | null> => {
    if (!conversationId) return null;
    try {
      const d = await api<SmsConversationDetail>(`/api/staff/sms/conversations/${conversationId}`);
      setDetail(d);
      return d;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load_failed');
      return null;
    }
  }, [conversationId]);

  const reloadMessages = useCallback(async (): Promise<void> => {
    if (!conversationId) return;
    try {
      const r = await api<{ items: SmsMessage[] }>(
        `/api/staff/sms/conversations/${conversationId}/messages`,
      );
      setMessages(r.items ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load_failed');
    }
  }, [conversationId]);

  useEffect(() => {
    setDetail(null);
    setMessages([]);
    setError(null);
    void reloadDetail();
    void reloadMessages();
  }, [reloadDetail, reloadMessages]);

  useEffect(() => {
    if (!conversationId) return;
    return stream.subscribe((evt) => {
      if (evt.type === 'sms.refresh') {
        void reloadMessages();
        return;
      }
      if (evt.conversationId !== conversationId) return;
      if (evt.type === 'sms.message.created' || evt.type === 'sms.message.status')
        void reloadMessages();
      if (evt.type !== 'sms.message.status') void reloadDetail();
    });
  }, [stream, conversationId, reloadDetail, reloadMessages]);

  const appendMessage = useCallback((m: SmsMessage) => {
    setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
  }, []);

  return { detail, messages, error, reloadDetail, reloadMessages, appendMessage };
}

export function SmsThreadPane(props: SmsThreadPaneProps): JSX.Element {
  const { conversationId, narrow, onBack, emptyLabel } = props;
  const { detail, messages, error } = useSmsThread(conversationId);
  const contactName =
    detail?.contact?.name ?? (detail ? formatPhone(detail.externalNumberE164) : '');
  const title = detail
    ? [detail.contact?.name ?? formatPhone(detail.externalNumberE164), detail.client?.name]
        .filter(Boolean)
        .join(' — ')
    : conversationId
      ? 'Loading…'
      : 'Pick a conversation';

  return (
    <Card
      title={title}
      action={
        narrow && conversationId ? (
          <button
            type="button"
            onClick={onBack}
            style={{
              border: 'none',
              background: 'transparent',
              color: tokens.color.accent,
              cursor: 'pointer',
              fontSize: 13,
              padding: 0,
            }}
          >
            ← All conversations
          </button>
        ) : undefined
      }
    >
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 13 }} role="alert">
          {error}
        </p>
      )}
      {!conversationId ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>{emptyLabel}</p>
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            maxHeight: 520,
            overflowY: 'auto',
            padding: '4px 2px',
          }}
        >
          {messages.length === 0 && !error && (
            <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
              No messages yet.
            </p>
          )}
          {messages.map((m) => (
            <MessageBubble key={m.id} m={m} contactName={contactName} />
          ))}
        </div>
      )}
    </Card>
  );
}
