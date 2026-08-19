// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Q36 — CSV / Excel client-import wizard. Two steps: Upload (pick a .csv
// or .xlsx, set an optional default owner/office, opt into updating
// existing clients) → Preview (dry-run validation showing per-row
// create/update/skip with reasons, resolved owner, warnings and the
// columns an update would change) → commit. The server auto-maps columns
// by header name — including the UltraTax CS "Data Mining" export layout
// — so that workbook can be uploaded as exported; required column is
// `name` (or UltraTax "Client name"). Rows matching an existing client
// (external_id — the Client ID — or name) attach new people; with "Update
// fields on existing clients" ticked they also rewrite the mapped columns.

import { useState } from 'react';

import { Button, Combobox, Pill, Table, Wizard, tokens, type WizardStep } from '@vibe/ui';

import { api } from '../../api-client';

interface AppUser {
  id: string;
  fullName: string;
}

interface OfficeOption {
  id: string;
  name: string;
  isDefault: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  users: AppUser[];
  offices: OfficeOption[];
}

interface RowOutcome {
  row: number;
  action: 'create' | 'update' | 'skip';
  name: string;
  reason?: string;
  contactCount?: number;
  ownerName?: string | null;
  ownerResolved?: boolean;
  fieldsChanged?: string[];
  warnings?: string[];
}

interface PreviewResult {
  columns: string[];
  mappedColumns: string[];
  total: number;
  willCreate: number;
  willUpdate: number;
  willSkip: number;
  rows: RowOutcome[];
}

type Upload = { kind: 'csv'; csv: string } | { kind: 'xlsx'; xlsxBase64: string };

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: tokens.color.textMuted,
  marginBottom: 4,
  display: 'block',
};

const WARNING_LABEL: Record<string, string> = {
  owner_fallback: 'owner not matched → default',
  shared_email: 'spouse shares taxpayer email (dropped on spouse)',
  shared_phone: 'spouse shares taxpayer phone (dropped on spouse)',
};

const FIELD_LABEL: Record<string, string> = {
  name: 'name',
  clientFacingName: 'client-facing name',
  externalId: 'client id',
  clientType: 'type',
  entityType: 'entity type',
  filingStatus: 'filing status',
  pipelineStage: 'stage',
  invoiceConsolidationPreference: 'consolidation',
  termsDays: 'terms',
  partnerInChargeId: 'owner',
  officeId: 'office',
  mailingStreet1: 'street 1',
  mailingStreet2: 'street 2',
  mailingCity: 'city',
  mailingState: 'state',
  mailingPostal: 'postal',
  mailingCountry: 'country',
};

export function ImportClientsWizard({
  open,
  onClose,
  onCreated,
  users,
  offices,
}: Props): JSX.Element {
  const [step, setStep] = useState<'upload' | 'preview'>('upload');
  const [upload, setUpload] = useState<Upload | null>(null);
  const [fileName, setFileName] = useState('');
  const [defaultOwnerId, setDefaultOwnerId] = useState('');
  const [defaultOfficeName, setDefaultOfficeName] = useState('');
  const [updateExisting, setUpdateExisting] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{
    created: number;
    updated: number;
    fieldUpdates: number;
    contactsAdded: number;
    skipped: number;
  } | null>(null);

  function reset(): void {
    setStep('upload');
    setUpload(null);
    setFileName('');
    setDefaultOwnerId('');
    setDefaultOfficeName('');
    setUpdateExisting(false);
    setPreview(null);
    setBusy(false);
    setError('');
    setDone(null);
  }

  function close(): void {
    reset();
    onClose();
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setError('');
    const isXlsx =
      /\.xlsx$/i.test(file.name) ||
      file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const reader = new FileReader();
    if (isXlsx) {
      reader.onload = () => {
        const dataUrl = String(reader.result ?? '');
        const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
        setUpload({ kind: 'xlsx', xlsxBase64: b64 });
      };
      reader.readAsDataURL(file);
    } else {
      reader.onload = () => setUpload({ kind: 'csv', csv: String(reader.result ?? '') });
      reader.readAsText(file);
    }
  }

  function body(): Record<string, unknown> {
    const b: Record<string, unknown> =
      upload?.kind === 'xlsx' ? { xlsxBase64: upload.xlsxBase64 } : { csv: upload?.csv ?? '' };
    if (defaultOwnerId) b['defaultOwnerId'] = defaultOwnerId;
    if (defaultOfficeName) b['defaultOfficeName'] = defaultOfficeName;
    if (updateExisting) b['updateExisting'] = true;
    return b;
  }

  async function runPreview(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const r = await api<PreviewResult>('/api/staff/clients/import/preview', {
        method: 'POST',
        body: JSON.stringify(body()),
      });
      setPreview(r);
      setStep('preview');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'preview_failed');
    } finally {
      setBusy(false);
    }
  }

  async function commit(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const r = await api<{
        created: number;
        updated?: number;
        fieldUpdates?: number;
        contactsAdded?: number;
        skipped: unknown[];
      }>('/api/staff/clients/import/commit', { method: 'POST', body: JSON.stringify(body()) });
      setDone({
        created: r.created,
        updated: r.updated ?? 0,
        fieldUpdates: r.fieldUpdates ?? 0,
        contactsAdded: r.contactsAdded ?? 0,
        skipped: r.skipped.length,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'import_failed');
    } finally {
      setBusy(false);
    }
  }

  const fieldsToUpdate = preview
    ? preview.rows.reduce((n, r) => n + (r.fieldsChanged?.length ? 1 : 0), 0)
    : 0;

  const uploadStep: WizardStep = {
    key: 'upload',
    label: '1 · Upload',
    content: (
      <div style={{ display: 'grid', gap: tokens.space.md, maxWidth: 560 }}>
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
          Upload a CSV or Excel (.xlsx) file of clients — the first sheet is imported. The only
          required column is <code>name</code>. Columns are matched by header name; unknown columns
          are ignored. Each client can carry multiple people — <code>taxpayer_*</code>,{' '}
          <code>spouse_*</code>, <code>contact3_*</code> … and the legacy{' '}
          <code>billing_contact_*</code> — with <code>_name/_email/_phone/_mobile/_role</code>. An{' '}
          <strong>UltraTax CS Data Mining export</strong> (Client ID, Client name, “1040, Tp first
          name”, “Contact, Sp email address”, Preparer name, …) uploads as-is: the taxpayer becomes
          the primary contact, the spouse is linked with the Spouse role, the Client ID becomes the
          client’s ID (external id) and the preparer becomes the client owner when a staff member of
          that name exists.
        </p>
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
          A row matching an existing client (by <code>external_id</code> / Client ID, else by name){' '}
          <strong>adds any new people to it</strong>; tick the box below to also update the client’s
          fields from the file.
        </p>
        <div>
          <a
            href="/api/staff/clients/import/template"
            style={{
              color: tokens.color.accent,
              fontSize: 13,
              textDecoration: 'underline',
            }}
          >
            Download CSV template
          </a>
          <span style={{ marginLeft: 8, fontSize: 12, color: tokens.color.textMuted }}>
            Includes a column-notes row (safe to leave in) and two worked examples — delete the
            example rows before importing your own.
          </span>
        </div>
        <div>
          <span style={labelStyle}>CSV or Excel file</span>
          <input
            type="file"
            accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={onFile}
          />
          {fileName && (
            <span style={{ marginLeft: 8, fontSize: 12, color: tokens.color.textMuted }}>
              {fileName}
              {upload?.kind === 'xlsx' ? ' (Excel)' : ''}
            </span>
          )}
        </div>
        <div>
          <span style={labelStyle}>Default client owner (for rows with no owner column)</span>
          <Combobox
            ariaLabel="Default client owner"
            clearable
            value={defaultOwnerId}
            onChange={setDefaultOwnerId}
            options={users.map((u) => ({ value: u.id, label: u.fullName }))}
            placeholder="None"
          />
        </div>
        <div>
          <span style={labelStyle}>Default office (for rows with no office column)</span>
          <Combobox
            ariaLabel="Default office"
            clearable
            value={defaultOfficeName}
            onChange={setDefaultOfficeName}
            options={offices.map((o) => ({
              value: o.name,
              label: o.isDefault ? `${o.name} (default)` : o.name,
            }))}
            placeholder="Firm default office"
          />
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
          <input
            type="checkbox"
            checked={updateExisting}
            onChange={(e) => setUpdateExisting(e.target.checked)}
          />
          Update fields on existing clients (address, filing status, names, owner when the preparer
          matches a staff member)
        </label>
        {error && <p style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</p>}
      </div>
    ),
  };

  const previewStep: WizardStep = {
    key: 'preview',
    label: '2 · Preview',
    content: done ? (
      <div style={{ display: 'grid', gap: tokens.space.md }}>
        <p style={{ fontSize: 15 }}>
          Imported <strong>{done.created}</strong> client{done.created === 1 ? '' : 's'}.
          {done.updated > 0 &&
            ` Updated ${done.updated} existing client${done.updated === 1 ? '' : 's'}` +
              (done.fieldUpdates > 0 ? ` (${done.fieldUpdates} with field changes).` : '.')}
          {done.contactsAdded > 0 &&
            ` ${done.contactsAdded} ${done.contactsAdded === 1 ? 'person' : 'people'} linked.`}
          {done.skipped > 0 && ` ${done.skipped} row${done.skipped === 1 ? '' : 's'} skipped.`}
        </p>
        <div>
          <Button onClick={close}>Done</Button>
        </div>
      </div>
    ) : preview ? (
      <div style={{ display: 'grid', gap: tokens.space.md }}>
        <div style={{ display: 'flex', gap: 16, fontSize: 14, flexWrap: 'wrap' }}>
          <span>
            Total rows: <strong>{preview.total}</strong>
          </span>
          <span style={{ color: tokens.color.success }}>
            Will create: <strong>{preview.willCreate}</strong>
          </span>
          <span style={{ color: tokens.color.accent }}>
            Will update: <strong>{preview.willUpdate}</strong>
            {updateExisting && preview.willUpdate > 0 && ` (${fieldsToUpdate} with field changes)`}
          </span>
          <span style={{ color: tokens.color.textMuted }}>
            Will skip: <strong>{preview.willSkip}</strong>
          </span>
        </div>
        <Table<RowOutcome>
          columns={[
            { key: 'row', header: 'Row', render: (r) => r.row + 2 },
            { key: 'name', header: 'Name', render: (r) => r.name || '—' },
            {
              key: 'action',
              header: 'Action',
              render: (r) =>
                r.action === 'create' ? (
                  <Pill tone="success">create</Pill>
                ) : r.action === 'update' ? (
                  <Pill tone="accent">update</Pill>
                ) : (
                  <Pill tone="neutral">skip</Pill>
                ),
            },
            {
              key: 'owner',
              header: 'Owner',
              render: (r) =>
                r.action === 'skip' ? (
                  ''
                ) : r.ownerName ? (
                  <span>
                    {r.ownerName}
                    {r.action === 'create' && r.ownerResolved === false && (
                      <span style={{ color: tokens.color.textMuted }}> (default)</span>
                    )}
                  </span>
                ) : (
                  '—'
                ),
            },
            {
              key: 'contacts',
              header: 'People',
              render: (r) => (r.contactCount ? String(r.contactCount) : ''),
            },
            {
              key: 'changes',
              header: 'Changes',
              render: (r) =>
                r.fieldsChanged && r.fieldsChanged.length
                  ? r.fieldsChanged.map((f) => FIELD_LABEL[f] ?? f).join(', ')
                  : '',
            },
            {
              key: 'reason',
              header: 'Reason / warnings',
              render: (r) =>
                r.reason ??
                (r.warnings && r.warnings.length ? (
                  <span style={{ color: tokens.color.textMuted }}>
                    {r.warnings.map((w) => WARNING_LABEL[w] ?? w).join('; ')}
                  </span>
                ) : (
                  ''
                )),
            },
          ]}
          rows={preview.rows}
          rowKey={(r) => String(r.row)}
          empty="No rows."
        />
        {error && <p style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</p>}
      </div>
    ) : (
      <p>Run the preview first.</p>
    ),
  };

  const primaryAction =
    step === 'upload'
      ? {
          label: busy ? 'Validating…' : 'Preview',
          onClick: () => void runPreview(),
          disabled: busy || !upload,
        }
      : done
        ? { label: 'Done', onClick: close }
        : {
            label: busy
              ? 'Importing…'
              : `Import ${preview?.willCreate ?? 0} new${
                  preview?.willUpdate ? ` + update ${preview.willUpdate}` : ''
                }`,
            onClick: () => void commit(),
            disabled: busy || !preview || (preview.willCreate === 0 && preview.willUpdate === 0),
          };

  const secondaryAction =
    step === 'preview' && !done
      ? { label: 'Back', onClick: () => setStep('upload'), disabled: busy }
      : undefined;

  return (
    <Wizard
      open={open}
      title="Import clients from CSV / Excel"
      steps={[uploadStep, previewStep]}
      currentStepKey={step}
      onStepChange={(k) => {
        if (k === 'upload' && !done) setStep('upload');
      }}
      onClose={close}
      primaryAction={primaryAction}
      secondaryAction={secondaryAction}
      width={960}
    />
  );
}
