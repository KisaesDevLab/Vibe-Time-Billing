// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// "Create time entry" from an SMS thread (D12 / Phase 12). Prefilled by
// the server (client, engagement, default work code, an editable duration
// estimate from the message count); posts through the shared time-entry
// core so every guard (engagement writable, lockouts, required fields)
// applies.

import { useEffect, useState } from 'react';

import { Button, Combobox, Modal, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { composerTextareaStyle } from '../messaging/styles';
import type { SmsConversationDetail } from './types';

interface Prefill {
  engagementId: string | null;
  engagementName: string | null;
  clientId: string | null;
  clientName: string | null;
  workCodeId: string | null;
  entryDate: string;
  hours: number;
  roundingHours: number;
  messageCount: number;
  description: string;
}
interface WorkCode {
  id: string;
  key: string;
  name: string;
}

export function CreateSmsTimeEntryDialog({
  detail,
  onClose,
  onCreated,
}: {
  detail: SmsConversationDetail;
  onClose: () => void;
  onCreated: (entryId: string | null) => void;
}): JSX.Element {
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [workCodes, setWorkCodes] = useState<WorkCode[]>([]);
  const [engagementId, setEngagementId] = useState(detail.engagement?.id ?? '');
  const [workCodeId, setWorkCodeId] = useState('');
  const [entryDate, setEntryDate] = useState('');
  const [hours, setHours] = useState('');
  const [description, setDescription] = useState('');
  const [billable, setBillable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<Prefill>(`/api/staff/sms/conversations/${detail.id}/time-entry/prefill`)
      .then((p) => {
        setPrefill(p);
        setEngagementId(p.engagementId ?? '');
        setWorkCodeId(p.workCodeId ?? '');
        setEntryDate(p.entryDate);
        setHours(String(p.hours));
        setDescription(p.description);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'load_failed'));
    void api<{ items: WorkCode[] }>('/api/staff/taxonomy/work-codes')
      .then((r) => setWorkCodes(r.items ?? []))
      .catch(() => undefined);
  }, [detail.id]);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ id?: string }>(`/api/staff/sms/conversations/${detail.id}/time-entry`, {
        method: 'POST',
        body: JSON.stringify({
          engagementId: engagementId || undefined,
          workCodeId: workCodeId || undefined,
          entryDate,
          hours: Number(hours),
          description: description.trim() || undefined,
          billableFlag: billable,
        }),
      });
      onCreated(r.id ?? null);
    } catch (e) {
      const body = (e as { body?: { error?: string; missing?: string[] } }).body;
      setError(
        body?.error === 'engagement_not_writable'
          ? 'That engagement is paused, closed, or archived.'
          : body?.missing?.length
            ? `Required fields missing: ${body.missing.join(', ')}`
            : (body?.error ?? (e instanceof Error ? e.message : 'create_failed')),
      );
    } finally {
      setBusy(false);
    }
  }

  const label: React.CSSProperties = { fontSize: 12, color: tokens.color.textMuted };
  const field: React.CSSProperties = {
    padding: '8px 10px',
    background: tokens.color.surface,
    color: tokens.color.text,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.md,
    fontSize: 13,
  };

  return (
    <Modal
      title="Create time entry from this thread"
      onClose={busy ? undefined : onClose}
      maxWidth={520}
    >
      <div style={{ display: 'grid', gap: 12, fontSize: 13 }}>
        {prefill?.clientName && <span style={label}>Client: {prefill.clientName}</span>}
        <div style={{ display: 'grid', gap: 4 }}>
          <span style={label}>Engagement</span>
          <Combobox
            ariaLabel="Engagement"
            value={engagementId}
            onChange={setEngagementId}
            placeholder="— pick an engagement —"
            options={detail.engagementOptions.map((e) => ({ value: e.id, label: e.name }))}
          />
        </div>
        <div style={{ display: 'grid', gap: 4 }}>
          <span style={label}>Work code</span>
          <Combobox
            ariaLabel="Work code"
            value={workCodeId}
            onChange={setWorkCodeId}
            placeholder="— default —"
            options={[
              { value: '', label: '— default —' },
              ...workCodes.map((w) => ({ value: w.id, label: `${w.key} · ${w.name}` })),
            ]}
          />
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={label}>Date</span>
            <input
              type="date"
              value={entryDate}
              onChange={(e) => setEntryDate(e.target.value)}
              style={field}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={label}>Hours</span>
            <input
              type="number"
              step={prefill?.roundingHours ?? 0.25}
              min={prefill?.roundingHours ?? 0.25}
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              style={{ ...field, width: 110 }}
            />
            {prefill && (
              <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                Estimated from {prefill.messageCount} message{prefill.messageCount === 1 ? '' : 's'}{' '}
                — edit freely
              </span>
            )}
          </label>
          <label
            style={{
              display: 'flex',
              gap: 6,
              alignItems: 'center',
              alignSelf: 'end',
              paddingBottom: 8,
            }}
          >
            <input
              type="checkbox"
              checked={billable}
              onChange={(e) => setBillable(e.target.checked)}
            />
            Billable
          </label>
        </div>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={label}>Description</span>
          <textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            style={composerTextareaStyle}
          />
        </label>
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }} role="alert">
            {error}
          </p>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={busy || !engagementId || !entryDate || !(Number(hours) > 0)}
            title={!engagementId ? 'Pick an engagement first' : undefined}
          >
            {busy ? 'Saving…' : 'Create entry'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
