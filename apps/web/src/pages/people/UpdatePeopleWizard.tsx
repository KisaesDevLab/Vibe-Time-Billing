// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Admin "Update people": paste a directory list (Taxpayer Name, Mobile
// Phone, Landline Phone, Email) and write the contact fields onto the
// people already in the firm. Two steps — Paste → Preview (per-row
// before → after, with the person each row resolved to and how) → commit.
//
// The people side has no Client ID to match on, so the preview leads with
// *which person* each row landed on and by what key; anything the matcher
// could not resolve to exactly one person is reported, never guessed at.

import { useState } from 'react';

import { Button, Pill, Table, Wizard, tokens, type WizardStep } from '@vibe/ui';

import { api } from '../../api-client';

interface Props {
  open: boolean;
  onClose: () => void;
  onUpdated: () => void;
}

interface FieldChange {
  field: 'fullName' | 'email' | 'phone' | 'mobile';
  from: string | null;
  to: string | null;
}

interface RowOutcome {
  row: number;
  action: 'update' | 'create' | 'skip';
  name: string;
  personId?: string;
  personName?: string;
  matchedBy?: 'email' | 'phone' | 'name' | 'loose_name';
  changes?: FieldChange[];
  warnings?: string[];
  reason?: string;
  detail?: string;
  email?: string | null;
}

interface PreviewResult {
  columns: string[];
  mappedColumns: string[];
  total: number;
  willUpdate: number;
  willCreate: number;
  willSkip: number;
  rows: RowOutcome[];
}

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: tokens.color.textMuted,
  marginBottom: 4,
  display: 'block',
};

const FIELD_LABEL: Record<FieldChange['field'], string> = {
  fullName: 'name',
  email: 'email',
  phone: 'landline',
  mobile: 'mobile',
};

const MATCH_LABEL: Record<string, string> = {
  email: 'email',
  phone: 'phone number',
  name: 'name',
  loose_name: 'name (ignoring initials/punctuation)',
};

const REASON_LABEL: Record<string, string> = {
  not_in_platform: 'not in the platform',
  ambiguous_match: 'more than one person matches',
  conflicting_match: 'email/phone belongs to a different person',
  email_taken: 'email already belongs to another person',
  duplicate_row_for_person: 'an earlier row already updates this person',
  invalid_email: 'email not valid',
  invalid_mobile: 'mobile not a usable number',
  invalid_phone: 'landline not a usable number',
  missing_name: 'no name',
  nothing_to_update: 'no values to write',
};

const WARNING_LABEL: Record<string, string> = {
  name_differs: 'name on file differs (not changed)',
  mobile_already_on_file_as_landline: 'that number is already on file as the landline',
  landline_already_on_file_as_mobile: 'that number is already on file as the mobile',
  email_conflict_kept: 'kept the email on file',
  mobile_conflict_kept: 'kept the mobile on file',
  phone_conflict_kept: 'kept the landline on file',
};

export function UpdatePeopleWizard({ open, onClose, onUpdated }: Props): JSX.Element {
  const [step, setStep] = useState<'paste' | 'preview'>('paste');
  const [pasted, setPasted] = useState('');
  const [createMissing, setCreateMissing] = useState(false);
  const [updateNames, setUpdateNames] = useState(false);
  const [fillBlanksOnly, setFillBlanksOnly] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ updated: number; created: number; skipped: number } | null>(
    null,
  );

  function reset(): void {
    setStep('paste');
    setPasted('');
    setCreateMissing(false);
    setUpdateNames(false);
    setFillBlanksOnly(false);
    setPreview(null);
    setBusy(false);
    setError('');
    setDone(null);
  }

  function close(): void {
    reset();
    onClose();
  }

  function body(): Record<string, unknown> {
    const b: Record<string, unknown> = { csv: pasted };
    if (createMissing) b['createMissing'] = true;
    if (updateNames) b['updateNames'] = true;
    if (fillBlanksOnly) b['fillBlanksOnly'] = true;
    return b;
  }

  async function runPreview(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const r = await api<PreviewResult>('/api/staff/people/bulk-update/preview', {
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
      const r = await api<{ updated: number; created: number; skipped: unknown[] }>(
        '/api/staff/people/bulk-update/commit',
        { method: 'POST', body: JSON.stringify(body()) },
      );
      setDone({ updated: r.updated, created: r.created, skipped: r.skipped.length });
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'update_failed');
    } finally {
      setBusy(false);
    }
  }

  const withChanges = preview ? preview.rows.filter((r) => r.changes?.length).length : 0;
  const alreadyCorrect = preview
    ? preview.rows.filter((r) => r.action === 'update' && !r.changes?.length).length
    : 0;
  const unmatched = preview ? preview.rows.filter((r) => r.reason === 'not_in_platform') : [];
  const unresolved = preview
    ? preview.rows.filter((r) => r.reason === 'ambiguous_match' || r.reason === 'conflicting_match')
    : [];

  function copyRows(rows: RowOutcome[]): void {
    const text = ['Name', ...rows.map((r) => r.name)].join('\n');
    void navigator.clipboard?.writeText(text);
  }

  const pasteStep: WizardStep = {
    key: 'paste',
    label: '1 · Paste',
    content: (
      <div style={{ display: 'grid', gap: tokens.space.md, maxWidth: 620 }}>
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
          Paste rows straight out of a spreadsheet. The{' '}
          <strong>first line must be the header</strong> — e.g.{' '}
          <code>Taxpayer Name · Mobile Phone · Landline Phone · Email</code>. Only the columns you
          include are written; unknown columns are ignored.
        </p>
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
          People have no Client ID, so each row is matched by{' '}
          <strong>email, then phone number, then name</strong> (initials and punctuation ignored on
          the last pass). A row that matches two people — or whose email belongs to someone other
          than the person it names — is reported, never guessed at. Pasted values replace what’s on
          file; the name is only used to find the person unless you ask otherwise.
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
              'Taxpayer Name\tMobile Phone\tLandline Phone\tEmail\nDusty Hayes\t\t(417) 592-7847\tabbeyscott30@gmail.com'
            }
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            aria-label="Paste people rows"
          />
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
          <input
            type="checkbox"
            checked={fillBlanksOnly}
            onChange={(e) => setFillBlanksOnly(e.target.checked)}
          />
          <span>
            Only fill blank fields
            <span style={{ color: tokens.color.textMuted }}>
              {' '}
              — leaves any value already on file alone and reports the difference
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
            Also rewrite names from the list
            <span style={{ color: tokens.color.textMuted }}>
              {' '}
              — otherwise a differing spelling is only flagged
            </span>
          </span>
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
          <input
            type="checkbox"
            checked={createMissing}
            onChange={(e) => setCreateMissing(e.target.checked)}
          />
          <span>
            Also add people who aren’t in the platform
            <span style={{ color: tokens.color.textMuted }}>
              {' '}
              — creates directory entries with no client attached
            </span>
          </span>
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
          Updated <strong>{done.updated}</strong> {done.updated === 1 ? 'person' : 'people'}.
          {done.created > 0 && ` Added ${done.created}.`}
          {done.skipped > 0 && ` ${done.skipped} row${done.skipped === 1 ? '' : 's'} left alone.`}
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
          <span style={{ color: tokens.color.accent }}>
            Will update: <strong>{withChanges}</strong>
          </span>
          <span style={{ color: tokens.color.textMuted }}>
            Already correct: <strong>{alreadyCorrect}</strong>
          </span>
          {createMissing && (
            <span style={{ color: tokens.color.success }}>
              Will add: <strong>{preview.willCreate}</strong>
            </span>
          )}
          <span style={{ color: unmatched.length ? tokens.color.warning : tokens.color.textMuted }}>
            Not in the platform: <strong>{unmatched.length}</strong>
          </span>
          <span style={{ color: unresolved.length ? tokens.color.danger : tokens.color.textMuted }}>
            Needs a decision: <strong>{unresolved.length}</strong>
          </span>
        </div>
        {(unmatched.length > 0 || unresolved.length > 0) && (
          <div
            style={{
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
              padding: tokens.space.sm,
              display: 'grid',
              gap: 6,
              fontSize: 13,
            }}
          >
            {unmatched.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <strong>
                  {unmatched.length} row{unmatched.length === 1 ? '' : 's'} match nobody
                </strong>
                <span style={{ color: tokens.color.textMuted }}>
                  {createMissing ? '— they will be added.' : '— nothing will be written for them.'}
                </span>
                <Button variant="ghost" onClick={() => copyRows(unmatched)}>
                  Copy list
                </Button>
              </div>
            )}
            {unresolved.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <strong>
                  {unresolved.length} row{unresolved.length === 1 ? '' : 's'} are ambiguous or
                  contradictory
                </strong>
                <span style={{ color: tokens.color.textMuted }}>
                  — skipped; fix them on the person’s card.
                </span>
                <Button variant="ghost" onClick={() => copyRows(unresolved)}>
                  Copy list
                </Button>
              </div>
            )}
          </div>
        )}
        <Table<RowOutcome>
          columns={[
            { key: 'row', header: 'Row', render: (r) => r.row + 2 },
            { key: 'name', header: 'In your list', render: (r) => r.name || '—' },
            {
              key: 'action',
              header: 'Action',
              render: (r) =>
                r.action === 'create' ? (
                  <Pill tone="success">add</Pill>
                ) : r.action === 'skip' ? (
                  <Pill tone="neutral">skip</Pill>
                ) : r.changes?.length ? (
                  <Pill tone="accent">update</Pill>
                ) : (
                  <Pill tone="neutral">no change</Pill>
                ),
            },
            {
              key: 'person',
              header: 'Matched person',
              render: (r) =>
                r.personName ? (
                  <span>
                    {r.personName}
                    {r.matchedBy && (
                      <span style={{ color: tokens.color.textMuted }}>
                        {' '}
                        · by {MATCH_LABEL[r.matchedBy] ?? r.matchedBy}
                      </span>
                    )}
                  </span>
                ) : (
                  ''
                ),
            },
            {
              key: 'changes',
              header: 'Changes',
              render: (r) =>
                r.changes?.length
                  ? r.changes
                      .map(
                        (c) =>
                          `${FIELD_LABEL[c.field]}: ${c.from ?? '(blank)'} → ${c.to ?? '(blank)'}`,
                      )
                      .join('; ')
                  : '',
            },
            {
              key: 'reason',
              header: 'Reason / notes',
              render: (r) => {
                if (r.reason) {
                  const label = REASON_LABEL[r.reason] ?? r.reason;
                  return r.detail ? `${label} (${r.detail})` : label;
                }
                return r.warnings?.length ? (
                  <span style={{ color: tokens.color.textMuted }}>
                    {r.warnings.map((w) => WARNING_LABEL[w] ?? w).join('; ')}
                  </span>
                ) : (
                  ''
                );
              },
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
    step === 'paste'
      ? {
          label: busy ? 'Checking…' : 'Preview',
          onClick: () => void runPreview(),
          disabled: busy || !pasted.trim(),
        }
      : done
        ? { label: 'Done', onClick: close }
        : {
            label: busy
              ? 'Updating…'
              : `Update ${withChanges} ${withChanges === 1 ? 'person' : 'people'}${
                  createMissing && preview?.willCreate ? ` + add ${preview.willCreate}` : ''
                }`,
            onClick: () => void commit(),
            disabled: busy || !preview || (withChanges === 0 && (preview?.willCreate ?? 0) === 0),
          };

  const secondaryAction =
    step === 'preview' && !done
      ? { label: 'Back', onClick: () => setStep('paste'), disabled: busy }
      : undefined;

  return (
    <Wizard
      open={open}
      title="Update people from a list"
      steps={[pasteStep, previewStep]}
      currentStepKey={step}
      onStepChange={(k) => {
        if (k === 'paste' && !done) setStep('paste');
      }}
      onClose={close}
      primaryAction={primaryAction}
      secondaryAction={secondaryAction}
      width={1000}
    />
  );
}
