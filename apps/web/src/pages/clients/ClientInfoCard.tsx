// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Client Info card on the Home tab (v2 followup) with inline pencil-
// edit. Exposes the v2 expansion fields (clientType, externalId,
// filingStatus, pipelineStage, active, termsDays, partnerInChargeId).

import { useEffect, useState } from 'react';

import { Button, Card, Combobox, MultiCombobox, Pill, tokens, type ComboboxOption } from '@vibe/ui';

import { api } from '../../api-client';
import { ENTITY_TYPE_LABELS, ENTITY_TYPE_OPTIONS, type EntityType } from '../../lib/entity-types';

interface Client {
  id: string;
  name: string;
  status: string;
  termsDays: number;
  invoiceConsolidationPreference: 'CONSOLIDATED' | 'SEPARATE';
  partnerInChargeId: string | null;
  // 0092 — required on the row; FE allows editing across firm offices.
  officeId?: string | null;
  officeName?: string | null;
  createdAt: string;
  clientType?: 'INDIVIDUAL' | 'BUSINESS';
  // 0212 — business-side counterpart to filingStatus.
  entityType?: EntityType | null;
  clientFacingName?: string | null;
  externalId?: string | null;
  // 0152 — second identifier for the Vibe Filer document mapper.
  awsId?: string | null;
  filingStatus?: 'SINGLE' | 'MFJ' | 'MFS' | 'HOH' | 'QW' | null;
  pipelineStage?: 'PROSPECT' | 'CLIENT' | 'OTHER';
  active?: boolean;
  // 0050 — structured mailing address.
  mailingStreet1?: string | null;
  mailingStreet2?: string | null;
  mailingCity?: string | null;
  mailingState?: string | null;
  mailingPostal?: string | null;
  mailingCountry?: string | null;
  // 0165 — per-client visibility restriction.
  restricted?: boolean;
  accessRestricted?: boolean;
  canManageRestriction?: boolean;
  designatedUserIds?: string[];
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
  const [offices, setOffices] = useState<Array<{ id: string; name: string; isDefault: boolean }>>(
    [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing || partners.length > 0) return;
    void (async () => {
      try {
        const [u, o] = await Promise.all([
          api<{ users: Partner[] }>('/api/staff/admin/users'),
          api<{ offices: Array<{ id: string; name: string; isDefault: boolean }> }>(
            '/api/staff/admin/offices',
          ).catch(() => ({ offices: [] })),
        ]);
        setPartners(u.users ?? []);
        setOffices(o.offices ?? []);
      } catch {
        // Non-fatal: dropdowns stay empty.
      }
    })();
  }, [editing, partners.length]);

  function begin(): void {
    setDraft({});
    setError(null);
    setEditing(true);
  }

  async function save(): Promise<void> {
    // 0212 — entity type is required for business clients. Effective values:
    // draft wins over the loaded row so switching type mid-edit is caught.
    const effType = draft.clientType !== undefined ? draft.clientType : client.clientType;
    const effEntity = draft.entityType !== undefined ? draft.entityType : client.entityType;
    if ((effType ?? 'BUSINESS') === 'BUSINESS' && !effEntity) {
      setError('Entity type is required for business clients.');
      return;
    }
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
      const msg = e instanceof Error ? e.message : 'save_failed';
      setError(
        msg === 'duplicate_name'
          ? 'Another client already uses that name. Pick a distinct name (the client-facing name can stay the same).'
          : msg,
      );
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
            <Combobox
              ariaLabel="Client owner"
              clearable
              value={(v('partnerInChargeId') as string) ?? ''}
              onChange={(val) => setDraft({ ...draft, partnerInChargeId: val })}
              options={partners.map<ComboboxOption>((p) => ({ value: p.id, label: p.fullName }))}
              placeholder="— none —"
            />
          </Field>
          <Field label="Office">
            <Combobox
              ariaLabel="Office"
              value={(v('officeId') as string) ?? ''}
              onChange={(val) => setDraft({ ...draft, officeId: val })}
              options={offices.map<ComboboxOption>((o) => ({
                value: o.id,
                label: o.isDefault ? `${o.name} (default)` : o.name,
              }))}
              placeholder="— select —"
            />
          </Field>
          <Field label="External ID">
            <input
              value={(v('externalId') as string) ?? ''}
              onChange={(e) => setDraft({ ...draft, externalId: e.target.value || null })}
              style={fieldStyle}
            />
          </Field>
          <Field label="AWS ID">
            <input
              value={(v('awsId') as string) ?? ''}
              onChange={(e) => setDraft({ ...draft, awsId: e.target.value || null })}
              style={fieldStyle}
            />
          </Field>
          <Field label="Client type">
            <Combobox
              ariaLabel="Client type"
              value={(v('clientType') as string) ?? 'BUSINESS'}
              onChange={(val) =>
                setDraft({ ...draft, clientType: val as 'INDIVIDUAL' | 'BUSINESS' })
              }
              options={[
                { value: 'INDIVIDUAL', label: 'Individual' },
                { value: 'BUSINESS', label: 'Business' },
              ]}
            />
          </Field>
          {(v('clientType') ?? 'BUSINESS') === 'BUSINESS' && (
            <Field label="Entity type *">
              <Combobox
                ariaLabel="Entity type"
                required
                value={(v('entityType') as string) ?? ''}
                onChange={(val) => setDraft({ ...draft, entityType: (val as EntityType) || null })}
                options={ENTITY_TYPE_OPTIONS}
                placeholder="— select —"
              />
            </Field>
          )}
          {(v('clientType') ?? 'BUSINESS') === 'INDIVIDUAL' && (
            <Field label="Filing status">
              <Combobox
                ariaLabel="Filing status"
                clearable
                value={(v('filingStatus') as string) ?? ''}
                onChange={(val) =>
                  setDraft({
                    ...draft,
                    filingStatus: (val as Client['filingStatus']) || null,
                  })
                }
                options={[
                  { value: 'SINGLE', label: 'Single' },
                  { value: 'MFJ', label: 'MFJ' },
                  { value: 'MFS', label: 'MFS' },
                  { value: 'HOH', label: 'Head of household' },
                  { value: 'QW', label: 'QW' },
                ]}
                placeholder="—"
              />
            </Field>
          )}
          <Field label="Pipeline">
            <Combobox
              ariaLabel="Pipeline"
              value={(v('pipelineStage') as string) ?? 'CLIENT'}
              onChange={(val) =>
                setDraft({ ...draft, pipelineStage: val as Client['pipelineStage'] })
              }
              options={[
                { value: 'CLIENT', label: 'Client' },
                { value: 'OTHER', label: 'Other' },
                { value: 'PROSPECT', label: 'Prospect' },
              ]}
            />
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
            <Combobox
              ariaLabel="Invoice consolidation"
              value={(v('invoiceConsolidationPreference') as string) ?? 'SEPARATE'}
              onChange={(val) =>
                setDraft({
                  ...draft,
                  invoiceConsolidationPreference: val as 'CONSOLIDATED' | 'SEPARATE',
                })
              }
              options={[
                { value: 'SEPARATE', label: 'Separate invoice per engagement' },
                { value: 'CONSOLIDATED', label: 'Consolidated' },
              ]}
            />
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
          {/* 0050 — structured mailing address */}
          <div style={{ gridColumn: 'span 2', marginTop: 4 }}>
            <div
              style={{
                fontSize: 11,
                color: tokens.color.textMuted,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
                marginBottom: 6,
              }}
            >
              Mailing address
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Field label="Street 1">
                <input
                  value={(v('mailingStreet1') as string) ?? ''}
                  onChange={(e) => setDraft({ ...draft, mailingStreet1: e.target.value || null })}
                  style={fieldStyle}
                />
              </Field>
              <Field label="Street 2">
                <input
                  value={(v('mailingStreet2') as string) ?? ''}
                  onChange={(e) => setDraft({ ...draft, mailingStreet2: e.target.value || null })}
                  style={fieldStyle}
                />
              </Field>
              <Field label="City">
                <input
                  value={(v('mailingCity') as string) ?? ''}
                  onChange={(e) => setDraft({ ...draft, mailingCity: e.target.value || null })}
                  style={fieldStyle}
                />
              </Field>
              <Field label="State / Province">
                <input
                  value={(v('mailingState') as string) ?? ''}
                  onChange={(e) => setDraft({ ...draft, mailingState: e.target.value || null })}
                  style={fieldStyle}
                />
              </Field>
              <Field label="Postal code">
                <input
                  value={(v('mailingPostal') as string) ?? ''}
                  onChange={(e) => setDraft({ ...draft, mailingPostal: e.target.value || null })}
                  style={fieldStyle}
                />
              </Field>
              <Field label="Country">
                <input
                  value={(v('mailingCountry') as string) ?? ''}
                  onChange={(e) => setDraft({ ...draft, mailingCountry: e.target.value || null })}
                  style={fieldStyle}
                />
              </Field>
            </div>
          </div>
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
          {client.awsId && (
            <>
              <dt style={{ color: tokens.color.textMuted }}>AWS ID</dt>
              <dd style={{ margin: 0 }}>{client.awsId}</dd>
            </>
          )}
          {client.entityType && (
            <>
              <dt style={{ color: tokens.color.textMuted }}>Entity type</dt>
              <dd style={{ margin: 0 }}>{ENTITY_TYPE_LABELS[client.entityType]}</dd>
            </>
          )}
          {client.filingStatus && (
            <>
              <dt style={{ color: tokens.color.textMuted }}>Filing status</dt>
              <dd style={{ margin: 0 }}>{client.filingStatus}</dd>
            </>
          )}
          <dt style={{ color: tokens.color.textMuted }}>Office</dt>
          <dd style={{ margin: 0 }}>{client.officeName ?? '—'}</dd>
          <dt style={{ color: tokens.color.textMuted }}>Pipeline</dt>
          <dd style={{ margin: 0 }}>{client.pipelineStage ?? 'CLIENT'}</dd>
          <dt style={{ color: tokens.color.textMuted }}>Terms</dt>
          <dd style={{ margin: 0 }}>{client.termsDays} days</dd>
          <dt style={{ color: tokens.color.textMuted }}>Consolidation</dt>
          <dd style={{ margin: 0 }}>{client.invoiceConsolidationPreference}</dd>
          <dt style={{ color: tokens.color.textMuted }}>Created</dt>
          <dd style={{ margin: 0 }}>{client.createdAt.slice(0, 10)}</dd>
          {hasMailingAddress(client) && (
            <>
              <dt style={{ color: tokens.color.textMuted }}>Mailing</dt>
              <dd style={{ margin: 0, whiteSpace: 'pre-line' }}>{formatAddress(client)}</dd>
            </>
          )}
        </dl>
      )}
      {client.canManageRestriction && <RestrictionPanel client={client} onSaved={onSaved} />}
    </Card>
  );
}

// 0165 — admin/partner-only panel to mark a client restricted and pick the
// designated users who keep full access. Saves to the dedicated restriction
// endpoint (separate permission from client:write).
function RestrictionPanel({
  client,
  onSaved,
}: {
  client: Client;
  onSaved: (patch: Partial<Client>) => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [restricted, setRestricted] = useState(Boolean(client.restricted));
  const [userIds, setUserIds] = useState<string[]>(client.designatedUserIds ?? []);
  const [users, setUsers] = useState<Partner[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing || users.length > 0) return;
    void (async () => {
      try {
        const u = await api<{ users: Partner[] }>('/api/staff/admin/users');
        setUsers(u.users ?? []);
      } catch {
        // Non-fatal: the picker stays empty.
      }
    })();
  }, [editing, users.length]);

  function begin(): void {
    setRestricted(Boolean(client.restricted));
    setUserIds(client.designatedUserIds ?? []);
    setError(null);
    setEditing(true);
  }

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ restricted: boolean; designatedUserIds: string[] }>(
        `/api/staff/clients/${client.id}/restriction`,
        {
          method: 'PUT',
          body: JSON.stringify({
            restricted,
            designatedUserIds: restricted ? userIds : [],
          }),
        },
      );
      onSaved({
        restricted: res.restricted,
        designatedUserIds: res.designatedUserIds,
        // The manager always retains access, so the local view is never restricted.
        accessRestricted: false,
      });
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save_failed');
    } finally {
      setBusy(false);
    }
  }

  const designatedNames = (client.designatedUserIds ?? [])
    .map((id) => users.find((u) => u.id === id)?.fullName)
    .filter(Boolean) as string[];

  return (
    <div
      style={{
        marginTop: 14,
        paddingTop: 12,
        borderTop: `1px solid ${tokens.color.border}`,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: tokens.color.textMuted,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
          }}
        >
          Restricted access
        </div>
        {editing ? (
          <span style={{ display: 'flex', gap: 6 }}>
            <Button size="sm" onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </span>
        ) : (
          <Button size="sm" variant="ghost" onClick={begin}>
            Edit
          </Button>
        )}
      </div>
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 6 }} role="alert">
          {error}
        </p>
      )}
      {editing ? (
        <div style={{ marginTop: 8 }}>
          <label
            style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginBottom: 8 }}
          >
            <input
              type="checkbox"
              checked={restricted}
              onChange={(e) => setRestricted(e.target.checked)}
            />
            Restrict this client to designated users
          </label>
          {restricted && (
            <Field label="Designated users (full access)">
              <MultiCombobox
                ariaLabel="Designated users"
                options={users.map<ComboboxOption>((u) => ({ value: u.id, label: u.fullName }))}
                selected={userIds}
                onChange={setUserIds}
                placeholder="— add users —"
              />
            </Field>
          )}
          <p style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 8 }}>
            All staff keep access to client info, people, and billing / A-R. Designated users,
            admins, and the client owner additionally see everything else.
          </p>
        </div>
      ) : (
        <div style={{ marginTop: 6, fontSize: 13 }}>
          {client.restricted ? (
            <>
              <Pill tone="warning">Restricted</Pill>
              <span style={{ color: tokens.color.textMuted, marginLeft: 8 }}>
                {designatedNames.length
                  ? `Designated: ${designatedNames.join(', ')}`
                  : `${(client.designatedUserIds ?? []).length} designated user(s)`}
              </span>
            </>
          ) : (
            <span style={{ color: tokens.color.textMuted }}>
              Visible to all staff (not restricted)
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function hasMailingAddress(c: Client): boolean {
  return Boolean(
    c.mailingStreet1 ||
    c.mailingStreet2 ||
    c.mailingCity ||
    c.mailingState ||
    c.mailingPostal ||
    c.mailingCountry,
  );
}

function formatAddress(c: Client): string {
  const line1 = c.mailingStreet1 ?? '';
  const line2 = c.mailingStreet2 ?? '';
  const cityState = [c.mailingCity, c.mailingState].filter(Boolean).join(', ');
  const lastLine = [cityState, c.mailingPostal].filter(Boolean).join(' ');
  return [line1, line2, lastLine, c.mailingCountry].filter(Boolean).join('\n');
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
