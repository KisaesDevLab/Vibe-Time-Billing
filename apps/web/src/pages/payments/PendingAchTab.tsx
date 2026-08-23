// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0218 — /payments "Pending ACH" tab. Manual-ACH banks still awaiting
// micro-deposit verification, firm-wide. Staff can verify inline (two
// amounts or the SM descriptor code) or email the client a no-login
// verification link (…/verify-bank/:token on the portal host).

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface PendingAchRow {
  id: string;
  clientId: string | null;
  clientName: string | null;
  displayLabel: string;
  lastFour: string;
  createdAt: string;
  lastReminderAt: string | null;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}

export function PendingAchTab(): JSX.Element {
  const [items, setItems] = useState<PendingAchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const r = await api<{ items: PendingAchRow[] }>(
        '/api/staff/payment-methods/pending-verification',
      );
      setItems(r.items ?? []);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'load_failed');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card title="Banks awaiting micro-deposit verification">
      <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 0 }}>
        These manually entered bank accounts cannot be charged until the client (or you) confirms
        the micro-deposits Stripe sent — two small amounts, or one deposit with a 6-digit SM code,
        arriving 1–2 business days after setup. “Send link” emails the client a secure page to
        confirm them, no portal login needed.
      </p>
      {notice && <p style={{ fontSize: 13, color: tokens.color.success }}>{notice}</p>}
      {err && <p style={{ fontSize: 13, color: tokens.color.danger }}>{err}</p>}
      <Table<PendingAchRow>
        columns={[
          {
            key: 'client',
            header: 'Client',
            render: (r) =>
              r.clientId ? (
                <Link to={`/clients/${r.clientId}`} style={{ color: tokens.color.accent }}>
                  {r.clientName ?? 'Client'}
                </Link>
              ) : (
                (r.clientName ?? '—')
              ),
          },
          { key: 'bank', header: 'Bank', render: (r) => r.displayLabel },
          { key: 'saved', header: 'Saved', render: (r) => fmtDate(r.createdAt) },
          {
            key: 'reminder',
            header: 'Link sent',
            render: (r) =>
              r.lastReminderAt ? fmtDate(r.lastReminderAt) : <Pill tone="warning">never</Pill>,
          },
          {
            key: 'actions',
            header: '',
            align: 'right',
            render: (r) => (
              <div
                style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' }}
              >
                <InlineVerify row={r} onVerified={load} onError={setErr} />
                <SendLinkPicker
                  row={r}
                  onSent={(msg) => {
                    setNotice(msg);
                    setErr(null);
                    void load();
                  }}
                  onError={(msg) => {
                    setErr(msg);
                    setNotice(null);
                  }}
                />
              </div>
            ),
          },
        ]}
        rows={items}
        rowKey={(r) => r.id}
        empty={loading ? 'Loading…' : 'No banks awaiting verification.'}
      />
    </Card>
  );
}

interface ClientContact {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  isPrimary: boolean;
  isBilling: boolean;
  status: string;
}

// "Send link" with recipient + channel choice. Opens a small inline picker
// listing the client's active contacts (billing contact preselected) and
// Email / Text / Both delivery, mirroring the invoice pay-link send.
function SendLinkPicker({
  row,
  onSent,
  onError,
}: {
  row: PendingAchRow;
  onSent: (msg: string) => void;
  onError: (msg: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [contacts, setContacts] = useState<ClientContact[] | null>(null);
  const [contactId, setContactId] = useState('');
  const [channel, setChannel] = useState<'EMAIL' | 'SMS' | 'BOTH'>('EMAIL');
  const [busy, setBusy] = useState(false);

  async function openPicker(): Promise<void> {
    setOpen(true);
    if (contacts !== null || !row.clientId) return;
    try {
      const r = await api<{ items: ClientContact[] }>(
        `/api/staff/clients/${row.clientId}/contacts`,
      );
      const active = (r.items ?? []).filter((c) => c.status === 'ACTIVE');
      setContacts(active);
      const preferred =
        active.find((c) => c.isBilling) ?? active.find((c) => c.isPrimary) ?? active[0];
      if (preferred) setContactId(preferred.id);
    } catch {
      setContacts([]);
      onError('Could not load the client’s contacts.');
    }
  }

  const selected = contacts?.find((c) => c.id === contactId);
  const hasEmail = Boolean(selected?.email);
  const hasPhone = Boolean(selected?.mobile || selected?.phone);
  const channelDeliverable =
    channel === 'EMAIL' ? hasEmail : channel === 'SMS' ? hasPhone : hasEmail || hasPhone;

  async function send(): Promise<void> {
    setBusy(true);
    try {
      const r = await api<{
        ok: boolean;
        results: { email: string; sms: string };
        sentToEmail: string | null;
        sentToPhone: string | null;
      }>(`/api/staff/payment-methods/${row.id}/send-verification-reminder`, {
        method: 'POST',
        body: JSON.stringify({ contactId: contactId || undefined, channel }),
      });
      const parts: string[] = [];
      if (r.sentToEmail) parts.push(`emailed to ${r.sentToEmail}`);
      if (r.sentToPhone) parts.push(`texted to ${r.sentToPhone}`);
      const misses: string[] = [];
      if (r.results.email === 'no_destination') misses.push('no email on file');
      if (r.results.sms === 'no_destination') misses.push('no phone on file');
      if (r.results.sms === 'opted_out') misses.push('opted out of texts');
      if (r.results.email === 'failed') misses.push('email failed');
      if (r.results.sms === 'failed') misses.push('text failed');
      onSent(
        `Verification link ${parts.join(' and ')}${misses.length ? ` (${misses.join(', ')})` : ''}.`,
      );
      setOpen(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'send_failed';
      onError(
        msg === 'no_email_destination'
          ? 'That contact has no email on file.'
          : msg === 'no_sms_destination'
            ? 'That contact has no phone on file (or SMS is not configured).'
            : msg === 'sms_opted_out'
              ? 'That contact has opted out of text messages.'
              : msg === 'no_destination'
                ? 'That contact has no email or phone on file.'
                : `Could not send the reminder (${msg}).`,
      );
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button size="sm" onClick={() => void openPicker()}>
        Send link
      </Button>
    );
  }
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
      <select
        value={contactId}
        onChange={(e) => setContactId(e.target.value)}
        aria-label={`Recipient for ${row.displayLabel}`}
        style={{
          padding: '4px 8px',
          fontSize: 12,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.sm,
          background: tokens.color.surface,
          color: tokens.color.text,
          maxWidth: 220,
        }}
      >
        {contacts === null && <option value="">Loading…</option>}
        {contacts !== null && contacts.length === 0 && <option value="">No contacts</option>}
        {(contacts ?? []).map((c) => (
          <option key={c.id} value={c.id}>
            {c.fullName}
            {c.isBilling ? ' (billing)' : c.isPrimary ? ' (primary)' : ''}
            {c.email ? ` — ${c.email}` : c.mobile || c.phone ? ` — ${c.mobile || c.phone}` : ''}
          </option>
        ))}
      </select>
      <select
        value={channel}
        onChange={(e) => setChannel(e.target.value as 'EMAIL' | 'SMS' | 'BOTH')}
        aria-label={`Delivery channel for ${row.displayLabel}`}
        style={{
          padding: '4px 8px',
          fontSize: 12,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.sm,
          background: tokens.color.surface,
          color: tokens.color.text,
        }}
      >
        <option value="EMAIL" disabled={Boolean(selected) && !hasEmail}>
          Email
        </option>
        <option value="SMS" disabled={Boolean(selected) && !hasPhone}>
          Text
        </option>
        <option value="BOTH" disabled={Boolean(selected) && !hasEmail && !hasPhone}>
          Both
        </option>
      </select>
      <Button
        size="sm"
        onClick={() => void send()}
        disabled={busy || !selected || !channelDeliverable}
      >
        {busy ? '…' : 'Send'}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
        ✕
      </Button>
    </div>
  );
}

// Inline staff-side verify — for when the client reads the deposits to you
// over the phone. Two amounts (cents) or the SM descriptor code.
function InlineVerify({
  row,
  onVerified,
  onError,
}: {
  row: PendingAchRow;
  onVerified: () => Promise<void> | void;
  onError: (msg: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'amounts' | 'code'>('amounts');
  const [a0, setA0] = useState('');
  const [a1, setA1] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    if (!row.clientId) return;
    setBusy(true);
    try {
      await api(`/api/staff/payment-methods/${row.id}/verify-microdeposits`, {
        method: 'POST',
        body: JSON.stringify({
          clientId: row.clientId,
          ...(mode === 'code'
            ? { descriptorCode: code.trim().toUpperCase() }
            : { amounts: [Number(a0), Number(a1)] }),
        }),
      });
      setOpen(false);
      await onVerified();
    } catch {
      onError('Verification failed — check the amounts (in cents) or the SM code.');
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Verify
      </Button>
    );
  }
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
      <button
        type="button"
        onClick={() => setMode(mode === 'amounts' ? 'code' : 'amounts')}
        title="Switch between two-amounts and SM-code entry"
        style={{
          background: 'transparent',
          border: 'none',
          color: tokens.color.accent,
          fontSize: 11,
          cursor: 'pointer',
          padding: 0,
        }}
      >
        {mode === 'amounts' ? 'have an SM code?' : 'have two amounts?'}
      </button>
      {mode === 'amounts' ? (
        <>
          <Input
            placeholder="e.g. 32"
            value={a0}
            onChange={(e) => setA0(e.target.value.replace(/\D/g, '').slice(0, 2))}
            style={{ width: 70 }}
            aria-label={`First deposit amount for ${row.displayLabel}`}
          />
          <Input
            placeholder="e.g. 45"
            value={a1}
            onChange={(e) => setA1(e.target.value.replace(/\D/g, '').slice(0, 2))}
            style={{ width: 70 }}
            aria-label={`Second deposit amount for ${row.displayLabel}`}
          />
        </>
      ) : (
        <Input
          placeholder="SM1234"
          value={code}
          onChange={(e) => setCode(e.target.value.slice(0, 10))}
          style={{ width: 90 }}
          aria-label={`Descriptor code for ${row.displayLabel}`}
        />
      )}
      <Button
        size="sm"
        onClick={() => void submit()}
        disabled={busy || (mode === 'amounts' ? !a0 || !a1 : code.trim().length < 4)}
      >
        {busy ? '…' : 'OK'}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
        ✕
      </Button>
    </div>
  );
}
