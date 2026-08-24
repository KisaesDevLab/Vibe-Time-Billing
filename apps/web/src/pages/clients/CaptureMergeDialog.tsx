// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// DS-4 — apply a Capture Client Info result to an EXISTING client. Unlike
// the Create Client wizard (blank slate), this is a field-by-field merge:
// every captured value is shown next to the current one with a checkbox,
// pre-ticked only when the capture differs and is non-empty. Nothing is
// written until "Apply"; only ticked fields go into the PATCH. Custom
// fields merge (existing keys kept); an optional contact is added as a
// new client_contact, never overwriting one.

import { useMemo, useState } from 'react';
import { Button, Modal, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import type { MappedIntake } from './CaptureClientInfo';

export interface MergeableClient {
  id: string;
  name: string;
  clientType?: 'INDIVIDUAL' | 'BUSINESS';
  filingStatus?: 'SINGLE' | 'MFJ' | 'MFS' | 'HOH' | 'QW' | null;
  mailingStreet1?: string | null;
  mailingCity?: string | null;
  mailingState?: string | null;
  mailingPostal?: string | null;
  mailingCountry?: string | null;
  customFields?: Record<string, unknown> | null;
}

type ScalarKey =
  | 'name'
  | 'clientType'
  | 'filingStatus'
  | 'mailingStreet1'
  | 'mailingCity'
  | 'mailingState'
  | 'mailingPostal'
  | 'mailingCountry';

const LABELS: Record<ScalarKey, string> = {
  name: 'Name',
  clientType: 'Client type',
  filingStatus: 'Filing status',
  mailingStreet1: 'Street',
  mailingCity: 'City',
  mailingState: 'State',
  mailingPostal: 'ZIP',
  mailingCountry: 'Country',
};

interface Row {
  key: string; // ScalarKey or `cf:<name>`
  label: string;
  current: string;
  captured: string;
}

function str(v: unknown): string {
  return v == null ? '' : String(v);
}

export function CaptureMergeDialog({
  client,
  mapped,
  onClose,
  onSaved,
}: {
  client: MergeableClient;
  mapped: MappedIntake;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const c = mapped.client;
    const scalars: Array<[ScalarKey, unknown]> = [
      ['name', c.name],
      ['clientType', c.clientType],
      ['filingStatus', c.filingStatus],
      ['mailingStreet1', c.mailingStreet1],
      ['mailingCity', c.mailingCity],
      ['mailingState', c.mailingState],
      ['mailingPostal', c.mailingPostal],
      ['mailingCountry', c.mailingCountry],
    ];
    for (const [k, v] of scalars) {
      const captured = str(v);
      if (!captured) continue;
      out.push({ key: k, label: LABELS[k], current: str(client[k]), captured });
    }
    for (const [k, v] of Object.entries(c.customFields ?? {})) {
      const captured = str(v);
      if (!captured) continue;
      out.push({
        key: `cf:${k}`,
        label: k,
        current: str(client.customFields?.[k]),
        captured,
      });
    }
    return out;
  }, [client, mapped]);

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(rows.filter((r) => r.current !== r.captured).map((r) => r.key)),
  );
  const [addContact, setAddContact] = useState(!!mapped.contact?.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (key: string): void =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  async function apply(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const patch: Record<string, unknown> = {};
      const cf: Record<string, unknown> = { ...(client.customFields ?? {}) };
      let cfChanged = false;
      for (const r of rows) {
        if (!selected.has(r.key)) continue;
        if (r.key.startsWith('cf:')) {
          cf[r.key.slice(3)] = r.captured;
          cfChanged = true;
        } else {
          patch[r.key] = r.captured;
        }
      }
      if (cfChanged) patch['customFields'] = cf;
      if (Object.keys(patch).length > 0) {
        await api(`/api/staff/clients/${client.id}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        });
      }
      if (addContact && mapped.contact?.name) {
        await api(`/api/staff/clients/${client.id}/contacts`, {
          method: 'POST',
          body: JSON.stringify({
            fullName: mapped.contact.name,
            roleId: null,
            email: mapped.contact.email ?? null,
            phone: mapped.contact.phone ?? null,
            mobile: null,
            isPrimary: false,
            isBilling: false,
          }),
        });
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'apply_failed');
    } finally {
      setBusy(false);
    }
  }

  const cell: React.CSSProperties = {
    padding: '6px 8px',
    fontSize: 13,
    borderBottom: `1px solid ${tokens.color.border}`,
    verticalAlign: 'top',
  };

  return (
    <Modal title="Apply captured info" onClose={onClose} minWidth={560} maxWidth={760}>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: tokens.color.textMuted }}>
        Tick the fields to update. Unticked fields keep their current value. Pre-ticked rows are the
        ones where the capture differs.
      </p>
      {rows.length === 0 ? (
        <p style={{ fontSize: 13 }}>The capture produced no client fields to apply.</p>
      ) : (
        <div style={{ maxHeight: '50vh', overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...cell, width: 32 }} />
                <th style={{ ...cell, textAlign: 'left' }}>Field</th>
                <th style={{ ...cell, textAlign: 'left' }}>Current</th>
                <th style={{ ...cell, textAlign: 'left' }}>Captured</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const same = r.current === r.captured;
                return (
                  <tr key={r.key} style={{ opacity: same ? 0.6 : 1 }}>
                    <td style={cell}>
                      <input
                        type="checkbox"
                        aria-label={`Apply ${r.label}`}
                        checked={selected.has(r.key)}
                        onChange={() => toggle(r.key)}
                      />
                    </td>
                    <td style={cell}>{r.label}</td>
                    <td style={{ ...cell, color: tokens.color.textMuted }}>{r.current || '—'}</td>
                    <td style={{ ...cell, fontWeight: same ? 400 : 600 }}>{r.captured}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {mapped.contact?.name && (
        <label
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            marginTop: 12,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={addContact}
            onChange={(e) => setAddContact(e.target.checked)}
          />
          <span>
            Add <strong>{mapped.contact.name}</strong>
            {mapped.contact.email ? ` (${mapped.contact.email})` : ''} as a new contact
          </span>
        </label>
      )}
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12, margin: '12px 0 0' }}>{error}</p>
      )}
      <div
        style={{ display: 'flex', gap: tokens.space.sm, justifyContent: 'flex-end', marginTop: 16 }}
      >
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          onClick={() => void apply()}
          disabled={busy || (selected.size === 0 && !(addContact && mapped.contact?.name))}
        >
          {busy ? 'Applying…' : `Apply ${selected.size} field${selected.size === 1 ? '' : 's'}`}
        </Button>
      </div>
    </Modal>
  );
}
