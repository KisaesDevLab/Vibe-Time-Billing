// SPDX-License-Identifier: Elastic-2.0
//
// Admin → Stripe Terminal (Phases 15–17). Provision a Location + Reader on the
// firm's connected account, see reader status, and collect a payment in person
// against an invoice (card_present, manual capture). Server-driven — the result
// of the tap arrives via webhook; this screen lets staff capture/cancel.

import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, SectionHeading, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface ReaderRow {
  id: string;
  label: string;
  deviceType: string | null;
  serialNumber: string | null;
  status: string;
  locationId: string;
}
interface LocationRow {
  id: string;
  displayName: string;
  addressCity: string | null;
  addressState: string | null;
}

export function TerminalPage(): JSX.Element {
  const [readers, setReaders] = useState<ReaderRow[]>([]);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Forms
  const [loc, setLoc] = useState({
    displayName: '',
    line1: '',
    city: '',
    state: '',
    postalCode: '',
  });
  const [reader, setReader] = useState({ registrationCode: '', locationId: '', label: '' });
  const [collect, setCollect] = useState({ readerId: '', invoiceId: '', amount: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [active, setActive] = useState<{ paymentIntentId: string; actionStatus: string } | null>(
    null,
  );

  async function load(): Promise<void> {
    try {
      const r = await api<{ readers: ReaderRow[]; locations: LocationRow[] }>(
        '/api/staff/terminal/readers',
      );
      setReaders(r.readers);
      setLocations(r.locations);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'load_failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function addLocation(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy('loc');
    setErr(null);
    try {
      await api('/api/staff/terminal/locations', { method: 'POST', body: JSON.stringify(loc) });
      setLoc({ displayName: '', line1: '', city: '', state: '', postalCode: '' });
      setMsg('Location created.');
      await load();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'create_failed');
    } finally {
      setBusy(null);
    }
  }

  async function addReader(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy('reader');
    setErr(null);
    try {
      await api('/api/staff/terminal/readers', { method: 'POST', body: JSON.stringify(reader) });
      setReader({ registrationCode: '', locationId: '', label: '' });
      setMsg('Reader registered.');
      await load();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'register_failed');
    } finally {
      setBusy(null);
    }
  }

  async function doCollect(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy('collect');
    setErr(null);
    setActive(null);
    try {
      const r = await api<{ paymentIntentId: string; actionStatus: string }>(
        '/api/staff/terminal/collect',
        {
          method: 'POST',
          body: JSON.stringify({
            readerId: collect.readerId,
            invoiceId: collect.invoiceId,
            amountCents: Math.round(Number(collect.amount) * 100),
          }),
        },
      );
      setActive(r);
      setMsg('Sent to reader — ask the client to tap or insert their card.');
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'collect_failed');
    } finally {
      setBusy(null);
    }
  }

  async function capture(): Promise<void> {
    if (!active) return;
    setBusy('capture');
    try {
      await api('/api/staff/terminal/capture', {
        method: 'POST',
        body: JSON.stringify({ paymentIntentId: active.paymentIntentId }),
      });
      setMsg('Payment captured.');
      setActive(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'capture_failed');
    } finally {
      setBusy(null);
    }
  }

  async function cancel(): Promise<void> {
    if (!active) return;
    setBusy('cancel');
    try {
      await api('/api/staff/terminal/cancel', {
        method: 'POST',
        body: JSON.stringify({ paymentIntentId: active.paymentIntentId }),
      });
      setMsg('Payment canceled.');
      setActive(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'cancel_failed');
    } finally {
      setBusy(null);
    }
  }

  async function resetReader(id: string): Promise<void> {
    setBusy(`reset-${id}`);
    try {
      await api(`/api/staff/terminal/readers/${id}/cancel-action`, { method: 'POST', body: '{}' });
      setMsg('Reader reset.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'reset_failed');
    } finally {
      setBusy(null);
    }
  }

  const input: React.CSSProperties = {
    padding: '6px 8px',
    fontSize: 13,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.sm,
  };

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100, alignContent: 'start' }}>
      <SectionHeading
        title="In-person card payments (Terminal)"
        description="Provision a card reader on your connected Stripe account and collect payments at the office. Requires Stripe Connect to be set up."
      />

      {msg && <p style={{ color: tokens.color.success, fontSize: 12, margin: 0 }}>{msg}</p>}
      {err && <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }}>{err}</p>}

      <Card title="Collect a payment in person">
        <form
          onSubmit={doCollect}
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}
        >
          <label style={{ display: 'grid', gap: 2, fontSize: 11, color: tokens.color.textMuted }}>
            Reader
            <select
              value={collect.readerId}
              onChange={(e) => setCollect({ ...collect, readerId: e.target.value })}
              required
              style={input}
            >
              <option value="">— pick a reader —</option>
              {readers.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label} ({r.status})
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'grid', gap: 2, fontSize: 11, color: tokens.color.textMuted }}>
            Invoice ID
            <input
              style={{ ...input, width: 320 }}
              value={collect.invoiceId}
              onChange={(e) => setCollect({ ...collect, invoiceId: e.target.value })}
              placeholder="invoice uuid"
              required
            />
          </label>
          <label style={{ display: 'grid', gap: 2, fontSize: 11, color: tokens.color.textMuted }}>
            Amount ($)
            <input
              style={{ ...input, width: 120 }}
              type="number"
              min="0"
              step="0.01"
              value={collect.amount}
              onChange={(e) => setCollect({ ...collect, amount: e.target.value })}
              required
            />
          </label>
          <Button type="submit" size="sm" disabled={busy === 'collect' || readers.length === 0}>
            {busy === 'collect' ? 'Sending…' : 'Send to reader'}
          </Button>
        </form>
        {readers.length === 0 && (
          <p style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 0 }}>
            Register a reader below first.
          </p>
        )}
        {active && (
          <div
            style={{
              marginTop: 12,
              padding: 12,
              border: `1px solid ${tokens.color.accent}`,
              borderRadius: tokens.radius.sm,
              display: 'flex',
              gap: 12,
              alignItems: 'center',
            }}
          >
            <div style={{ flex: 1, fontSize: 13 }}>
              Payment <code>{active.paymentIntentId}</code> — reader{' '}
              <Pill tone="accent">{active.actionStatus}</Pill>. Capture once the client has
              tapped/inserted and it succeeds.
            </div>
            <Button size="sm" onClick={() => void capture()} disabled={busy === 'capture'}>
              {busy === 'capture' ? 'Capturing…' : 'Capture'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void cancel()}
              disabled={busy === 'cancel'}
            >
              Cancel
            </Button>
          </div>
        )}
      </Card>

      <Card title="Readers">
        <Table<ReaderRow>
          columns={[
            { key: 'label', header: 'Label', render: (r) => r.label },
            { key: 'device', header: 'Device', render: (r) => r.deviceType ?? '—' },
            { key: 'serial', header: 'Serial', render: (r) => r.serialNumber ?? '—' },
            {
              key: 'status',
              header: 'Status',
              render: (r) => (
                <Pill tone={r.status === 'online' ? 'success' : 'neutral'}>{r.status}</Pill>
              ),
            },
            {
              key: 'reset',
              header: '',
              render: (r) => (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void resetReader(r.id)}
                  disabled={busy === `reset-${r.id}`}
                  title="Reset a stuck reader"
                >
                  Reset
                </Button>
              ),
            },
          ]}
          rows={readers}
          rowKey={(r) => r.id}
          empty="No readers registered yet."
        />
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.space.lg }}>
        <Card title="Register a reader">
          <form onSubmit={addReader} style={{ display: 'grid', gap: 8 }}>
            <Input
              label="Reader label"
              value={reader.label}
              onChange={(e) => setReader({ ...reader, label: e.target.value })}
              required
            />
            <Input
              label="Registration / pairing code"
              value={reader.registrationCode}
              onChange={(e) => setReader({ ...reader, registrationCode: e.target.value })}
              placeholder="from the reader's settings screen"
              required
            />
            <label style={{ fontSize: 11, color: tokens.color.textMuted }}>
              Location
              <select
                value={reader.locationId}
                onChange={(e) => setReader({ ...reader, locationId: e.target.value })}
                required
                style={{ ...input, width: '100%' }}
              >
                <option value="">— pick a location —</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.displayName}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit" size="sm" disabled={busy === 'reader' || locations.length === 0}>
              {busy === 'reader' ? 'Registering…' : 'Register reader'}
            </Button>
          </form>
        </Card>

        <Card title="Add a location">
          <form onSubmit={addLocation} style={{ display: 'grid', gap: 8 }}>
            <Input
              label="Display name"
              value={loc.displayName}
              onChange={(e) => setLoc({ ...loc, displayName: e.target.value })}
              required
            />
            <Input
              label="Address line 1"
              value={loc.line1}
              onChange={(e) => setLoc({ ...loc, line1: e.target.value })}
              required
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <Input
                label="City"
                value={loc.city}
                onChange={(e) => setLoc({ ...loc, city: e.target.value })}
                required
              />
              <Input
                label="State"
                value={loc.state}
                onChange={(e) => setLoc({ ...loc, state: e.target.value })}
                required
              />
              <Input
                label="ZIP"
                value={loc.postalCode}
                onChange={(e) => setLoc({ ...loc, postalCode: e.target.value })}
                required
              />
            </div>
            <Button type="submit" size="sm" disabled={busy === 'loc'}>
              {busy === 'loc' ? 'Creating…' : 'Add location'}
            </Button>
          </form>
        </Card>
      </div>

      <p style={{ fontSize: 11, color: tokens.color.textMuted }}>
        Default hardware: Stripe Reader S700 (or S710 where office internet is unreliable). After a
        tap, the reader reports back automatically; in-person card-present rates apply, and a saved
        card from in person charges as card-not-present on later recurring runs.
      </p>
    </div>
  );
}
