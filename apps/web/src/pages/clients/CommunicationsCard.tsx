// SPDX-License-Identifier: Elastic-2.0
//
// Client communications timeline (v2 Sprint C, workstream 1.5).
//
// Outbound entries (EMAIL/SMS) are auto-recorded by the notification
// dispatcher; staff log inbound or internal (CALL/MEETING/NOTE) here.

import { useEffect, useState } from 'react';

import { Button, Card, Combobox, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';

type Channel = 'EMAIL' | 'SMS' | 'CALL' | 'MEETING' | 'NOTE';
type Direction = 'INBOUND' | 'OUTBOUND' | 'INTERNAL';

interface Communication {
  id: string;
  channel: Channel;
  direction: Direction;
  subject: string | null;
  body: string;
  occurredAt: string;
  recordedById: string | null;
  relatedEntityType: string | null;
}

interface Props {
  clientId: string;
}

const fieldStyle: React.CSSProperties = {
  padding: '6px 10px',
  background: tokens.color.surface,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  fontSize: 13,
};

export function CommunicationsCard({ clientId }: Props): JSX.Element {
  const [items, setItems] = useState<Communication[]>([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    channel: 'CALL' as Channel,
    direction: 'INBOUND' as Direction,
    subject: '',
    body: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: Communication[] }>(
        `/api/staff/clients/${clientId}/communications`,
      );
      setItems(r.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  async function add(): Promise<void> {
    if (!draft.body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/clients/${clientId}/communications`, {
        method: 'POST',
        body: JSON.stringify({
          channel: draft.channel,
          direction: draft.direction,
          subject: draft.subject.trim() || null,
          body: draft.body.trim(),
        }),
      });
      setDraft({ channel: 'CALL', direction: 'INBOUND', subject: '', body: '' });
      setAdding(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'add_failed');
    } finally {
      setBusy(false);
    }
  }

  const channelTone: Record<Channel, 'accent' | 'success' | 'warning' | 'neutral'> = {
    EMAIL: 'accent',
    SMS: 'success',
    CALL: 'warning',
    MEETING: 'warning',
    NOTE: 'neutral',
  };

  return (
    <Card
      title={
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span>Communications</span>
          <Pill>{items.length}</Pill>
        </span>
      }
      action={
        <Button size="sm" onClick={() => setAdding(!adding)}>
          {adding ? 'Cancel' : '+ Log entry'}
        </Button>
      }
    >
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
          {error}
        </p>
      )}

      {adding && (
        <div
          style={{
            display: 'grid',
            gap: 8,
            padding: 12,
            marginBottom: 12,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
          }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Combobox
              ariaLabel="Channel"
              value={draft.channel}
              onChange={(v) => setDraft({ ...draft, channel: v as Channel })}
              options={[
                { value: 'CALL', label: 'Phone call' },
                { value: 'MEETING', label: 'Meeting' },
                { value: 'NOTE', label: 'Note' },
                { value: 'EMAIL', label: 'Email (manual entry)' },
                { value: 'SMS', label: 'SMS (manual entry)' },
              ]}
            />
            <Combobox
              ariaLabel="Direction"
              value={draft.direction}
              onChange={(v) => setDraft({ ...draft, direction: v as Direction })}
              options={[
                { value: 'INBOUND', label: 'From client' },
                { value: 'OUTBOUND', label: 'To client' },
                { value: 'INTERNAL', label: 'Internal' },
              ]}
            />
          </div>
          <input
            value={draft.subject}
            onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
            placeholder="Subject (optional)"
            style={fieldStyle}
          />
          <textarea
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            placeholder="What was discussed *"
            rows={4}
            style={{ ...fieldStyle, resize: 'vertical' }}
          />
          <div>
            <Button size="sm" onClick={() => void add()} disabled={busy || !draft.body.trim()}>
              Log entry
            </Button>
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
          No communications yet. Outbound emails and SMS automatically appear here.
        </p>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {items.map((c) => (
            <div
              key={c.id}
              style={{
                padding: 10,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                display: 'grid',
                gap: 4,
              }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <Pill tone={channelTone[c.channel]}>{c.channel}</Pill>
                <Pill>{c.direction}</Pill>
                {c.subject && <strong style={{ fontSize: 13 }}>{c.subject}</strong>}
                {c.relatedEntityType && (
                  <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                    re: {c.relatedEntityType}
                  </span>
                )}
                <span style={{ marginLeft: 'auto', fontSize: 11, color: tokens.color.textMuted }}>
                  {new Date(c.occurredAt).toLocaleString()}
                </span>
              </div>
              <pre
                style={{
                  margin: 0,
                  fontSize: 12,
                  color: tokens.color.text,
                  whiteSpace: 'pre-wrap',
                  fontFamily: tokens.font.body,
                }}
              >
                {c.body}
              </pre>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
