// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Create Client wizard (v2 Sprint B, workstream 1.7). Replaces the
// previous inline form in Clients.tsx with a Canopy-style multi-step
// modal:
//   Client type → Client info → Contacts → Custom fields → Tags
//
// The wizard is rendered from Clients.tsx behind a "New client" button.
// Two CTAs at the top: "Create and close" (toast + back to list) and
// "Create and manage" (navigate to the new client's detail page).

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  Combobox,
  Input,
  Pill,
  Wizard,
  tokens,
  type ComboboxOption,
  type WizardStep,
} from '@vibe/ui';

import { api } from '../../api-client';
import { isDesktop } from '../../lib/desktop';
import { CaptureClientInfo, type MappedIntake } from './CaptureClientInfo';

interface AppUser {
  id: string;
  fullName: string;
}

interface TaxonomyEntry {
  id: string;
  key: string;
  name: string;
  status: string;
}

type ClientType = 'INDIVIDUAL' | 'BUSINESS';
type PipelineStage = 'PROSPECT' | 'CLIENT' | 'OTHER';
type FilingStatus = '' | 'SINGLE' | 'MFJ' | 'MFS' | 'HOH' | 'QW';

interface DraftContact {
  fullName: string;
  email: string;
  phone: string;
  mobile: string;
  roleId: string;
  isPrimary: boolean;
  isBilling: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  /** Persisted users for the Client Owner dropdown. */
  users: AppUser[];
}

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: tokens.color.textMuted,
  marginBottom: 4,
  display: 'block',
};

function emptyContact(): DraftContact {
  return {
    fullName: '',
    email: '',
    phone: '',
    mobile: '',
    roleId: '',
    isPrimary: false,
    isBilling: false,
  };
}

export function CreateClientWizard({ open, onClose, onCreated, users }: Props): JSX.Element {
  const navigate = useNavigate();

  const [step, setStep] = useState('type');
  const [clientType, setClientType] = useState<ClientType>('BUSINESS');
  const [name, setName] = useState('');
  const [clientFacingName, setClientFacingName] = useState('');
  const [useFacingName, setUseFacingName] = useState(false);
  const [externalId, setExternalId] = useState('');
  const [awsId, setAwsId] = useState('');
  const [filingStatus, setFilingStatus] = useState<FilingStatus>('');
  const [sourceId, setSourceId] = useState('');
  const [partnerInChargeId, setPartnerInChargeId] = useState('');
  // 0092 — every client belongs to one office. Defaults to the firm's
  // default office; partner can pick any other from the dropdown.
  const [officeId, setOfficeId] = useState('');
  const [offices, setOffices] = useState<Array<{ id: string; name: string; isDefault: boolean }>>(
    [],
  );
  const [pipelineStage, setPipelineStage] = useState<PipelineStage>('CLIENT');
  const [active, setActive] = useState(true);
  const [termsDays, setTermsDays] = useState(30);
  const [contacts, setContacts] = useState<DraftContact[]>([
    { ...emptyContact(), isPrimary: true, isBilling: true },
  ]);
  const [customFields, setCustomFields] = useState<Array<{ key: string; value: string }>>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState('');
  const [sources, setSources] = useState<TaxonomyEntry[]>([]);
  const [roles, setRoles] = useState<TaxonomyEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Capture Client Info (desktop shell only). Mailing address has no wizard
  // input today, so it's held here and sent straight through on create.
  const [captureOpen, setCaptureOpen] = useState(false);
  // Only offer the capture/import banner when the appliance actually has a
  // local OCR model configured (GLM_OCR_URL) — otherwise the flow dead-ends
  // in a 503.
  const [ocrAvailable, setOcrAvailable] = useState(false);
  const [mailing, setMailing] = useState<{
    mailingStreet1?: string;
    mailingCity?: string;
    mailingState?: string;
    mailingPostal?: string;
    mailingCountry?: string;
  }>({});

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const [s, r, o] = await Promise.all([
          api<{ items: TaxonomyEntry[] }>('/api/staff/taxonomy/client-sources'),
          api<{ items: TaxonomyEntry[] }>('/api/staff/taxonomy/contact-roles'),
          api<{ offices: Array<{ id: string; name: string; isDefault: boolean }> }>(
            '/api/staff/admin/offices',
          ).catch(() => ({ offices: [] })),
        ]);
        setSources((s.items ?? []).filter((i) => i.status === 'ACTIVE'));
        setRoles((r.items ?? []).filter((i) => i.status === 'ACTIVE'));
        const list = o.offices ?? [];
        setOffices(list);
        // Default-select the firm's default office (is_default=true) or
        // the first one returned. Partner can flip in the UI.
        const def = list.find((x) => x.isDefault) ?? list[0];
        if (def) setOfficeId(def.id);
      } catch {
        // Non-fatal: dropdowns just stay empty.
      }
    })();
    void api<{ available: boolean }>('/api/staff/ocr/status')
      .then((r) => setOcrAvailable(r.available === true))
      .catch(() => setOcrAvailable(false));
  }, [open]);

  function reset(): void {
    setStep('type');
    setClientType('BUSINESS');
    setName('');
    setClientFacingName('');
    setUseFacingName(false);
    setExternalId('');
    setFilingStatus('');
    setSourceId('');
    setPartnerInChargeId('');
    setPipelineStage('CLIENT');
    setActive(true);
    setTermsDays(30);
    setContacts([{ ...emptyContact(), isPrimary: true, isBilling: true }]);
    setCustomFields([]);
    setTags([]);
    setTagDraft('');
    setMailing({});
    setError(null);
  }

  // Prefill the wizard from an OCR capture. Nothing is saved — the user lands
  // on the info step to review and can edit any field before creating.
  function applyIntake(mapped: MappedIntake): void {
    const { client, contact } = mapped;
    setClientType(client.clientType);
    if (client.name) setName(client.name);
    setFilingStatus(
      client.clientType === 'INDIVIDUAL' && client.filingStatus ? client.filingStatus : '',
    );
    setMailing({
      mailingStreet1: client.mailingStreet1,
      mailingCity: client.mailingCity,
      mailingState: client.mailingState,
      mailingPostal: client.mailingPostal,
      mailingCountry: client.mailingCountry,
    });
    if (client.customFields) {
      setCustomFields(Object.entries(client.customFields).map(([key, value]) => ({ key, value })));
    }
    if (contact) {
      setContacts((prev) => {
        const [first, ...rest] = prev;
        const base = first ?? { ...emptyContact(), isPrimary: true, isBilling: true };
        return [
          {
            ...base,
            fullName: contact.name || base.fullName,
            email: contact.email ?? base.email,
            phone: contact.phone ?? base.phone,
          },
          ...rest,
        ];
      });
    }
    setStep('info');
  }

  const canSubmit = name.trim().length > 0 && partnerInChargeId.length > 0;

  async function submit(thenOpen: boolean): Promise<void> {
    if (!canSubmit) {
      setError('Name and Client owner are required.');
      setStep('info');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const customFieldsMap = customFields.reduce<Record<string, string>>((acc, kv) => {
        if (kv.key.trim()) acc[kv.key.trim()] = kv.value;
        return acc;
      }, {});

      // Step 1 — create the client. Some v2 fields (client_type,
      // pipeline_stage, etc.) are not yet accepted by the existing
      // POST /clients endpoint; the wizard collects them locally and
      // the server-side widening happens in a follow-on PATCH (or in
      // the dedicated wizard endpoint added later in Sprint B). For
      // now: persist what the backend accepts, surface the rest to
      // the user via the detail page on next render.
      const created = await api<{ id: string }>('/api/staff/clients', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          partnerInChargeId,
          officeId: officeId || undefined,
          termsDays,
          tags: tags.slice(0, 20),
          customFields: customFieldsMap,
          // Captured mailing address (Capture Client Info) — omitted keys are
          // undefined and dropped by JSON.stringify.
          ...mailing,
        }),
      });

      const clientId = created.id;

      // Step 2 — apply v2-only fields via PATCH (backend ignores
      // unknown keys today; once the schema accepts them in Sprint B's
      // client expansion, they land cleanly).
      try {
        await api(`/api/staff/clients/${clientId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            clientType,
            clientFacingName: useFacingName ? clientFacingName.trim() || null : null,
            externalId: externalId.trim() || null,
            awsId: awsId.trim() || null,
            filingStatus: clientType === 'INDIVIDUAL' && filingStatus ? filingStatus : null,
            sourceId: sourceId || null,
            pipelineStage,
            active,
          }),
        });
      } catch {
        // Optional patch — the wizard succeeds even if these fields
        // aren't accepted server-side yet (idempotent retry path).
      }

      // Step 3 — replace the auto-seeded contact (if any) with the
      // wizard's contact list. POST each contact in order.
      for (const c of contacts) {
        if (!c.fullName.trim()) continue;
        await api(`/api/staff/clients/${clientId}/contacts`, {
          method: 'POST',
          body: JSON.stringify({
            fullName: c.fullName.trim(),
            roleId: c.roleId || null,
            email: c.email.trim() || null,
            phone: c.phone.trim() || null,
            mobile: c.mobile.trim() || null,
            isPrimary: c.isPrimary,
            isBilling: c.isBilling,
          }),
        });
      }

      onCreated();
      reset();
      if (thenOpen) {
        navigate(`/clients/${clientId}`);
      } else {
        onClose();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'create_failed';
      setError(
        msg === 'duplicate_name'
          ? `A client named "${name.trim()}" already exists. Use a distinct name (you can set a separate client-facing name later).`
          : msg,
      );
    } finally {
      setBusy(false);
    }
  }

  const steps: WizardStep[] = [
    {
      key: 'type',
      label: 'Client type',
      content: (
        <div style={{ display: 'grid', gap: 12 }}>
          {ocrAvailable && (
            <button
              type="button"
              onClick={() => setCaptureOpen(true)}
              style={{
                padding: 12,
                border: `1px dashed ${tokens.color.accent}`,
                borderRadius: tokens.radius.md,
                background: tokens.color.accentMuted,
                color: tokens.color.accent,
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              📷{' '}
              {isDesktop()
                ? 'Capture client info from UltraTax CS →'
                : 'Import client info from a screenshot / PDF →'}
              <span
                style={{
                  display: 'block',
                  fontWeight: 400,
                  fontSize: 12,
                  color: tokens.color.textMuted,
                  marginTop: 2,
                }}
              >
                {isDesktop()
                  ? 'Screenshot the General Information screen and pre-fill this form via local OCR.'
                  : 'Upload the General Information screen and pre-fill this form via local OCR.'}
              </span>
            </button>
          )}
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
            Choose whether this client is an individual (1040 filer) or a business entity. Drives
            which fields the next step shows.
          </p>
          <div style={{ display: 'flex', gap: 12 }}>
            {(['INDIVIDUAL', 'BUSINESS'] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setClientType(opt)}
                style={{
                  flex: 1,
                  padding: 16,
                  border: `2px solid ${clientType === opt ? tokens.color.accent : tokens.color.border}`,
                  borderRadius: tokens.radius.md,
                  background: clientType === opt ? tokens.color.accentMuted : tokens.color.surface,
                  color: tokens.color.text,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 600 }}>
                  {opt === 'INDIVIDUAL' ? 'Individual' : 'Business'}
                </div>
                <div style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 4 }}>
                  {opt === 'INDIVIDUAL'
                    ? 'Single filer, joint filer, etc. Filing status applies.'
                    : 'C-corp, S-corp, LLC, partnership, sole prop, nonprofit.'}
                </div>
              </button>
            ))}
          </div>
        </div>
      ),
    },
    {
      key: 'info',
      label: 'Client info',
      content: (
        <div style={{ display: 'grid', gap: 12 }}>
          <Input
            label={clientType === 'INDIVIDUAL' ? 'Client name (e.g. Smith, John)' : 'Business name'}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <label style={{ display: 'flex', gap: 6, fontSize: 13, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={useFacingName}
              onChange={(e) => setUseFacingName(e.target.checked)}
            />
            Use a different client-facing name
          </label>
          {useFacingName && (
            <Input
              label="Client-facing name"
              value={clientFacingName}
              onChange={(e) => setClientFacingName(e.target.value)}
            />
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <span style={labelStyle}>Client owner *</span>
              <Combobox
                ariaLabel="Client owner"
                required
                value={partnerInChargeId}
                onChange={setPartnerInChargeId}
                options={users.map<ComboboxOption>((u) => ({ value: u.id, label: u.fullName }))}
                placeholder="— select —"
              />
            </div>
            <div>
              <span style={labelStyle}>Office *</span>
              <Combobox
                ariaLabel="Office"
                required
                value={officeId}
                onChange={setOfficeId}
                options={offices.map<ComboboxOption>((o) => ({
                  value: o.id,
                  label: o.isDefault ? `${o.name} (default)` : o.name,
                }))}
                placeholder="— select —"
              />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input
              label="External ID"
              value={externalId}
              onChange={(e) => setExternalId(e.target.value)}
              placeholder="(tax-prep system handle)"
            />
            <Input
              label="AWS ID"
              value={awsId}
              onChange={(e) => setAwsId(e.target.value)}
              placeholder="(file-mover identifier)"
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {clientType === 'INDIVIDUAL' && (
              <div>
                <span style={labelStyle}>Filing status</span>
                <Combobox
                  ariaLabel="Filing status"
                  clearable
                  value={filingStatus}
                  onChange={(v) => setFilingStatus(v as FilingStatus)}
                  options={[
                    { value: 'SINGLE', label: 'Single' },
                    { value: 'MFJ', label: 'Married filing jointly' },
                    { value: 'MFS', label: 'Married filing separately' },
                    { value: 'HOH', label: 'Head of household' },
                    { value: 'QW', label: 'Qualifying widow(er)' },
                  ]}
                  placeholder="— select —"
                />
              </div>
            )}
            <div>
              <span style={labelStyle}>Source</span>
              <Combobox
                ariaLabel="Source"
                clearable
                value={sourceId}
                onChange={setSourceId}
                options={sources.map<ComboboxOption>((s) => ({ value: s.id, label: s.name }))}
                placeholder="— select —"
              />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ display: 'block' }} role="group" aria-label="Pipeline stage">
              <span style={labelStyle}>Pipeline stage</span>
              <div style={{ display: 'flex', gap: 6 }}>
                {(['CLIENT', 'OTHER', 'PROSPECT'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPipelineStage(p)}
                    style={{
                      padding: '6px 14px',
                      border: `1px solid ${pipelineStage === p ? tokens.color.accent : tokens.color.border}`,
                      borderRadius: 999,
                      background: pipelineStage === p ? tokens.color.accentMuted : 'transparent',
                      color: pipelineStage === p ? tokens.color.accent : tokens.color.text,
                      fontSize: 13,
                      cursor: 'pointer',
                    }}
                  >
                    {p[0] + p.slice(1).toLowerCase()}
                  </button>
                ))}
              </div>
            </div>
            <Input
              label="Terms (days)"
              value={String(termsDays)}
              onChange={(e) => setTermsDays(Number(e.target.value || '30'))}
              type="number"
            />
          </div>

          <label
            htmlFor="wizard-active-toggle"
            style={{
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              padding: 12,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.md,
            }}
          >
            <input
              id="wizard-active-toggle"
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              aria-label="Client active"
            />
            <span style={{ display: 'block', flex: 1 }}>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>Active</span>
              <span style={{ display: 'block', fontSize: 12, color: tokens.color.textMuted }}>
                When off, the client is hidden from time entry and dashboards but data is preserved.
              </span>
            </span>
          </label>
        </div>
      ),
    },
    {
      key: 'contacts',
      label: `Contacts (${contacts.filter((c) => c.fullName.trim()).length})`,
      content: (
        <div style={{ display: 'grid', gap: 12 }}>
          {contacts.map((c, i) => (
            <div
              key={i}
              style={{
                padding: 12,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                display: 'grid',
                gap: 8,
              }}
            >
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <strong style={{ fontSize: 13 }}>Contact {i + 1}</strong>
                {contacts.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setContacts(contacts.filter((_, j) => j !== i))}
                    style={{
                      fontSize: 12,
                      background: 'transparent',
                      border: 'none',
                      color: tokens.color.danger,
                      cursor: 'pointer',
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <Input
                  label="Full name"
                  value={c.fullName}
                  onChange={(e) =>
                    setContacts(
                      contacts.map((x, j) => (j === i ? { ...x, fullName: e.target.value } : x)),
                    )
                  }
                />
                <div>
                  <span style={labelStyle}>Role</span>
                  <Combobox
                    ariaLabel="Contact role"
                    clearable
                    value={c.roleId}
                    onChange={(val) =>
                      setContacts(contacts.map((x, j) => (j === i ? { ...x, roleId: val } : x)))
                    }
                    options={roles.map<ComboboxOption>((r) => ({ value: r.id, label: r.name }))}
                    placeholder="— select —"
                  />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                <Input
                  label="Email"
                  value={c.email}
                  onChange={(e) =>
                    setContacts(
                      contacts.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)),
                    )
                  }
                />
                <Input
                  label="Phone"
                  value={c.phone}
                  onChange={(e) =>
                    setContacts(
                      contacts.map((x, j) => (j === i ? { ...x, phone: e.target.value } : x)),
                    )
                  }
                />
                <Input
                  label="Mobile"
                  value={c.mobile}
                  onChange={(e) =>
                    setContacts(
                      contacts.map((x, j) => (j === i ? { ...x, mobile: e.target.value } : x)),
                    )
                  }
                />
              </div>
              <div style={{ display: 'flex', gap: 16, fontSize: 13 }}>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={c.isPrimary}
                    onChange={(e) =>
                      setContacts(
                        contacts.map((x, j) => ({
                          ...x,
                          isPrimary:
                            j === i ? e.target.checked : e.target.checked ? false : x.isPrimary,
                        })),
                      )
                    }
                  />
                  Primary contact
                </label>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={c.isBilling}
                    onChange={(e) =>
                      setContacts(
                        contacts.map((x, j) => ({
                          ...x,
                          isBilling:
                            j === i ? e.target.checked : e.target.checked ? false : x.isBilling,
                        })),
                      )
                    }
                  />
                  Billing contact
                </label>
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setContacts([...contacts, emptyContact()])}
            style={{
              padding: 10,
              border: `1px dashed ${tokens.color.border}`,
              borderRadius: tokens.radius.md,
              background: 'transparent',
              color: tokens.color.accent,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            + Add another contact
          </button>
        </div>
      ),
    },
    {
      key: 'custom',
      label: 'Custom fields',
      content: (
        <div style={{ display: 'grid', gap: 8 }}>
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
            Add arbitrary key/value pairs that will appear on the client detail page.
          </p>
          {customFields.map((cf, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 2fr auto', gap: 8 }}>
              <Input
                value={cf.key}
                onChange={(e) =>
                  setCustomFields(
                    customFields.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)),
                  )
                }
                placeholder="Field"
              />
              <Input
                value={cf.value}
                onChange={(e) =>
                  setCustomFields(
                    customFields.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)),
                  )
                }
                placeholder="Value"
              />
              <button
                type="button"
                onClick={() => setCustomFields(customFields.filter((_, j) => j !== i))}
                style={{
                  fontSize: 12,
                  background: 'transparent',
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  color: tokens.color.danger,
                  padding: '6px 12px',
                  cursor: 'pointer',
                }}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setCustomFields([...customFields, { key: '', value: '' }])}
            style={{
              padding: 10,
              border: `1px dashed ${tokens.color.border}`,
              borderRadius: tokens.radius.md,
              background: 'transparent',
              color: tokens.color.accent,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            + Add a field
          </button>
        </div>
      ),
    },
    {
      key: 'tags',
      label: 'Tags',
      content: (
        <div style={{ display: 'grid', gap: 12 }}>
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
            Free-text tags. Press Enter to add.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {tags.map((t) => (
              <span
                key={t}
                style={{
                  display: 'inline-flex',
                  gap: 6,
                  alignItems: 'center',
                  padding: '4px 10px',
                  borderRadius: 999,
                  background: tokens.color.accentMuted,
                  color: tokens.color.accent,
                  fontSize: 12,
                }}
              >
                {t}
                <button
                  type="button"
                  onClick={() => setTags(tags.filter((x) => x !== t))}
                  aria-label={`Remove ${t}`}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: tokens.color.accent,
                    cursor: 'pointer',
                  }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <Input
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && tagDraft.trim()) {
                e.preventDefault();
                if (!tags.includes(tagDraft.trim())) setTags([...tags, tagDraft.trim()]);
                setTagDraft('');
              }
            }}
            placeholder="Type and press Enter"
          />
        </div>
      ),
    },
  ];

  return (
    <>
      <CaptureClientInfo
        open={captureOpen}
        onClose={() => setCaptureOpen(false)}
        onApply={applyIntake}
      />
      <Wizard
        open={open}
        title="New client"
        steps={steps}
        currentStepKey={step}
        onStepChange={setStep}
        onClose={() => {
          reset();
          onClose();
        }}
        primaryAction={{
          label: busy ? 'Creating…' : 'Create and manage',
          onClick: () => void submit(true),
          disabled: busy,
        }}
        secondaryAction={{
          label: 'Create and close',
          onClick: () => void submit(false),
          disabled: busy,
        }}
        headerExtras={
          error ? (
            <Pill tone="danger">{error}</Pill>
          ) : (
            <Pill>{clientType === 'INDIVIDUAL' ? 'Individual' : 'Business'}</Pill>
          )
        }
      />
    </>
  );
}
