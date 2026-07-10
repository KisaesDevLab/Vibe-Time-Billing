// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Direct-print control for the Vibe Print gateway. Renders nothing when
// the gateway isn't enabled (so it's safe to drop next to any "Open PDF"
// action). Clicking opens an inline panel: pick a printer (live list,
// preselecting the user's remembered default) + copies, then POST to the
// feature's print endpoint. Optionally remembers the chosen printer.

import { useEffect, useState } from 'react';

import { Button, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface GatewayPrinter {
  id: number;
  name: string;
  officeId?: string | null;
  officeName?: string | null;
}

interface Props {
  /** Feature print endpoint, e.g. `/api/staff/payments/receipt/abc/print`. */
  endpoint: string;
  label?: string;
  size?: 'sm' | 'md';
}

// Group printers under their office for the <optgroup> picker; unassigned
// printers fall under "Other".
function groupByOffice(
  printers: GatewayPrinter[],
): Array<{ label: string; printers: GatewayPrinter[] }> {
  const groups = new Map<string, GatewayPrinter[]>();
  for (const p of printers) {
    const key = p.officeName ?? 'Other';
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(p);
  }
  return Array.from(groups.entries())
    .sort((a, b) => (a[0] === 'Other' ? 1 : b[0] === 'Other' ? -1 : a[0].localeCompare(b[0])))
    .map(([label, ps]) => ({ label, printers: ps }));
}

export function PrintButton({ endpoint, label = 'Print', size = 'sm' }: Props): JSX.Element | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [defaultPrinterId, setDefaultPrinterId] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [printers, setPrinters] = useState<GatewayPrinter[] | null>(null);
  const [printerId, setPrinterId] = useState<number | ''>('');
  const [copies, setCopies] = useState(1);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api<{ enabled: boolean; defaultPrinterId: number | null }>('/api/staff/print/me')
      .then((r) => {
        setEnabled(r.enabled);
        setDefaultPrinterId(r.defaultPrinterId);
      })
      .catch(() => setEnabled(false));
  }, []);

  async function openPanel(): Promise<void> {
    setOpen(true);
    setMsg(null);
    if (printers) return;
    try {
      const r = await api<{ printers: GatewayPrinter[] }>('/api/staff/print/printers');
      setPrinters(r.printers);
      const initial =
        defaultPrinterId && r.printers.some((p) => p.id === defaultPrinterId)
          ? defaultPrinterId
          : (r.printers[0]?.id ?? '');
      setPrinterId(initial);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not load printers');
    }
  }

  async function doPrint(): Promise<void> {
    if (printerId === '') {
      setMsg('Choose a printer.');
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await api(endpoint, { method: 'POST', body: JSON.stringify({ printerId, copies }) });
      if (remember && printerId !== defaultPrinterId) {
        await api('/api/staff/print/default-printer', {
          method: 'PUT',
          body: JSON.stringify({ printerId }),
        }).catch(() => undefined);
        setDefaultPrinterId(printerId);
      }
      setMsg('Sent to printer.');
      setOpen(false);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Print failed');
    } finally {
      setBusy(false);
    }
  }

  // Hide entirely until we know the gateway is on.
  if (!enabled)
    return msg ? <span style={{ fontSize: 12, color: tokens.color.success }}>{msg}</span> : null;

  return (
    <span
      style={{ display: 'inline-flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}
    >
      <Button
        size={size}
        variant="secondary"
        onClick={() => (open ? setOpen(false) : void openPanel())}
      >
        {label}
      </Button>
      {open && (
        <div
          style={{
            display: 'grid',
            gap: 8,
            padding: 10,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
            background: tokens.color.surface,
            minWidth: 240,
          }}
        >
          {printers === null && !msg && (
            <span style={{ fontSize: 12, color: tokens.color.textMuted }}>Loading printers…</span>
          )}
          {printers !== null && printers.length === 0 && (
            <span style={{ fontSize: 12, color: tokens.color.textMuted }}>No printers found.</span>
          )}
          {printers !== null && printers.length > 0 && (
            <>
              <label style={{ fontSize: 12, display: 'grid', gap: 4 }}>
                Printer
                <select
                  value={printerId}
                  onChange={(e) => setPrinterId(e.target.value ? Number(e.target.value) : '')}
                  style={{
                    padding: '6px 10px',
                    background: tokens.color.surface,
                    color: tokens.color.text,
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.md,
                    fontSize: 13,
                  }}
                >
                  {groupByOffice(printers).map((g) => (
                    <optgroup key={g.label} label={g.label}>
                      {g.printers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              <label style={{ fontSize: 12, display: 'grid', gap: 4 }}>
                Copies
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={copies}
                  onChange={(e) =>
                    setCopies(Math.max(1, Math.min(20, Number(e.target.value) || 1)))
                  }
                  style={{
                    padding: '6px 10px',
                    background: tokens.color.surface,
                    color: tokens.color.text,
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.md,
                    fontSize: 13,
                    width: 80,
                  }}
                />
              </label>
              <label style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                Remember as my default
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button size="sm" disabled={busy} onClick={() => void doPrint()}>
                  {busy ? 'Sending…' : 'Print'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
              </div>
            </>
          )}
          {msg && <span style={{ fontSize: 12, color: tokens.color.danger }}>{msg}</span>}
        </div>
      )}
    </span>
  );
}
