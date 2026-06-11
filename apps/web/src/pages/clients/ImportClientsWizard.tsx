// SPDX-License-Identifier: Elastic-2.0
//
// Q36 — CSV client-import wizard. Two steps: Upload (pick a .csv, set an
// optional default owner/office) → Preview (dry-run validation showing
// per-row create/skip with reasons) → commit. The server auto-maps
// columns by header name; required column is `name`. Dedupe is
// skip-existing (external_id, else case-insensitive name).

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
  action: 'create' | 'skip';
  name: string;
  reason?: string;
}

interface PreviewResult {
  columns: string[];
  mappedColumns: string[];
  total: number;
  willCreate: number;
  willSkip: number;
  rows: RowOutcome[];
}

const TEMPLATE_HEADER =
  'name,client_owner_email,office,client_type,external_id,filing_status,pipeline_stage,terms_days,invoice_consolidation_preference,tags,mailing_street1,mailing_city,mailing_state,mailing_postal,billing_contact_name,billing_contact_email,billing_contact_phone';

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: tokens.color.textMuted,
  marginBottom: 4,
  display: 'block',
};

export function ImportClientsWizard({
  open,
  onClose,
  onCreated,
  users,
  offices,
}: Props): JSX.Element {
  const [step, setStep] = useState<'upload' | 'preview'>('upload');
  const [csvText, setCsvText] = useState('');
  const [fileName, setFileName] = useState('');
  const [defaultOwnerId, setDefaultOwnerId] = useState('');
  const [defaultOfficeName, setDefaultOfficeName] = useState('');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ created: number; skipped: number } | null>(null);

  function reset(): void {
    setStep('upload');
    setCsvText('');
    setFileName('');
    setDefaultOwnerId('');
    setDefaultOfficeName('');
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
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result ?? ''));
    reader.readAsText(file);
  }

  function downloadTemplate(): void {
    const blob = new Blob([`${TEMPLATE_HEADER}\n`], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'client-import-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function runPreview(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const body: Record<string, unknown> = { csv: csvText };
      if (defaultOwnerId) body['defaultOwnerId'] = defaultOwnerId;
      if (defaultOfficeName) body['defaultOfficeName'] = defaultOfficeName;
      const r = await api<PreviewResult>('/api/staff/clients/import/preview', {
        method: 'POST',
        body: JSON.stringify(body),
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
      const body: Record<string, unknown> = { csv: csvText };
      if (defaultOwnerId) body['defaultOwnerId'] = defaultOwnerId;
      if (defaultOfficeName) body['defaultOfficeName'] = defaultOfficeName;
      const r = await api<{ created: number; skipped: unknown[] }>(
        '/api/staff/clients/import/commit',
        { method: 'POST', body: JSON.stringify(body) },
      );
      setDone({ created: r.created, skipped: r.skipped.length });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'import_failed');
    } finally {
      setBusy(false);
    }
  }

  const uploadStep: WizardStep = {
    key: 'upload',
    label: '1 · Upload',
    content: (
      <div style={{ display: 'grid', gap: tokens.space.md, maxWidth: 560 }}>
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
          Upload a CSV of clients. The only required column is <code>name</code>. Columns are
          matched by header name; unknown columns are ignored. Rows matching an existing client (by{' '}
          <code>external_id</code>, or by name) are skipped.
        </p>
        <div>
          <button
            type="button"
            onClick={downloadTemplate}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              color: tokens.color.accent,
              cursor: 'pointer',
              fontSize: 13,
              textDecoration: 'underline',
            }}
          >
            Download CSV template
          </button>
        </div>
        <div>
          <span style={labelStyle}>CSV file</span>
          <input type="file" accept=".csv,text/csv" onChange={onFile} />
          {fileName && (
            <span style={{ marginLeft: 8, fontSize: 12, color: tokens.color.textMuted }}>
              {fileName}
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
          {done.skipped > 0 && ` ${done.skipped} row${done.skipped === 1 ? '' : 's'} skipped.`}
        </p>
        <div>
          <Button onClick={close}>Done</Button>
        </div>
      </div>
    ) : preview ? (
      <div style={{ display: 'grid', gap: tokens.space.md }}>
        <div style={{ display: 'flex', gap: 16, fontSize: 14 }}>
          <span>
            Total rows: <strong>{preview.total}</strong>
          </span>
          <span style={{ color: tokens.color.success }}>
            Will create: <strong>{preview.willCreate}</strong>
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
                ) : (
                  <Pill tone="neutral">skip</Pill>
                ),
            },
            { key: 'reason', header: 'Reason', render: (r) => r.reason ?? '' },
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
          disabled: busy || !csvText,
        }
      : done
        ? { label: 'Done', onClick: close }
        : {
            label: busy ? 'Importing…' : `Import ${preview?.willCreate ?? 0} client(s)`,
            onClick: () => void commit(),
            disabled: busy || !preview || preview.willCreate === 0,
          };

  const secondaryAction =
    step === 'preview' && !done
      ? { label: 'Back', onClick: () => setStep('upload'), disabled: busy }
      : undefined;

  return (
    <Wizard
      open={open}
      title="Import clients from CSV"
      steps={[uploadStep, previewStep]}
      currentStepKey={step}
      onStepChange={(k) => {
        if (k === 'upload' && !done) setStep('upload');
      }}
      onClose={close}
      primaryAction={primaryAction}
      secondaryAction={secondaryAction}
      width={900}
    />
  );
}
