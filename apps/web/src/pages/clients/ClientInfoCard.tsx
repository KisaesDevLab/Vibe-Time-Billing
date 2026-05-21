// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Client Info card on the Home tab (v2 followup) with inline pencil-
// edit. Exposes the v2 expansion fields (clientType, externalId,
// filingStatus, pipelineStage, active, termsDays, partnerInChargeId).

import { useEffect, useState } from 'react';

import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface Client {
  id: string;
  name: string;
  status: string;
  termsDays: number;
  invoiceConsolidationPreference: 'CONSOLIDATED' | 'SEPARATE';
  partnerInChargeId: string | null;
  createdAt: string;
  clientType?: 'INDIVIDUAL' | 'BUSINESS';
  clientFacingName?: string | null;
  externalId?: string | null;
  filingStatus?: 'SINGLE' | 'MFJ' | 'MFS' | 'HOH' | 'QW' | null;
  pipelineStage?: 'PROSPECT' | 'CLIENT' | 'OTHER';
  active?: boolean;
}

interface Partner {
  id: string;
  fullName: string;
}

interface Props {
  client: Client;
  onSaved: (patch: Partial<Client>) => void;
}

const fieldStyle: React.CSSProperties = {
  padding: '6px 8px',
  background: tokens.color.surface,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  fontSize: 13,
  width: '100%',
  boxSizing: 'border-box',
};

export function ClientInfoCard({ client, onSaved }: Props): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Partial<Client>>({});
  const [partners, setPartners] = useState<Partner[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing || partners.length > 0) return;
    void (async () => {
      try {
        const r = await api<{ users: Partner[] }>('/api/staff/admin/users');
        setPartners(r.users ?? []);
      } catch {
        // Non-fatal: partner dropdown stays empty.
      }
    })();
  }, [editing, partners.length]);

  function begin(): void {
    setDraft({});
    setError(null);
    setEditing(true);
  }

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // Only send fields that actually changed.
      const body: Record<string, unknown> = {};
      for (const k of Object.keys(draft) as Array<keyof Client>) {
        const v = draft[k];
        if (v !== undefined) body[k as string] = v;
      }
      if (Object.keys(body).length === 0) {
        setEditing(false);
        return;
      }
      await api(`/api/staff/clients/${client.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      onSaved(draft);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save_failed');
    } finally {
      setBusy(false);
    }
  }

  const v = (key: keyof Client) =>
    draft[key] !== undefined ? draft[key] : (client[key] as unknown);

  return (
    <Card
      title="Client info"
      action={
        editing ? (
          <span style={{ display: 'flex', gap: 6 }}>
            <Button size="sm" onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setDraft({});
              }}
            >
              Cancel
            </Button>
          </span>
        ) : (
          <Button size="sm" variant="ghost" onClick={begin}>
            Edit
          </Button>
        )
      }
    >
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
          {error}
        </p>
      )}
      {editing ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Name">
            <input
              value={(v('name') as string) ?? ''}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              style={fieldStyle}
            />
          </Field>
          <Field label="Client-facing name">
            <input
              value={(v('clientFacingName') as string) ?? ''}
              onChange={(e) => setDraft({ ...draft, clientFacingName: e.target.value || null })}
              style={fieldStyle}
            />
          </Field>
          <Field label="Client owner">
            <select
              value={(v('partnerInChargeId') as string) ?? ''}
              onChange={(e) => setDraft({ ...draft, partnerInChargeId: e.target.value })}
              style={fieldStyle}
            >
              <option value="">— none —</option>
              {partners.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.fullName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="External ID">
            <input
              value={(v('externalId') as string) ?? ''}
              onChange={(e) => setDraft({ ...draft, externalId: e.target.value || null })}
              style={fieldStyle}
            />
          </Field>
          <Field label="Client type">
            <select
              value={(v('clientType') as string) ?? 'BUSINESS'}
              onChange={(e) =>
                setDraft({ ...draft, clientType: e.target.value as 'INDIVIDUAL' | 'BUSINESS' })
              }
              style={fieldStyle}
            >
              <option value="INDIVIDUAL">Individual</option>
              <option value="BUSINESS">Business</option>
            </select>
          </Field>
          {(v('clientType') ?? 'BUSINESS') === 'INDIVIDUAL' && (
            <Field label="Filing status">
              <select
                value={(v('filingStatus') as string) ?? ''}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    filingStatus: (e.target.value as Client['filingStatus']) || null,
                  })
                }
                style={fieldStyle}
              >
                <option value="">—</option>
                <option value="SINGLE">Single</option>
                <option value="MFJ">MFJ</option>
                <option value="MFS">MFS</option>
                <option value="HOH">Head of household</option>
                <option value="QW">QW</option>
              </select>
            </Field>
          )}
          <Field label="Pipeline">
            <select
              value={(v('pipelineStage') as string) ?? 'CLIENT'}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  pipelineStage: e.target.value as Client['pipelineStage'],
                })
              }
              style={fieldStyle}
            >
              <option value="CLIENT">Client</option>
              <option value="OTHER">Other</option>
              <option value="PROSPECT">Prospect</option>
            </select>
          </Field>
          <Field label="Terms (days)">
            <input
              type="number"
              min={0}
              value={String(v('termsDays') ?? 30)}
              onChange={(e) => setDraft({ ...draft, termsDays: Number(e.target.value) })}
              style={fieldStyle}
            />
          </Field>
          <Field label="Invoice consolidation">
            <select
              value={(v('invoiceConsolidationPreference') as string) ?? 'SEPARATE'}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  invoiceConsolidationPreference: e.target.value as 'CONSOLIDATED' | 'SEPARATE',
                })
              }
              style={fieldStyle}
            >
              <option value="SEPARATE">Separate invoice per engagement</option>
              <option value="CONSOLIDATED">Consolidated</option>
            </select>
          </Field>
          <Field label="Active">
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={(v('active') as boolean | undefined) ?? true}
                onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
              />
              Visible in time entry + dashboards
            </label>
          </Field>
        </div>
      ) : (
        <dl
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: '6px 16px',
            fontSize: 13,
            margin: 0,
          }}
        >
          {client.clientFacingName && (
            <>
              <dt style={{ color: tokens.color.textMuted }}>Client-facing name</dt>
              <dd style={{ margin: 0 }}>{client.clientFacingName}</dd>
            </>
          )}
          <dt style={{ color: tokens.color.textMuted }}>Type</dt>
          <dd style={{ margin: 0 }}>
            <Pill>{client.clientType ?? 'BUSINESS'}</Pill>
          </dd>
          {client.externalId && (
            <>
              <dt style={{ color: tokens.color.textMuted }}>External ID</dt>
              <dd style={{ margin: 0 }}>{client.externalId}</dd>
            </>
          )}
          {client.filingStatus && (
            <>
              <dt style={{ color: tokens.color.textMuted }}>Filing status</dt>
              <dd style={{ margin: 0 }}>{client.filingStatus}</dd>
            </>
          )}
          <dt style={{ color: tokens.color.textMuted }}>Pipeline</dt>
          <dd style={{ margin: 0 }}>{client.pipelineStage ?? 'CLIENT'}</dd>
          <dt style={{ color: tokens.color.textMuted }}>Terms</dt>
          <dd style={{ margin: 0 }}>{client.termsDays} days</dd>
          <dt style={{ color: tokens.color.textMuted }}>Consolidation</dt>
          <dd style={{ margin: 0 }}>{client.invoiceConsolidationPreference}</dd>
          <dt style={{ color: tokens.color.textMuted }}>Created</dt>
          <dd style={{ margin: 0 }}>{client.createdAt.slice(0, 10)}</dd>
        </dl>
      )}
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label style={{ display: 'block' }}>
      <span
        style={{
          fontSize: 11,
          color: tokens.color.textMuted,
          display: 'block',
          marginBottom: 4,
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}
