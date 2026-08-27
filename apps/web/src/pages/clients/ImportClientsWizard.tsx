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
//
// `mode="update"` is the admin "Update clients" tool: the same wizard with
// a paste box (Excel gives TSV), update-only semantics (a row matching no
// client is reported as "not in the platform", never created, unless the
// operator opts in), names treated as a match key rather than a value to
// write, and a reverse-gap panel listing active clients the pasted list
// never mentioned.

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
  /** 'update' = admin bulk-update tool (paste a list, update-only). */
  mode?: 'import' | 'update';
}

interface RowOutcome {
  row: number;
  action: 'create' | 'update' | 'skip';
  name: string;
  reason?: string;
  /** Client ID of an unmatched row, so the list can be copied back out. */
  externalId?: string;
  contactCount?: number;
  ownerName?: string | null;
  ownerResolved?: boolean;
  fieldsChanged?: string[];
  warnings?: string[];
}

interface GapClient {
  id: string;
  externalId: string | null;
  name: string;
}

interface PreviewResult {
  columns: string[];
  mappedColumns: string[];
  total: number;
  willCreate: number;
  willUpdate: number;
  willSkip: number;
  rows: RowOutcome[];
  /** Update mode only: active clients no row in the list matched. */
  notInList?: { total: number; clients: GapClient[] };
}

type Upload = { kind: 'csv'; csv: string } | { kind: 'xlsx'; xlsxBase64: string };

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: tokens.color.textMuted,
  marginBottom: 4,
  display: 'block',
};

const REASON_LABEL: Record<string, string> = {
  not_in_platform: 'not in the platform',
  invalid_entity_type: 'type not recognized',
  invalid_client_type: 'client type not recognized',
  invalid_filing_status: 'filing status not recognized',
  missing_name: 'no name',
  duplicate_external_id: 'duplicate Client ID in the list',
  duplicate_name: 'duplicate name in the list',
  template_notes_row: 'template notes row',
  owner_required: 'no owner (pick a default owner)',
  owner_not_found: 'owner not found',
  office_not_found: 'office not found',
};

const WARNING_LABEL: Record<string, string> = {
  name_differs: 'name in the list differs (not changed)',
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
  mode = 'import',
}: Props): JSX.Element {
  const updateMode = mode === 'update';
  const [step, setStep] = useState<'upload' | 'preview'>('upload');
  const [upload, setUpload] = useState<Upload | null>(null);
  const [pasted, setPasted] = useState('');
  const [fileName, setFileName] = useState('');
  const [defaultOwnerId, setDefaultOwnerId] = useState('');
  const [defaultOfficeName, setDefaultOfficeName] = useState('');
  const [updateExisting, setUpdateExisting] = useState(false);
  const [createMissing, setCreateMissing] = useState(false);
  const [updateNames, setUpdateNames] = useState(false);
  const [showGap, setShowGap] = useState(false);
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
    setPasted('');
    setFileName('');
    setDefaultOwnerId('');
    setDefaultOfficeName('');
    setUpdateExisting(false);
    setCreateMissing(false);
    setUpdateNames(false);
    setShowGap(false);
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
    setPasted('');
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

  // Pasted text wins over a previously chosen file — the paste box is the
  // primary input in update mode and the file input is the fallback.
  const source: Upload | null = pasted.trim() ? { kind: 'csv', csv: pasted } : upload;

  function body(): Record<string, unknown> {
    const b: Record<string, unknown> =
      source?.kind === 'xlsx' ? { xlsxBase64: source.xlsxBase64 } : { csv: source?.csv ?? '' };
    if (defaultOwnerId) b['defaultOwnerId'] = defaultOwnerId;
    if (defaultOfficeName) b['defaultOfficeName'] = defaultOfficeName;
    if (updateMode) {
      b['updateOnly'] = true;
      if (createMissing) b['createMissing'] = true;
      if (updateNames) b['updateNames'] = true;
    } else if (updateExisting) b['updateExisting'] = true;
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
  const unmatched = preview ? preview.rows.filter((r) => r.reason === 'not_in_platform') : [];
  const noChange = preview
    ? preview.rows.filter((r) => r.action === 'update' && !r.fieldsChanged?.length).length
    : 0;

  function copyUnmatched(): void {
    const text = [
      'Client ID\tName',
      ...unmatched.map((r) => `${r.externalId ?? ''}\t${r.name}`),
    ].join('\n');
    void navigator.clipboard?.writeText(text);
  }

  function copyGap(): void {
    const rows = preview?.notInList?.clients ?? [];
    const text = ['Client ID\tName', ...rows.map((c) => `${c.externalId ?? ''}\t${c.name}`)].join(
      '\n',
    );
    void navigator.clipboard?.writeText(text);
  }

  const uploadStep: WizardStep = {
    key: 'upload',
    label: '1 · Upload',
    content: updateMode ? (
      <div style={{ display: 'grid', gap: tokens.space.md, maxWidth: 620 }}>
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
          Paste rows straight out of a spreadsheet (or upload a CSV / .xlsx). The{' '}
          <strong>first line must be the header</strong> — e.g.{' '}
          <code>
            Client ID{'\u2003'}Name{'\u2003'}Type
          </code>
          . Rows are matched to existing clients by <code>Client ID</code> (the client’s external
          id), falling back to an exact name match, and{' '}
          <strong>only the fields your columns carry are updated</strong>. Any recognized column
          works — Type today, address / filing status / owner / office / terms the same way later —
          and unknown columns are ignored.
        </p>
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
          Nothing is written until you review the preview. Rows matching no client are reported as{' '}
          <strong>not in the platform</strong> and left alone unless you tick the box below. Names
          are used to match and verify only — a client is never renamed unless you ask.
        </p>
        <div>
          <span style={labelStyle}>Paste rows (tab- or comma-separated, header first)</span>
          <textarea
            style={{
              width: '100%',
              minHeight: 180,
              resize: 'vertical',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 12,
              padding: 8,
              borderRadius: tokens.radius.sm,
              border: `1px solid ${tokens.color.border}`,
              background: tokens.color.surface,
              color: tokens.color.text,
            }}
            placeholder={
              'Client ID\tName\tType\nYONK4593\tYonkerville Country Junction, LLC\tS Corporation'
            }
            value={pasted}
            onChange={(e) => {
              setPasted(e.target.value);
              if (e.target.value.trim()) {
                setUpload(null);
                setFileName('');
              }
            }}
            aria-label="Paste client rows"
          />
        </div>
        <div>
          <span style={labelStyle}>…or upload a CSV / Excel file instead</span>
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
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
          <input
            type="checkbox"
            checked={createMissing}
            onChange={(e) => setCreateMissing(e.target.checked)}
          />
          <span>
            Also create clients that aren’t in the platform
            <span style={{ color: tokens.color.textMuted }}>
              {' '}
              — off by default; needs a default owner below
            </span>
          </span>
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
          <input
            type="checkbox"
            checked={updateNames}
            onChange={(e) => setUpdateNames(e.target.checked)}
          />
          <span>
            Also rewrite client names from the list
            <span style={{ color: tokens.color.textMuted }}>
              {' '}
              — otherwise a differing name is only flagged
            </span>
          </span>
        </label>
        {createMissing && (
          <>
            <div>
              <span style={labelStyle}>Default client owner (for created clients)</span>
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
              <span style={labelStyle}>Default office (for created clients)</span>
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
          </>
        )}
        {error && <p style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</p>}
      </div>
    ) : (
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
          {updateMode ? (
            <>
              Updated <strong>{done.fieldUpdates}</strong> client
              {done.fieldUpdates === 1 ? '' : 's'}.
              {done.created > 0 &&
                ` Created ${done.created} client${done.created === 1 ? '' : 's'}.`}
              {done.skipped > 0 &&
                ` ${done.skipped} row${done.skipped === 1 ? '' : 's'} left alone.`}
            </>
          ) : (
            <>
              Imported <strong>{done.created}</strong> client{done.created === 1 ? '' : 's'}.
              {done.updated > 0 &&
                ` Updated ${done.updated} existing client${done.updated === 1 ? '' : 's'}` +
                  (done.fieldUpdates > 0 ? ` (${done.fieldUpdates} with field changes).` : '.')}
              {done.contactsAdded > 0 &&
                ` ${done.contactsAdded} ${done.contactsAdded === 1 ? 'person' : 'people'} linked.`}
              {done.skipped > 0 && ` ${done.skipped} row${done.skipped === 1 ? '' : 's'} skipped.`}
            </>
          )}
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
          {(!updateMode || createMissing) && (
            <span style={{ color: tokens.color.success }}>
              Will create: <strong>{preview.willCreate}</strong>
            </span>
          )}
          <span style={{ color: tokens.color.accent }}>
            Will update: <strong>{updateMode ? fieldsToUpdate : preview.willUpdate}</strong>
            {!updateMode &&
              updateExisting &&
              preview.willUpdate > 0 &&
              ` (${fieldsToUpdate} with field changes)`}
          </span>
          {updateMode && (
            <span style={{ color: tokens.color.textMuted }}>
              Already correct: <strong>{noChange}</strong>
            </span>
          )}
          {updateMode && (
            <span
              style={{ color: unmatched.length ? tokens.color.warning : tokens.color.textMuted }}
            >
              Not in the platform: <strong>{unmatched.length}</strong>
            </span>
          )}
          <span style={{ color: tokens.color.textMuted }}>
            {updateMode ? 'Other skips' : 'Will skip'}:{' '}
            <strong>{preview.willSkip - (updateMode ? unmatched.length : 0)}</strong>
          </span>
        </div>
        {updateMode && unmatched.length > 0 && (
          <div
            style={{
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
              padding: tokens.space.sm,
              display: 'grid',
              gap: 6,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 13 }}>
                {unmatched.length} row{unmatched.length === 1 ? '' : 's'} in your list are not in
                the platform
              </strong>
              <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                {createMissing
                  ? '— they will be created (see the rows below).'
                  : '— nothing will be written for them.'}
              </span>
              <Button variant="ghost" onClick={copyUnmatched}>
                Copy list
              </Button>
            </div>
            <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
              {unmatched
                .slice(0, 12)
                .map((r) => `${r.externalId ? `${r.externalId} · ` : ''}${r.name}`)
                .join(' · ')}
              {unmatched.length > 12 && ` … +${unmatched.length - 12} more`}
            </div>
          </div>
        )}
        {updateMode && preview.notInList && preview.notInList.total > 0 && (
          <div
            style={{
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
              padding: tokens.space.sm,
              display: 'grid',
              gap: 6,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 13 }}>
                {preview.notInList.total} active client
                {preview.notInList.total === 1 ? '' : 's'} in the platform are not in your list
              </strong>
              <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                — untouched; shown so you can spot gaps.
              </span>
              <Button variant="ghost" onClick={() => setShowGap(!showGap)}>
                {showGap ? 'Hide' : 'Show'}
              </Button>
              <Button variant="ghost" onClick={copyGap}>
                Copy list
              </Button>
            </div>
            {showGap && (
              <div
                style={{
                  fontSize: 12,
                  color: tokens.color.textMuted,
                  maxHeight: 160,
                  overflowY: 'auto',
                }}
              >
                {preview.notInList.clients.map((c) => (
                  <div key={c.id}>
                    {c.externalId ? `${c.externalId} · ` : ''}
                    {c.name}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
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
                (r.reason ? (REASON_LABEL[r.reason] ?? r.reason) : undefined) ??
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
          disabled: busy || !source,
        }
      : done
        ? { label: 'Done', onClick: close }
        : updateMode
          ? {
              label: busy
                ? 'Updating…'
                : `Update ${fieldsToUpdate} client${fieldsToUpdate === 1 ? '' : 's'}${
                    createMissing && preview?.willCreate ? ` + create ${preview.willCreate}` : ''
                  }`,
              onClick: () => void commit(),
              disabled:
                busy || !preview || (fieldsToUpdate === 0 && (preview?.willCreate ?? 0) === 0),
            }
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
      title={updateMode ? 'Update clients from a list' : 'Import clients from CSV / Excel'}
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
