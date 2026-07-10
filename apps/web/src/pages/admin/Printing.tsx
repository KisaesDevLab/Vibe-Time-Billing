// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Admin → Printing. Configure the Vibe Print LAN gateway (base URL +
// bearer key), pick a firm default printer (used for automated prints
// like the signature-confirmation auto-print), and toggle that
// automation. "Test" lists the gateway's printers to validate the
// connection. The bearer key is write-only (shown masked after save).

import { useEffect, useState } from 'react';

import { Button, Card, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface MaskedConfig {
  baseUrl: string | null;
  apiKeyMasked: string | null;
  enabled: boolean;
  defaultPrinterId: number | null;
  autoPrintSignatureConfirmation: boolean;
}
interface GatewayPrinter {
  id: number;
  name: string;
}

const fieldStyle: React.CSSProperties = {
  padding: '6px 10px',
  background: tokens.color.surface,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  fontSize: 13,
  minWidth: 320,
};

export function PrintingPage(): JSX.Element {
  const [cfg, setCfg] = useState<MaskedConfig | null>(null);
  const [kmsReady, setKmsReady] = useState(true);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [autoPrint, setAutoPrint] = useState(false);
  const [defaultPrinterId, setDefaultPrinterId] = useState<number | ''>('');
  const [printers, setPrinters] = useState<GatewayPrinter[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(): Promise<void> {
    try {
      const r = await api<{ config: MaskedConfig; kmsReady: boolean }>(
        '/api/staff/admin/print-gateway',
      );
      setCfg(r.config);
      setKmsReady(r.kmsReady);
      setBaseUrl(r.config.baseUrl ?? '');
      setEnabled(r.config.enabled);
      setAutoPrint(r.config.autoPrintSignatureConfirmation);
      setDefaultPrinterId(r.config.defaultPrinterId ?? '');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'load_failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function save(): Promise<void> {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      await api('/api/staff/admin/print-gateway', {
        method: 'PUT',
        body: JSON.stringify({
          baseUrl,
          ...(apiKey ? { apiKey } : {}),
          enabled,
          autoPrintSignatureConfirmation: autoPrint,
          defaultPrinterId: defaultPrinterId === '' ? null : defaultPrinterId,
        }),
      });
      setApiKey('');
      setMsg('Saved.');
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'save_failed');
    } finally {
      setBusy(false);
    }
  }

  async function test(): Promise<void> {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await api<{ ok: boolean; printers: GatewayPrinter[] }>(
        '/api/staff/admin/print-gateway/test',
        { method: 'POST', body: JSON.stringify({ baseUrl, ...(apiKey ? { apiKey } : {}) }) },
      );
      setPrinters(r.printers);
      setMsg(`Connected — ${r.printers.length} printer(s) found.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'test_failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 760 }}>
      <Card title="Vibe Print gateway">
        {!kmsReady && (
          <p style={{ color: tokens.color.danger, fontSize: 12 }}>
            Encryption key (KMS_KEY) unavailable — credentials cannot be stored until the appliance
            is unlocked.
          </p>
        )}
        <p style={{ fontSize: 12, color: tokens.color.textMuted }}>
          Point the app at your self-hosted Vibe Print gateway to print directly to LAN printers (no
          browser dialog). The base URL must be reachable from the app server (e.g.{' '}
          <code>http://192.168.1.50:8080</code>); the key is the gateway&rsquo;s{' '}
          <code>VIBE_PRINT_SECRET</code>.
        </p>
        <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
          <label style={{ fontSize: 13, display: 'grid', gap: 4 }}>
            Gateway base URL
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://printer-host:8080"
              style={fieldStyle}
            />
          </label>
          <label style={{ fontSize: 13, display: 'grid', gap: 4 }}>
            API key{' '}
            {cfg?.apiKeyMasked && (
              <span style={{ color: tokens.color.textMuted }}>(stored: {cfg.apiKeyMasked})</span>
            )}
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={cfg?.apiKeyMasked ? 'leave blank to keep' : 'Bearer secret'}
              style={fieldStyle}
            />
          </label>
          <label style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enable direct printing
          </label>

          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label style={{ fontSize: 13, display: 'grid', gap: 4 }}>
              Default printer (for automated prints)
              {printers ? (
                <select
                  value={defaultPrinterId}
                  onChange={(e) =>
                    setDefaultPrinterId(e.target.value ? Number(e.target.value) : '')
                  }
                  style={fieldStyle}
                >
                  <option value="">— none —</option>
                  {printers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} (#{p.id})
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="number"
                  value={defaultPrinterId}
                  onChange={(e) =>
                    setDefaultPrinterId(e.target.value ? Number(e.target.value) : '')
                  }
                  placeholder="printer id (run Test to list)"
                  style={fieldStyle}
                />
              )}
            </label>
          </div>

          <label style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={autoPrint}
              onChange={(e) => setAutoPrint(e.target.checked)}
            />
            Auto-print a signature confirmation report when a tax return is signed
          </label>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button disabled={busy} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => void test()}>
              Test connection
            </Button>
            {msg && <span style={{ fontSize: 12, color: tokens.color.success }}>{msg}</span>}
            {err && <span style={{ fontSize: 12, color: tokens.color.danger }}>{err}</span>}
          </div>
        </div>
      </Card>

      <PrinterAssignments />
    </div>
  );
}

interface AssignmentRow {
  gatewayPrinterId: number;
  officeId: string | null;
  label: string | null;
  enabled: boolean;
}

function PrinterAssignments(): JSX.Element {
  const [printers, setPrinters] = useState<GatewayPrinter[]>([]);
  const [officeList, setOfficeList] = useState<{ id: string; name: string }[]>([]);
  const [byId, setById] = useState<Record<number, AssignmentRow>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const r = await api<{
        printers: GatewayPrinter[];
        offices: { id: string; name: string }[];
        assignments: AssignmentRow[];
      }>('/api/staff/admin/print-gateway/assignments');
      setPrinters(r.printers);
      setOfficeList(r.offices);
      const map: Record<number, AssignmentRow> = {};
      for (const a of r.assignments) map[a.gatewayPrinterId] = a;
      setById(map);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'load_failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  function rowFor(id: number): AssignmentRow {
    return byId[id] ?? { gatewayPrinterId: id, officeId: null, label: null, enabled: true };
  }
  function update(id: number, patch: Partial<AssignmentRow>): void {
    setById((m) => ({ ...m, [id]: { ...rowFor(id), ...patch } }));
  }
  async function save(id: number): Promise<void> {
    setMsg(null);
    setErr(null);
    const row = rowFor(id);
    try {
      await api('/api/staff/admin/print-gateway/assignments', {
        method: 'PUT',
        body: JSON.stringify({
          gatewayPrinterId: id,
          officeId: row.officeId,
          label: row.label || null,
          enabled: row.enabled,
        }),
      });
      setMsg('Saved.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'save_failed');
    }
  }

  return (
    <Card title="Printer assignments (by location)">
      <p style={{ fontSize: 12, color: tokens.color.textMuted }}>
        Assign each printer to an office so staff see printers grouped by location. Run{' '}
        <strong>Test connection</strong> above first to load the gateway&rsquo;s printers.
      </p>
      {printers.length === 0 ? (
        <p style={{ fontSize: 12, color: tokens.color.textMuted }}>
          No printers loaded (gateway not configured or unreachable).
        </p>
      ) : (
        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
          {printers.map((p) => {
            const row = rowFor(p.id);
            return (
              <div
                key={p.id}
                style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
              >
                <strong style={{ fontSize: 13, minWidth: 160 }}>
                  {p.name} <span style={{ color: tokens.color.textMuted }}>#{p.id}</span>
                </strong>
                <select
                  value={row.officeId ?? ''}
                  onChange={(e) => update(p.id, { officeId: e.target.value || null })}
                  style={fieldStyle}
                >
                  <option value="">— no office —</option>
                  {officeList.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
                <input
                  value={row.label ?? ''}
                  onChange={(e) => update(p.id, { label: e.target.value })}
                  placeholder="label (optional)"
                  style={{ ...fieldStyle, minWidth: 160 }}
                />
                <label style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={row.enabled}
                    onChange={(e) => update(p.id, { enabled: e.target.checked })}
                  />
                  enabled
                </label>
                <Button size="sm" onClick={() => void save(p.id)}>
                  Save
                </Button>
              </div>
            );
          })}
          {msg && <span style={{ fontSize: 12, color: tokens.color.success }}>{msg}</span>}
          {err && <span style={{ fontSize: 12, color: tokens.color.danger }}>{err}</span>}
        </div>
      )}
    </Card>
  );
}
