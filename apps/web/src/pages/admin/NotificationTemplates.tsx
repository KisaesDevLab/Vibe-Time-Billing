// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState } from 'react';

import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface Template {
  id: string;
  kind: string;
  channel: 'EMAIL' | 'SMS';
  subject: string | null;
  body: string;
  variablesJson: string[] | null;
  enabled: boolean;
  updatedAt: string;
}

const KINDS: ReadonlyArray<{ key: string; label: string; channels: Array<'EMAIL' | 'SMS'> }> = [
  { key: 'invoice_sent', label: 'Invoice sent', channels: ['EMAIL'] },
  { key: 'invoice_overdue', label: 'Invoice overdue', channels: ['EMAIL', 'SMS'] },
  { key: 'dunning_first', label: 'First dunning', channels: ['EMAIL', 'SMS'] },
  { key: 'dunning_second', label: 'Second dunning', channels: ['EMAIL', 'SMS'] },
  { key: 'payment_received', label: 'Payment received', channels: ['EMAIL'] },
  { key: 'magic_link', label: 'Magic link sign-in', channels: ['EMAIL'] },
  { key: 'sms_otp', label: 'SMS OTP', channels: ['SMS'] },
  // BK-6 — appointment booking emails.
  { key: 'appointment_confirmation', label: 'Appointment confirmation', channels: ['EMAIL'] },
  {
    key: 'appointment_reschedule_confirmation',
    label: 'Appointment rescheduled',
    channels: ['EMAIL'],
  },
  { key: 'appointment_cancellation', label: 'Appointment cancelled', channels: ['EMAIL'] },
  { key: 'appointment_reminder', label: 'Appointment reminder', channels: ['EMAIL'] },
  {
    key: 'appointment_reschedule_request_declined',
    label: 'Reschedule request declined',
    channels: ['EMAIL'],
  },
  {
    key: 'appointment_reschedule_requested_staff',
    label: 'Reschedule requested (staff alert)',
    channels: ['EMAIL'],
  },
];

const SAMPLE_VARIABLES = [
  'client.name',
  'client.primaryContact',
  'invoice.number',
  'invoice.total',
  'invoice.due_date',
  'invoice.balance',
  'firm.displayName',
  'firm.supportEmail',
  'firm.supportPhone',
  // BK-6 — appointment tokens.
  'appointment.subject',
  'appointment.date',
  'appointment.time',
  'appointment.duration',
  'appointment.location_type_label',
  'appointment.location_detail',
  'appointment.cancel_url',
  'appointment.reschedule_request_url',
  'appointment.cancelled_by',
  'staff.names',
  'request.message',
];

export function NotificationTemplatesPage(): JSX.Element {
  const [items, setItems] = useState<Template[]>([]);
  const [active, setActive] = useState<{
    kind: string;
    channel: 'EMAIL' | 'SMS';
    subject: string;
    body: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: Template[] }>('/api/staff/admin/notification-templates');
      setItems(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  function open(kind: string, channel: 'EMAIL' | 'SMS'): void {
    const existing = items.find((i) => i.kind === kind && i.channel === channel);
    setActive({
      kind,
      channel,
      subject: existing?.subject ?? '',
      body: existing?.body ?? '',
    });
    setStatus(null);
    setError(null);
  }

  async function save(): Promise<void> {
    if (!active) return;
    setError(null);
    setStatus(null);
    try {
      const r = await api<{ ok: boolean; variables: string[] }>(
        `/api/staff/admin/notification-templates/${active.kind}/${active.channel}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            subject: active.channel === 'EMAIL' ? active.subject : null,
            body: active.body,
          }),
        },
      );
      setStatus(`Saved. Detected ${r.variables.length} variable(s).`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function reset(): Promise<void> {
    if (!active) return;
    if (!confirm('Revert to default? The override will be removed.')) return;
    try {
      await api(`/api/staff/admin/notification-templates/${active.kind}/${active.channel}`, {
        method: 'DELETE',
      });
      setActive(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  function insertVariable(name: string): void {
    if (!active) return;
    setActive({ ...active, body: active.body + `{{${name}}}` });
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title="Notification templates">
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 12 }}>
          Variable insertion only (per Q28). Use <code>{'{{variable.name}}'}</code> markers; the
          dispatcher substitutes at send time. Unset templates use the baked-in defaults.
        </p>
        {!active && status && (
          <p style={{ color: tokens.color.success, fontSize: 12, marginBottom: 8 }} role="status">
            {status}
          </p>
        )}
        {!active && error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
            {error}
          </p>
        )}
        <div style={{ marginBottom: 12 }}>
          <Button
            variant="secondary"
            onClick={() => {
              void (async () => {
                try {
                  const r = await api<{ inserted: number }>(
                    '/api/staff/admin/notification-templates/seed-defaults',
                    { method: 'POST' },
                  );
                  setStatus(`Seeded ${r.inserted} default(s). Existing overrides preserved.`);
                  await load();
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'seed_failed');
                }
              })();
            }}
          >
            Seed missing defaults
          </Button>
        </div>
        <div style={{ display: 'grid', gap: 8 }}>
          {KINDS.map((k) => (
            <div
              key={k.key}
              style={{
                display: 'grid',
                gridTemplateColumns: '2fr 1fr 1fr 1fr',
                gap: 8,
                alignItems: 'center',
                padding: 8,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                fontSize: 13,
              }}
            >
              <span>{k.label}</span>
              {(['EMAIL', 'SMS'] as const).map((ch) => {
                const has = items.some((i) => i.kind === k.key && i.channel === ch);
                if (!k.channels.includes(ch)) return <span key={ch} />;
                return (
                  <span key={ch} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    {has ? (
                      <Pill tone="success">{ch} override</Pill>
                    ) : (
                      <Pill tone="neutral">{ch} default</Pill>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => open(k.key, ch)}>
                      Edit
                    </Button>
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      </Card>

      {active && (
        <Card title={`Edit ${active.kind} · ${active.channel}`}>
          {status && (
            <p style={{ color: tokens.color.success, fontSize: 12, marginBottom: 8 }}>{status}</p>
          )}
          {error && (
            <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }}>{error}</p>
          )}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '3fr 1fr',
              gap: 16,
            }}
          >
            <div style={{ display: 'grid', gap: 8 }}>
              {active.channel === 'EMAIL' && (
                <label style={{ display: 'grid', gap: 4 }}>
                  <span style={{ fontSize: 12, color: tokens.color.textMuted }}>Subject</span>
                  <input
                    value={active.subject}
                    onChange={(e) => setActive({ ...active, subject: e.target.value })}
                    style={{
                      padding: '8px 10px',
                      background: tokens.color.surface,
                      color: tokens.color.text,
                      border: `1px solid ${tokens.color.border}`,
                      borderRadius: tokens.radius.md,
                    }}
                  />
                </label>
              )}
              <label style={{ display: 'grid', gap: 4 }}>
                <span style={{ fontSize: 12, color: tokens.color.textMuted }}>Body</span>
                <textarea
                  value={active.body}
                  onChange={(e) => setActive({ ...active, body: e.target.value })}
                  rows={active.channel === 'EMAIL' ? 12 : 6}
                  style={{
                    padding: '8px 10px',
                    background: tokens.color.surface,
                    color: tokens.color.text,
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.md,
                    fontFamily: tokens.font.mono,
                    fontSize: 13,
                  }}
                />
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button onClick={() => void save()}>Save</Button>
                <Button variant="secondary" onClick={() => void reset()}>
                  Revert to default
                </Button>
                <Button variant="ghost" onClick={() => setActive(null)}>
                  Cancel
                </Button>
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 6 }}>
                Variables
              </div>
              <div style={{ display: 'grid', gap: 4 }}>
                {SAMPLE_VARIABLES.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => insertVariable(v)}
                    style={{
                      textAlign: 'left',
                      fontSize: 11,
                      padding: '4px 8px',
                      borderRadius: tokens.radius.sm,
                      background: 'transparent',
                      border: `1px solid ${tokens.color.border}`,
                      color: tokens.color.text,
                      fontFamily: tokens.font.mono,
                      cursor: 'pointer',
                    }}
                  >
                    {`{{${v}}}`}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
