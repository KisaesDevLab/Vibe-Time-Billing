/* eslint-disable jsx-a11y/label-has-associated-control -- labels and controls are siblings inside grid containers; revisit with htmlFor/id pairs in a polish pass */
// SPDX-License-Identifier: Elastic-2.0
//
// Firm-wide Tax Payments tab. Lists every scheduled tax payment for
// the firm with per-column substring filters and column-header
// sorting. The first column is a checkbox; selecting one or more
// rows enables a "Send reminder" toolbar action that opens a modal
// to pick channels (email / SMS) and dispatch via the firm's
// configured providers. Backed by GET /api/staff/tax-payments and
// POST /api/staff/tax-payments/bulk-remind.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface PaymentRow {
  id: string;
  clientId: string;
  clientName: string;
  jurisdiction: string;
  paymentType: string;
  paymentUrl: string | null;
  taxYear: number | null;
  amountCents: number;
  dueDate: string;
  status: 'SCHEDULED' | 'PAID' | 'VOIDED';
}

type SortKey = 'client' | 'jurisdiction' | 'type' | 'amount' | 'dueDate';
type SortDir = 'asc' | 'desc';

const STATUS_OPTIONS = ['SCHEDULED', 'PAID', 'VOIDED', 'ALL'] as const;
type StatusFilter = (typeof STATUS_OPTIONS)[number];

interface ReminderResult {
  results: Array<{
    clientId: string;
    clientName: string;
    sentEmail: number;
    sentSms: number;
    skipped: string[];
    errors: string[];
  }>;
  summary: {
    clients: number;
    emailsSent: number;
    smsSent: number;
    clientsWithoutContact: number;
  };
}

export function TaxPaymentsTab(): JSX.Element {
  const [rows, setRows] = useState<PaymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [sortBy, setSortBy] = useState<SortKey>('dueDate');
  const [dir, setDir] = useState<SortDir>('asc');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('SCHEDULED');
  const [clientQ, setClientQ] = useState('');
  const [jurisdictionQ, setJurisdictionQ] = useState('');
  const [typeQ, setTypeQ] = useState('');
  const [dueFrom, setDueFrom] = useState('');
  const [dueTo, setDueTo] = useState('');

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reminderOpen, setReminderOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ sortBy, dir });
      if (statusFilter !== 'ALL') qs.set('status', statusFilter);
      if (clientQ.trim()) qs.set('clientQ', clientQ.trim());
      if (jurisdictionQ.trim()) qs.set('jurisdictionQ', jurisdictionQ.trim());
      if (typeQ.trim()) qs.set('typeQ', typeQ.trim());
      if (dueFrom) qs.set('dueFrom', dueFrom);
      if (dueTo) qs.set('dueTo', dueTo);
      const r = await api<{ items: PaymentRow[] }>(`/api/staff/tax-payments?${qs.toString()}`);
      setRows(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load_failed');
    } finally {
      setLoading(false);
    }
  }, [sortBy, dir, statusFilter, clientQ, jurisdictionQ, typeQ, dueFrom, dueTo]);

  useEffect(() => {
    void load();
  }, [load]);

  function toggleRow(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll(): void {
    if (selected.size === rows.length) setSelected(new Set());
    else setSelected(new Set(rows.map((r) => r.id)));
  }

  function setSort(key: SortKey): void {
    if (sortBy === key) {
      setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(key);
      setDir('asc');
    }
  }

  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);
  const selectedClientCount = useMemo(
    () => new Set(selectedRows.map((r) => r.clientId)).size,
    [selectedRows],
  );
  const totalCents = useMemo(
    () => selectedRows.reduce((acc, r) => acc + r.amountCents, 0),
    [selectedRows],
  );

  return (
    <Card
      title="Tax payments — firm-wide"
      action={
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
            {selected.size > 0
              ? `${selected.size} selected · ${selectedClientCount} client${selectedClientCount === 1 ? '' : 's'} · $${(totalCents / 100).toFixed(2)}`
              : `${rows.length} row${rows.length === 1 ? '' : 's'}`}
          </span>
          <Button
            size="sm"
            variant={selected.size > 0 ? 'secondary' : 'ghost'}
            disabled={selected.size === 0}
            onClick={() => setReminderOpen(true)}
          >
            Send reminder
          </Button>
        </div>
      }
    >
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }}>{error}</p>
      )}

      {/* Per-column filter row above the table. Status + date window
          sit at the top so they're easy to reach. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
          gap: 8,
          marginBottom: 10,
          fontSize: 12,
        }}
      >
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          style={selStyle()}
        >
          <option value="SCHEDULED">Scheduled</option>
          <option value="PAID">Paid</option>
          <option value="VOIDED">Voided</option>
          <option value="ALL">All statuses</option>
        </select>
        <input
          type="date"
          value={dueFrom}
          onChange={(e) => setDueFrom(e.target.value)}
          placeholder="Due from"
          aria-label="Due from"
          style={selStyle()}
        />
        <input
          type="date"
          value={dueTo}
          onChange={(e) => setDueTo(e.target.value)}
          placeholder="Due to"
          aria-label="Due to"
          style={selStyle()}
        />
        <input
          type="text"
          value={clientQ}
          onChange={(e) => setClientQ(e.target.value)}
          placeholder="Search client…"
          style={selStyle()}
        />
        <input
          type="text"
          value={jurisdictionQ}
          onChange={(e) => setJurisdictionQ(e.target.value)}
          placeholder="Search jurisdiction…"
          style={selStyle()}
        />
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, fontSize: 12 }}>
        <input
          type="text"
          value={typeQ}
          onChange={(e) => setTypeQ(e.target.value)}
          placeholder="Search payment type…"
          style={{ ...selStyle(), maxWidth: 280 }}
        />
        {(clientQ ||
          jurisdictionQ ||
          typeQ ||
          dueFrom ||
          dueTo ||
          statusFilter !== 'SCHEDULED') && (
          <button
            type="button"
            onClick={() => {
              setClientQ('');
              setJurisdictionQ('');
              setTypeQ('');
              setDueFrom('');
              setDueTo('');
              setStatusFilter('SCHEDULED');
            }}
            style={{
              background: 'none',
              border: 'none',
              color: tokens.color.accent,
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {loading ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
          No tax payments match the current filters.
        </p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${tokens.color.border}` }}>
              <th style={th()}>
                <input
                  type="checkbox"
                  checked={selected.size === rows.length && rows.length > 0}
                  ref={(el) => {
                    if (el) {
                      el.indeterminate = selected.size > 0 && selected.size < rows.length;
                    }
                  }}
                  onChange={toggleAll}
                  aria-label="Select all"
                />
              </th>
              <SortableHeader
                label="Client"
                k="client"
                current={sortBy}
                dir={dir}
                onSort={setSort}
              />
              <SortableHeader
                label="Jurisdiction"
                k="jurisdiction"
                current={sortBy}
                dir={dir}
                onSort={setSort}
              />
              <SortableHeader label="Type" k="type" current={sortBy} dir={dir} onSort={setSort} />
              <SortableHeader
                label="Amount"
                k="amount"
                current={sortBy}
                dir={dir}
                onSort={setSort}
                align="right"
              />
              <SortableHeader label="Due" k="dueDate" current={sortBy} dir={dir} onSort={setSort} />
              <th style={th()}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                style={{
                  borderBottom: `1px solid ${tokens.color.border}`,
                  background: selected.has(r.id) ? tokens.color.surface : 'transparent',
                }}
              >
                <td style={td()}>
                  <input
                    type="checkbox"
                    checked={selected.has(r.id)}
                    onChange={() => toggleRow(r.id)}
                    aria-label={`Select ${r.clientName} ${r.paymentType}`}
                  />
                </td>
                <td style={td()}>
                  <Link
                    to={`/clients/${r.clientId}`}
                    style={{ color: tokens.color.accent, textDecoration: 'none' }}
                  >
                    {r.clientName}
                  </Link>
                </td>
                <td style={td()}>{r.jurisdiction}</td>
                <td style={td()}>{r.paymentType}</td>
                <td style={{ ...td(), textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  ${(r.amountCents / 100).toFixed(2)}
                </td>
                <td style={td()}>{new Date(r.dueDate).toLocaleDateString()}</td>
                <td style={td()}>
                  <Pill
                    tone={
                      r.status === 'SCHEDULED'
                        ? 'warning'
                        : r.status === 'PAID'
                          ? 'success'
                          : 'neutral'
                    }
                  >
                    {r.status}
                  </Pill>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {reminderOpen && (
        <ReminderDialog
          rows={selectedRows}
          onClose={() => setReminderOpen(false)}
          onDone={() => {
            setSelected(new Set());
            setReminderOpen(false);
          }}
        />
      )}
    </Card>
  );
}

function SortableHeader({
  label,
  k,
  current,
  dir,
  onSort,
  align = 'left',
}: {
  label: string;
  k: SortKey;
  current: SortKey;
  dir: SortDir;
  onSort: (k: SortKey) => void;
  align?: 'left' | 'right';
}): JSX.Element {
  const active = current === k;
  return (
    <th style={th(align)}>
      <button
        type="button"
        onClick={() => onSort(k)}
        style={{
          background: 'none',
          border: 'none',
          color: active ? tokens.color.accent : tokens.color.textMuted,
          font: 'inherit',
          fontWeight: 600,
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          cursor: 'pointer',
          padding: 0,
        }}
      >
        {label}
        {active ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
      </button>
    </th>
  );
}

function ReminderDialog({
  rows,
  onClose,
  onDone,
}: {
  rows: PaymentRow[];
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [email, setEmail] = useState(true);
  const [sms, setSms] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReminderResult | null>(null);

  const clients = useMemo(() => {
    const map = new Map<string, { name: string; count: number; total: number }>();
    for (const r of rows) {
      const cur = map.get(r.clientId) ?? { name: r.clientName, count: 0, total: 0 };
      cur.count += 1;
      cur.total += r.amountCents;
      map.set(r.clientId, cur);
    }
    return Array.from(map.values());
  }, [rows]);

  async function send(): Promise<void> {
    if (!email && !sms) {
      setError('Pick at least one channel.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const channels: Array<'email' | 'sms'> = [];
      if (email) channels.push('email');
      if (sms) channels.push('sms');
      const r = await api<ReminderResult>('/api/staff/tax-payments/bulk-remind', {
        method: 'POST',
        body: JSON.stringify({
          paymentIds: rows.map((x) => x.id),
          channels,
          note: note.trim() || undefined,
        }),
      });
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'send_failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 56,
        zIndex: 200,
      }}
    >
      <div style={{ minWidth: 560, maxWidth: 720, maxHeight: '85vh', overflow: 'auto' }}>
        <Card title="Send tax payment reminder">
          {!result ? (
            <div style={{ display: 'grid', gap: 12 }}>
              <p style={{ fontSize: 13, margin: 0 }}>
                Sending reminders for{' '}
                <strong>
                  {rows.length} payment{rows.length === 1 ? '' : 's'} across {clients.length} client
                  {clients.length === 1 ? '' : 's'}
                </strong>
                . One message per client (per channel) summarizing every selected payment.
              </p>
              <ul
                style={{
                  margin: 0,
                  padding: '8px 16px',
                  background: tokens.color.surface,
                  borderRadius: tokens.radius.sm,
                  fontSize: 12,
                  maxHeight: 160,
                  overflow: 'auto',
                }}
              >
                {clients.map((c) => (
                  <li key={c.name}>
                    {c.name} — {c.count} payment{c.count === 1 ? '' : 's'}, $
                    {(c.total / 100).toFixed(2)}
                  </li>
                ))}
              </ul>
              <fieldset
                style={{
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  padding: 10,
                }}
              >
                <legend
                  style={{
                    padding: '0 6px',
                    fontSize: 11,
                    color: tokens.color.textMuted,
                    textTransform: 'uppercase',
                    letterSpacing: 0.4,
                  }}
                >
                  Channels
                </legend>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={email}
                    onChange={(e) => setEmail(e.target.checked)}
                  />{' '}
                  Email
                </label>
                <label
                  style={{
                    display: 'flex',
                    gap: 6,
                    alignItems: 'center',
                    fontSize: 13,
                    marginTop: 4,
                  }}
                >
                  <input type="checkbox" checked={sms} onChange={(e) => setSms(e.target.checked)} />{' '}
                  SMS
                </label>
              </fieldset>
              <div style={{ display: 'grid', gap: 4 }}>
                <label style={{ fontSize: 11, color: tokens.color.textMuted }}>
                  Optional note (appended to email body)
                </label>
                <textarea
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  style={{
                    padding: '8px 10px',
                    fontSize: 13,
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.sm,
                    background: tokens.color.bg,
                    color: tokens.color.text,
                    resize: 'vertical',
                  }}
                />
              </div>
              {error && (
                <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }} role="alert">
                  {error}
                </p>
              )}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <Button variant="ghost" onClick={onClose} disabled={busy}>
                  Cancel
                </Button>
                <Button disabled={busy} onClick={() => void send()}>
                  {busy
                    ? 'Sending…'
                    : `Send to ${clients.length} client${clients.length === 1 ? '' : 's'}`}
                </Button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              <p style={{ fontSize: 13, margin: 0 }}>
                <strong>Done.</strong> {result.summary.emailsSent} email
                {result.summary.emailsSent === 1 ? '' : 's'} sent, {result.summary.smsSent} SMS sent
                across {result.summary.clients} client{result.summary.clients === 1 ? '' : 's'}.
                {result.summary.clientsWithoutContact > 0 && (
                  <>
                    {' '}
                    <span style={{ color: tokens.color.warning }}>
                      {result.summary.clientsWithoutContact} client
                      {result.summary.clientsWithoutContact === 1 ? '' : 's'} had no active portal
                      contacts.
                    </span>
                  </>
                )}
              </p>
              <ul
                style={{
                  margin: 0,
                  padding: '8px 16px',
                  background: tokens.color.surface,
                  borderRadius: tokens.radius.sm,
                  fontSize: 12,
                  maxHeight: 200,
                  overflow: 'auto',
                }}
              >
                {result.results.map((r) => (
                  <li key={r.clientId} style={{ marginBottom: 4 }}>
                    <strong>{r.clientName}</strong> — {r.sentEmail} email, {r.sentSms} SMS
                    {r.skipped.length > 0 && (
                      <>
                        {' · '}
                        <span style={{ color: tokens.color.warning }}>
                          skipped: {r.skipped.join('; ')}
                        </span>
                      </>
                    )}
                    {r.errors.length > 0 && (
                      <>
                        {' · '}
                        <span style={{ color: tokens.color.danger }}>
                          errors: {r.errors.join('; ')}
                        </span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button onClick={onDone}>Close</Button>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function th(align: 'left' | 'right' = 'left'): React.CSSProperties {
  return {
    textAlign: align,
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    color: tokens.color.textMuted,
    padding: '6px 8px',
  };
}
function td(): React.CSSProperties {
  return { padding: '6px 8px', verticalAlign: 'middle' };
}
function selStyle(): React.CSSProperties {
  return {
    padding: '6px 8px',
    fontSize: 12,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.sm,
    background: tokens.color.surface,
    color: tokens.color.text,
  };
}
