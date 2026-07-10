// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Admin → Operations → Data. Two destructive controls:
//   1. Load demo data — seeds ~150 clients + 400 engagements + 4k
//      time entries + 200 invoices into the current firm. Idempotent.
//   2. Reset to blank — TRUNCATEs every operational table while
//      preserving the firm row, staff identities, RBAC, taxonomy,
//      and the starter-pack engagement templates. Requires typed
//      confirmation ("delete everything").
//
// Both require firm:settings:write and a fresh step-up; if the
// server returns step_up_required the page surfaces an inline
// message pointing the user at the Account → Two-factor flow,
// matching the established pattern from AdjustmentDialog.tsx.

import { useState } from 'react';

import { Button, Card, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface DemoSeedResponse {
  ok: true;
  cleared: number;
  clients: number;
  engagements: number;
  timeEntries: number;
  invoices: number;
  folders: number;
}

interface ResetResponse {
  ok: true;
  tablesWiped: number;
}

const STEP_UP_HINT =
  'Your session needs a fresh second-factor verification. Go to Account → Two-factor, complete the challenge, then try again.';

export function DataPage(): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 800 }}>
      <LoadDemoCard />
      <ResetCard />
    </div>
  );
}

function LoadDemoCard(): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DemoSeedResponse | null>(null);

  async function run(): Promise<void> {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api<DemoSeedResponse>('/api/staff/admin/data/load-demo', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setResult(r);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'failed';
      setError(msg === 'step_up_required' ? STEP_UP_HINT : msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Load demo dataset">
      <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 0 }}>
        Seeds about 150 clients, 400 engagements, 4,000 time entries, 200 invoices, and 8 client
        folders so every dashboard has something to render. Re-running this clears the
        previously-seeded demo rows first — your real work outside the demo tracker is left
        untouched.
      </p>
      <p style={{ fontSize: 12, color: tokens.color.textMuted }}>
        Requires <code>firm:settings:write</code> and a fresh step-up. Idempotent. Takes roughly
        30–90 seconds.
      </p>
      <Button onClick={() => void run()} disabled={busy}>
        {busy ? 'Seeding…' : 'Load demo data'}
      </Button>
      {result && (
        <div style={{ marginTop: 12, fontSize: 13 }}>
          <strong>Seed complete.</strong>
          <ul style={{ marginTop: 6, paddingLeft: 20 }}>
            <li>Cleared previous demo rows: {result.cleared}</li>
            <li>Clients added: {result.clients}</li>
            <li>Engagements added: {result.engagements}</li>
            <li>Time entries added: {result.timeEntries}</li>
            <li>Invoices added: {result.invoices}</li>
            <li>File folders added: {result.folders}</li>
          </ul>
        </div>
      )}
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }} role="alert">
          {error}
        </p>
      )}
    </Card>
  );
}

function ResetCard(): JSX.Element {
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ResetResponse | null>(null);
  const matches = confirm === 'delete everything';

  async function run(): Promise<void> {
    if (!matches) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await api<ResetResponse>('/api/staff/admin/data/reset', {
        method: 'POST',
        body: JSON.stringify({ confirm: 'delete everything' }),
      });
      setDone(r);
      setConfirm('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'failed';
      setError(msg === 'step_up_required' ? STEP_UP_HINT : msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Reset to blank">
      <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 0 }}>
        Wipes every client, engagement, time entry, invoice, payment, adjustment, message, request,
        file, and audit-log row in the appliance. Preserves your firm record, staff accounts and
        credentials, roles + permissions, the eight default engagement templates, work codes,
        service lines, rate codes, notification templates, retainer tier configs, holidays, and
        offices.
      </p>
      <p style={{ fontSize: 13, color: tokens.color.danger }}>
        This action is permanent. The audit log is included in the wipe.
      </p>
      <p style={{ fontSize: 12, color: tokens.color.textMuted }}>
        Type <code>delete everything</code> below to enable the button. Requires
        <code> firm:settings:write</code> and a fresh step-up.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <input
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="delete everything"
          aria-label="Confirmation phrase"
          style={{
            flex: 1,
            padding: '6px 10px',
            background: tokens.color.surface,
            color: tokens.color.text,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.sm,
            fontSize: 13,
            fontFamily: tokens.font.body,
          }}
        />
        <Button onClick={() => void run()} disabled={!matches || busy} variant="danger">
          {busy ? 'Resetting…' : 'Reset to blank'}
        </Button>
      </div>
      {done && (
        <p style={{ fontSize: 13, marginTop: 10 }}>
          <strong>Reset complete.</strong> {done.tablesWiped} table
          {done.tablesWiped === 1 ? '' : 's'} wiped. The firm and starter-pack templates are intact.
        </p>
      )}
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }} role="alert">
          {error}
        </p>
      )}
    </Card>
  );
}
