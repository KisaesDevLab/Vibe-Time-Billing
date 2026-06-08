// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// TR-staff detail — read the return + sections + active releases.
// Lets staff create a new release (scope FULL or SELECTED with the
// section picker, cover note, download toggle) and revoke an existing
// release.
//
// Data sources:
//   GET    /api/staff/tax/returns/:returnId
//   POST   /api/staff/tax/returns/:returnId/releases
//   DELETE /api/staff/tax/returns/:returnId/releases/:releaseId

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { Button, Card, Input, Pill, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { ShareFileDialog } from './clients/ShareFileDialog';

interface SectionRow {
  id: string;
  ordinal: number;
  depth: number;
  parentSectionId: string | null;
  title: string;
  kind: string;
  formCode: string | null;
  startPage: number;
  endPage: number;
  recipientName: string | null;
  releasable: boolean;
  parseConfidence: number;
  isManualOverride: boolean;
}

const SECTION_KINDS = [
  'COVER',
  'MAIN_FORM',
  'SCHEDULE',
  'K1',
  'STATE',
  'WORKSHEET',
  'ATTACHMENT',
  'UNKNOWN',
] as const;

interface ReleaseRow {
  id: string;
  releasedToClientId: string;
  clientName: string | null;
  scope: 'FULL' | 'SELECTED';
  sectionIds: string[];
  clientCanDownload: boolean;
  coverNote: string | null;
  releasedAt: string;
  revokedAt: string | null;
}

interface ReturnDetail {
  return: {
    id: string;
    clientId: string;
    clientName: string;
    taxYear: number;
    formCode: string;
    jurisdiction: string;
    title: string;
    status: string;
    releaseKind: 'ORIGINAL' | 'AMENDED' | 'SUPERSEDED';
    totalPages: number | null;
    releasedAt: string | null;
    createdAt: string;
    sourceFileId: string | null;
  };
  sections: SectionRow[];
  releases: ReleaseRow[];
}

export function TaxReturnDetailPage(): JSX.Element {
  const { returnId } = useParams<{ returnId: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<ReturnDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!returnId) return;
    try {
      const r = await api<ReturnDetail>(`/api/staff/tax/returns/${returnId}`);
      setData(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }, [returnId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(releaseId: string): Promise<void> {
    if (!returnId) return;
    if (!window.confirm('Revoke this release? The client will lose access immediately.')) return;
    try {
      await api(`/api/staff/tax/returns/${returnId}/releases/${releaseId}`, {
        method: 'DELETE',
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function setReleaseDownload(releaseId: string, clientCanDownload: boolean): Promise<void> {
    if (!returnId) return;
    try {
      await api(`/api/staff/tax/returns/${returnId}/releases/${releaseId}`, {
        method: 'PATCH',
        body: JSON.stringify({ clientCanDownload }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function preview(): Promise<void> {
    const fileId = data?.return.sourceFileId;
    if (!fileId) return;
    try {
      // inline=1 → the source PDF renders in the browser, not a download.
      const r = await api<{ url: string }>(`/api/staff/files/${fileId}/download-url?inline=1`);
      if (r.url.startsWith('http')) setPreviewUrl(r.url);
      else setError('Preview needs B2 storage.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'preview_failed');
    }
  }

  async function deleteReturn(): Promise<void> {
    if (!returnId) return;
    const released = data?.return.status === 'RELEASED';
    const msg = released
      ? 'This return has been RELEASED to the client. Deleting it immediately revokes their portal access and any active share links, and removes the release/access history. The source PDF stays in the client’s Files folder. This cannot be undone.\n\nDelete anyway?'
      : 'Delete this tax return? This removes the return, its parsed sections, and any release/share history. The source PDF stays in the client’s Files folder. This cannot be undone.';
    if (!window.confirm(msg)) return;
    setDeleting(true);
    try {
      await api(`/api/staff/tax/returns/${returnId}`, { method: 'DELETE' });
      navigate('/tax/returns');
    } catch (err) {
      // Surface the API's guard reasons (released / has amendments) in
      // plain language rather than the raw error code.
      const msg = err instanceof Error ? err.message : 'failed';
      setError(
        msg.includes('cannot_delete_released')
          ? 'This return has been released to the client and can’t be deleted. Revoke the release and supersede it with an amendment instead.'
          : msg.includes('has_amendments')
            ? 'This return has an amendment pointing at it. Delete the amendment first.'
            : `Delete failed: ${msg}`,
      );
      setDeleting(false);
    }
  }

  if (error) {
    return (
      <div style={{ maxWidth: 700 }}>
        <Card title="Tax return unavailable">
          <p style={{ fontSize: 14, color: tokens.color.danger }}>{error}</p>
          <p style={{ marginTop: 12 }}>
            <Link to="/tax/returns" style={{ color: tokens.color.accent }}>
              ← All tax returns
            </Link>
          </p>
        </Card>
      </div>
    );
  }
  if (!data) {
    return (
      <div style={{ maxWidth: 700 }}>
        <Card title="Loading return…">
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>One moment.</p>
        </Card>
      </div>
    );
  }

  const { return: ret, sections, releases } = data;

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <div>
        <Link
          to="/tax/returns"
          style={{ color: tokens.color.accent, fontSize: 13, textDecoration: 'none' }}
        >
          ← All tax returns
        </Link>
      </div>

      <Card title={`${ret.taxYear} ${ret.formCode} — ${ret.jurisdiction}`}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <Pill tone={ret.releaseKind === 'AMENDED' ? 'warning' : 'accent'}>{ret.releaseKind}</Pill>
          <Pill tone="neutral">{ret.status}</Pill>
        </div>
        <p style={{ fontSize: 14, margin: 0 }}>
          <strong>Client:</strong> {ret.clientName}
        </p>
        {ret.title && <p style={{ fontSize: 14, marginTop: 8 }}>{ret.title}</p>}
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 8 }}>
          {ret.totalPages != null && `${ret.totalPages} pages total · `}
          Imported {new Date(ret.createdAt).toLocaleDateString()}
          {ret.releasedAt && ` · last released ${new Date(ret.releasedAt).toLocaleDateString()}`}
        </p>
        <div style={{ marginTop: tokens.space.md, display: 'flex', gap: 8 }}>
          <Button onClick={() => setReleaseOpen(true)}>Release to client</Button>
          {ret.sourceFileId && (
            <Button
              variant="secondary"
              onClick={() => void preview()}
              title="Preview the source PDF in the browser without downloading."
            >
              Preview
            </Button>
          )}
          {ret.sourceFileId && (
            <Button
              variant="secondary"
              onClick={() => setShareOpen(true)}
              title="Securely share the return PDF with an outside recipient via an expiring link."
            >
              Share via link
            </Button>
          )}
          <div style={{ marginLeft: 'auto' }}>
            <Button
              variant="danger"
              disabled={deleting}
              title={
                ret.status === 'RELEASED'
                  ? 'Delete this return — revokes the client’s access and removes release history. The source PDF stays in Files.'
                  : 'Delete this tax return. The source PDF stays in the client’s Files folder.'
              }
              onClick={() => void deleteReturn()}
            >
              {deleting ? 'Deleting…' : 'Delete return'}
            </Button>
          </div>
        </div>
      </Card>

      {shareOpen && ret.sourceFileId && (
        <ShareFileDialog
          file={{
            id: ret.sourceFileId,
            originalFilename: `${ret.taxYear} ${ret.formCode} ${ret.jurisdiction}.pdf`,
            mimeType: 'application/pdf',
          }}
          onClose={() => setShareOpen(false)}
          onShared={() => setShareOpen(false)}
        />
      )}

      <SectionsManager
        returnId={ret.id}
        status={ret.status}
        hasSource={Boolean(ret.sourceFileId)}
        sections={sections}
        onChanged={load}
      />

      <TaxPaymentsCard
        returnId={ret.id}
        clientId={ret.clientId}
        jurisdiction={ret.jurisdiction}
        taxYear={ret.taxYear}
      />

      <Card title={`Active releases (${releases.length})`}>
        {releases.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
            No active releases. Use the Release button above to share this return.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {releases.map((r) => (
              <li
                key={r.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  padding: '8px 0',
                  borderBottom: `1px solid ${tokens.color.border}`,
                  fontSize: 13,
                }}
              >
                <div>
                  <div style={{ fontWeight: 500 }}>
                    Released to {r.clientName ?? `client ${r.releasedToClientId.slice(0, 8)}…`}
                  </div>
                  <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
                    {r.scope === 'FULL'
                      ? 'Full return'
                      : `${r.sectionIds.length} section${r.sectionIds.length === 1 ? '' : 's'}`}
                    {' · '}
                    {new Date(r.releasedAt).toLocaleDateString()}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <Pill tone={r.clientCanDownload ? 'success' : 'neutral'}>
                    {r.clientCanDownload ? '⬇ download on' : '🔒 view only'}
                  </Pill>
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Toggle whether the client can download this release's PDF."
                    onClick={() => void setReleaseDownload(r.id, !r.clientCanDownload)}
                  >
                    {r.clientCanDownload ? 'Disable download' : 'Enable download'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void revoke(r.id)}>
                    Revoke
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <AccessHistoryCard returnId={ret.id} />

      {releaseOpen && (
        <ReleaseDialog
          returnId={ret.id}
          defaultClientId={ret.clientId}
          sections={sections}
          onClose={() => setReleaseOpen(false)}
          onReleased={async () => {
            setReleaseOpen(false);
            await load();
          }}
        />
      )}

      {previewUrl && (
        <PdfPreviewModal
          title={`${ret.taxYear} ${ret.formCode} ${ret.jurisdiction}`}
          url={previewUrl}
          onClose={() => setPreviewUrl(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PDF preview modal — renders the source PDF inline in an iframe.
// ---------------------------------------------------------------------------

function PdfPreviewModal({
  title,
  url,
  onClose,
}: {
  title: string;
  url: string;
  onClose: () => void;
}): JSX.Element {
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Preview ${title}`}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex',
        flexDirection: 'column',
        padding: 24,
        zIndex: 300,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minHeight: 0,
          background: tokens.color.surface,
          borderRadius: 8,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 14px',
            borderBottom: `1px solid ${tokens.color.border}`,
          }}
        >
          <span style={{ fontSize: 13, flex: 1 }}>{title}</span>
          <Button size="sm" variant="ghost" onClick={() => window.open(url, '_blank', 'noopener')}>
            Open in new tab
          </Button>
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
        <iframe
          title={`Preview of ${title}`}
          src={url}
          style={{ flex: 1, width: '100%', border: 'none', minHeight: 0 }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tax payments linked to this return — list + create (pre-filled).
// ---------------------------------------------------------------------------

interface PaymentRow {
  id: string;
  paymentType: string;
  jurisdiction: string;
  amountCents: number;
  dueDate: string;
  status: 'SCHEDULED' | 'PAID' | 'VOIDED';
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function payTone(s: string): 'success' | 'warning' | 'neutral' {
  if (s === 'PAID') return 'success';
  if (s === 'VOIDED') return 'warning';
  return 'neutral';
}

function TaxPaymentsCard({
  returnId,
  clientId,
  jurisdiction,
  taxYear,
}: {
  returnId: string;
  clientId: string;
  jurisdiction: string;
  taxYear: number;
}): JSX.Element {
  const [rows, setRows] = useState<PaymentRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  // Form
  const [paymentType, setPaymentType] = useState('Estimated Tax');
  const [jur, setJur] = useState(jurisdiction);
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState('');

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await api<{ items: PaymentRow[] }>(`/api/staff/tax-payments?returnId=${returnId}`);
      setRows(r.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }, [returnId]);

  useEffect(() => {
    void load();
  }, [load]);

  const validAmount = Number(amount) > 0;
  const valid =
    paymentType.trim() && jur.trim() && validAmount && /^\d{4}-\d{2}-\d{2}$/.test(dueDate);

  async function create(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api('/api/staff/tax-payments', {
        method: 'POST',
        body: JSON.stringify({
          clientId,
          taxReturnId: returnId,
          jurisdiction: jur.trim(),
          paymentType: paymentType.trim(),
          taxYear,
          amountCents: Math.round(Number(amount) * 100),
          dueDate,
        }),
      });
      setAdding(false);
      setAmount('');
      setDueDate('');
      setPaymentType('Estimated Tax');
      setJur(jurisdiction);
      await load();
    } catch (err) {
      const code = err instanceof Error ? err.message : 'failed';
      setError(
        code === 'forbidden'
          ? 'You need the tax_payment:write permission to add payments.'
          : code === 'tax_return_not_in_client'
            ? 'This return isn’t linked to the client.'
            : `Add failed: ${code}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={`Tax payments (${rows.length})`}>
      <div style={{ marginBottom: 10 }}>
        <Button size="sm" variant="ghost" onClick={() => setAdding((a) => !a)}>
          {adding ? 'Cancel' : 'Add payment'}
        </Button>
      </div>
      {error && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 0 }}>{error}</p>}
      {adding && (
        <div
          style={{
            display: 'grid',
            gap: 8,
            padding: 12,
            marginBottom: 10,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: 6,
          }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 6 }}>
            <Input
              value={paymentType}
              onChange={(e) => setPaymentType(e.target.value)}
              placeholder="Payment type (e.g. Estimated Tax — Q1, Balance Due)"
            />
            <Input
              value={jur}
              onChange={(e) => setJur(e.target.value)}
              placeholder="Jurisdiction"
            />
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={lbl()}>
              Amount $
              <input
                type="number"
                min={0}
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                style={{ ...numStyle(), width: 110 }}
              />
            </label>
            <label style={lbl()}>
              Due
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                style={selStyle()}
              />
            </label>
            <div style={{ marginLeft: 'auto' }}>
              <Button size="sm" onClick={() => void create()} disabled={busy || !valid}>
                {busy ? 'Adding…' : 'Add payment'}
              </Button>
            </div>
          </div>
        </div>
      )}
      {rows.length === 0 ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
          No tax payments linked to this return yet.
        </p>
      ) : (
        <div>
          {rows.map((p) => (
            <div
              key={p.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 0',
                borderBottom: `1px solid ${tokens.color.border}`,
                fontSize: 13,
              }}
            >
              <span style={{ flex: 1 }}>
                {p.paymentType}
                <span style={{ color: tokens.color.textMuted }}> · {p.jurisdiction}</span>
              </span>
              <Pill tone={payTone(p.status)}>{p.status}</Pill>
              <span
                style={{
                  color: tokens.color.textMuted,
                  fontSize: 12,
                  minWidth: 90,
                  textAlign: 'right',
                }}
              >
                due {p.dueDate}
              </span>
              <span style={{ minWidth: 90, textAlign: 'right', fontWeight: 500 }}>
                {money(p.amountCents)}
              </span>
            </div>
          ))}
        </div>
      )}
      <p style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 10, marginBottom: 0 }}>
        Payments added here are linked to this return and appear on the{' '}
        <Link to="/tax/returns?tab=payments" style={{ color: tokens.color.accent }}>
          Payments tab
        </Link>
        .
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Sections manager — automated re-parse + manual add/edit/delete.
// ---------------------------------------------------------------------------

function apiErrMessage(e: unknown): string {
  const code = e instanceof Error ? e.message : 'failed';
  switch (code) {
    case 'cannot_reparse_released':
      return 'Released returns are locked — revoke the release first.';
    case 'no_source_file':
      return 'No source PDF is attached to this return.';
    case 'storage_unavailable':
      return 'Storage is not configured, so the PDF can’t be parsed.';
    case 'parse_failed':
      return 'Could not parse the PDF (it may be image-only or have no bookmarks). Add sections by page range instead.';
    case 'end_before_start':
      return 'End page must be ≥ start page.';
    default:
      return code;
  }
}

function kindTone(k: string): 'success' | 'warning' | 'neutral' | 'accent' {
  if (k === 'K1') return 'accent';
  if (k === 'STATE') return 'warning';
  return 'neutral';
}

function numStyle(): CSSProperties {
  return {
    width: 64,
    padding: '4px 6px',
    border: `1px solid ${tokens.color.border}`,
    borderRadius: 4,
    fontSize: 13,
  };
}
function selStyle(): CSSProperties {
  return {
    padding: '6px 8px',
    border: `1px solid ${tokens.color.border}`,
    borderRadius: 4,
    fontSize: 13,
    background: tokens.color.surface,
  };
}
function lbl(): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    color: tokens.color.textMuted,
  };
}

function SectionsManager({
  returnId,
  status,
  hasSource,
  sections,
  onChanged,
}: {
  returnId: string;
  status: string;
  hasSource: boolean;
  sections: SectionRow[];
  onChanged: () => Promise<void>;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const released = status === 'RELEASED';

  async function reparse(): Promise<void> {
    if (
      !window.confirm(
        'Auto-detect sections from the PDF’s bookmarks? This replaces the current sections, including any manual edits.',
      )
    )
      return;
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const r = await api<{ strategy: string; sections: number }>(
        `/api/staff/tax/returns/${returnId}/reparse`,
        { method: 'POST' },
      );
      setNote(
        `Detected ${r.sections} section${r.sections === 1 ? '' : 's'} (${
          r.strategy === 'outline'
            ? 'from PDF bookmarks'
            : r.strategy === 'headers'
              ? 'from page headers'
              : 'single section'
        }).`,
      );
      await onChanged();
    } catch (e) {
      setErr(apiErrMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={`Sections (${sections.length})`}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
        <Button
          size="sm"
          disabled={busy || released || !hasSource}
          onClick={() => void reparse()}
          title={
            released
              ? 'Released returns are locked'
              : !hasSource
                ? 'No source PDF attached'
                : 'Auto-detect sections from the PDF outline'
          }
        >
          {busy ? 'Parsing…' : 'Auto-detect sections'}
        </Button>
        <Button size="sm" variant="ghost" disabled={released} onClick={() => setAdding((a) => !a)}>
          {adding ? 'Cancel' : 'Add section'}
        </Button>
        {note && <span style={{ fontSize: 12, color: tokens.color.textMuted }}>{note}</span>}
      </div>
      {err && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 0 }}>{err}</p>}
      {adding && (
        <AddSectionForm
          returnId={returnId}
          onDone={async () => {
            setAdding(false);
            await onChanged();
          }}
        />
      )}
      {sections.length === 0 ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
          No sections yet. Use “Auto-detect sections” or add one by page range.
        </p>
      ) : (
        <div>
          {sections.map((s) => (
            <SectionRowEditor
              key={s.id}
              returnId={returnId}
              section={s}
              locked={released}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

function SectionRowEditor({
  returnId,
  section,
  locked,
  onChanged,
}: {
  returnId: string;
  section: SectionRow;
  locked: boolean;
  onChanged: () => Promise<void>;
}): JSX.Element {
  const [edit, setEdit] = useState(false);
  const [title, setTitle] = useState(section.title);
  const [kind, setKind] = useState(section.kind);
  const [recipient, setRecipient] = useState(section.recipientName ?? '');
  const [start, setStart] = useState(String(section.startPage));
  const [end, setEnd] = useState(String(section.endPage));
  const [releasable, setReleasable] = useState(section.releasable);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/staff/tax/returns/${returnId}/sections/${section.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          normalizedTitle: title,
          kind,
          recipientName: recipient.trim() || null,
          releasable,
          startPage: Number(start),
          endPage: Number(end),
        }),
      });
      setEdit(false);
      await onChanged();
    } catch (e) {
      setErr(apiErrMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function del(): Promise<void> {
    if (!window.confirm('Delete this section?')) return;
    setBusy(true);
    try {
      await api(`/api/staff/tax/returns/${returnId}/sections/${section.id}`, { method: 'DELETE' });
      await onChanged();
    } catch (e) {
      setErr(apiErrMessage(e));
      setBusy(false);
    }
  }

  if (!edit) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '7px 0',
          borderBottom: `1px solid ${tokens.color.border}`,
          paddingLeft: Math.max(0, section.depth - 1) * 14,
          fontSize: 13,
        }}
      >
        <span style={{ flex: 1 }}>
          {section.title}
          {section.recipientName && (
            <span style={{ color: tokens.color.textMuted }}> — {section.recipientName}</span>
          )}
        </span>
        <Pill tone={kindTone(section.kind)}>{section.kind}</Pill>
        {!section.releasable && <Pill tone="warning">internal</Pill>}
        {section.isManualOverride ? (
          <Pill tone="neutral">manual</Pill>
        ) : section.parseConfidence > 0 ? (
          <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
            {section.parseConfidence}%
          </span>
        ) : null}
        <span
          style={{ color: tokens.color.textMuted, fontSize: 12, minWidth: 72, textAlign: 'right' }}
        >
          pp {section.startPage}–{section.endPage}
        </span>
        {!locked && (
          <>
            <Button size="sm" variant="ghost" onClick={() => setEdit(true)}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void del()}>
              Delete
            </Button>
          </>
        )}
      </div>
    );
  }
  return (
    <div
      style={{
        display: 'grid',
        gap: 6,
        padding: '10px 0',
        borderBottom: `1px solid ${tokens.color.border}`,
      }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 6 }}>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" />
        <select value={kind} onChange={(e) => setKind(e.target.value)} style={selStyle()}>
          {SECTION_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <Input
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="Recipient (K-1)"
        />
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={lbl()}>
          Start
          <input
            type="number"
            min={1}
            value={start}
            onChange={(e) => setStart(e.target.value)}
            style={numStyle()}
          />
        </label>
        <label style={lbl()}>
          End
          <input
            type="number"
            min={1}
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            style={numStyle()}
          />
        </label>
        <label style={lbl()}>
          <input
            type="checkbox"
            checked={releasable}
            onChange={(e) => setReleasable(e.target.checked)}
          />
          Releasable to client
        </label>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <Button size="sm" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEdit(false)}>
            Cancel
          </Button>
        </div>
      </div>
      {err && <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }}>{err}</p>}
    </div>
  );
}

function AddSectionForm({
  returnId,
  onDone,
}: {
  returnId: string;
  onDone: () => Promise<void>;
}): JSX.Element {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('SCHEDULE');
  const [recipient, setRecipient] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [releasable, setReleasable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const valid =
    title.trim().length > 0 && Number(start) >= 1 && Number(end) >= Number(start) && start !== '';

  async function create(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/staff/tax/returns/${returnId}/sections`, {
        method: 'POST',
        body: JSON.stringify({
          normalizedTitle: title,
          kind,
          recipientName: recipient.trim() || null,
          startPage: Number(start),
          endPage: Number(end),
          releasable,
        }),
      });
      await onDone();
    } catch (e) {
      setErr(apiErrMessage(e));
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: 'grid',
        gap: 8,
        padding: 12,
        marginBottom: 10,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: 6,
        background: tokens.color.surface,
      }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 6 }}>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Section title"
        />
        <select value={kind} onChange={(e) => setKind(e.target.value)} style={selStyle()}>
          {SECTION_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <Input
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="Recipient (K-1)"
        />
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={lbl()}>
          Start
          <input
            type="number"
            min={1}
            value={start}
            onChange={(e) => setStart(e.target.value)}
            style={numStyle()}
          />
        </label>
        <label style={lbl()}>
          End
          <input
            type="number"
            min={1}
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            style={numStyle()}
          />
        </label>
        <label style={lbl()}>
          <input
            type="checkbox"
            checked={releasable}
            onChange={(e) => setReleasable(e.target.checked)}
          />
          Releasable to client
        </label>
        <div style={{ marginLeft: 'auto' }}>
          <Button size="sm" onClick={() => void create()} disabled={busy || !valid}>
            {busy ? 'Adding…' : 'Add section'}
          </Button>
        </div>
      </div>
      {err && <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }}>{err}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Access history — every view / release / revoke / share / edit event.
// ---------------------------------------------------------------------------

interface AccessLogRow {
  id: string;
  event: string;
  actorKind: string;
  actorRef: string | null;
  actorName: string | null;
  at: string;
  metadata: Record<string, unknown> | null;
}

function eventLabel(e: string): string {
  const map: Record<string, string> = {
    VIEW: 'Viewed',
    RELEASED: 'Released to client',
    REVOKED: 'Release revoked',
    SHARED: 'Shared via link',
    SECTION_EDITED: 'Section edited',
    '2FA_PASSED': '2FA passed',
    '2FA_FAILED': '2FA failed',
    DOWNLOADED: 'Downloaded',
  };
  return map[e] ?? e.replace(/_/g, ' ').toLowerCase();
}

function AccessHistoryCard({ returnId }: { returnId: string }): JSX.Element {
  const [rows, setRows] = useState<AccessLogRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await api<{ items: AccessLogRow[] }>(
          `/api/staff/tax/returns/${returnId}/access-log`,
        );
        if (!cancelled) setRows(r.items);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'failed');
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [returnId]);

  return (
    <Card title={`Access history${rows.length ? ` (${rows.length})` : ''}`}>
      <div style={{ marginBottom: 8 }}>
        <a
          href={`/api/staff/tax/returns/${returnId}/access-log.csv`}
          style={{ fontSize: 12, color: tokens.color.accent }}
        >
          Export CSV
        </a>
      </div>
      {err ? (
        <p style={{ fontSize: 12, color: tokens.color.danger }}>Couldn’t load history: {err}</p>
      ) : !loaded ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
          No access activity yet. Views, releases, shares, and edits will appear here.
        </p>
      ) : (
        <div>
          {rows.map((r) => {
            const pages =
              r.metadata && typeof r.metadata['pages'] === 'number'
                ? (r.metadata['pages'] as number)
                : null;
            return (
              <div
                key={r.id}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 8,
                  padding: '6px 0',
                  borderBottom: `1px solid ${tokens.color.border}`,
                  fontSize: 13,
                }}
              >
                <Pill
                  tone={
                    r.actorKind === 'CLIENT'
                      ? 'success'
                      : r.actorKind === 'RECIPIENT'
                        ? 'accent'
                        : r.actorKind === 'SYSTEM'
                          ? 'warning'
                          : 'neutral'
                  }
                >
                  {r.actorKind}
                </Pill>
                <span style={{ flex: 1 }}>
                  {eventLabel(r.event)}
                  {r.actorName && <span style={{ fontWeight: 500 }}> · {r.actorName}</span>}
                  {pages != null && (
                    <span style={{ color: tokens.color.textMuted }}> · {pages}pp</span>
                  )}
                </span>
                <span style={{ color: tokens.color.textMuted, fontSize: 12 }}>
                  {new Date(r.at).toLocaleString()}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

interface ReleaseDialogProps {
  returnId: string;
  defaultClientId: string;
  sections: SectionRow[];
  onClose: () => void;
  onReleased: () => Promise<void> | void;
}

function ReleaseDialog(props: ReleaseDialogProps): JSX.Element {
  const [clientId, setClientId] = useState(props.defaultClientId);
  const [scope, setScope] = useState<'FULL' | 'SELECTED'>('FULL');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [clientCanDownload, setClientCanDownload] = useState(true);
  const [coverNote, setCoverNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const sectionIds = useMemo(() => [...selected], [selected]);

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit(): Promise<void> {
    if (scope === 'SELECTED' && sectionIds.length === 0) {
      setErr('Pick at least one section, or switch to Full return.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/staff/tax/returns/${props.returnId}/releases`, {
        method: 'POST',
        body: JSON.stringify({
          releasedToClientId: clientId,
          scope,
          sectionIds: scope === 'SELECTED' ? sectionIds : [],
          clientCanDownload,
          coverNote: coverNote.trim().length > 0 ? coverNote.trim() : null,
        }),
      });
      await props.onReleased();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="release-title"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: tokens.space.md,
      }}
    >
      <div
        style={{
          background: tokens.color.bg,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.lg,
          padding: tokens.space.lg,
          width: '100%',
          maxWidth: 640,
          maxHeight: '92vh',
          overflowY: 'auto',
        }}
      >
        <h2 id="release-title" style={{ margin: 0, fontSize: 18 }}>
          Release tax return to client
        </h2>
        <div style={{ marginTop: tokens.space.md, display: 'grid', gap: 12 }}>
          <Input
            label="Released to client (UUID) *"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          />
          <div>
            <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
              Scope
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button
                size="sm"
                variant={scope === 'FULL' ? 'primary' : 'secondary'}
                onClick={() => setScope('FULL')}
              >
                Full return
              </Button>
              <Button
                size="sm"
                variant={scope === 'SELECTED' ? 'primary' : 'secondary'}
                onClick={() => setScope('SELECTED')}
              >
                Selected sections
              </Button>
            </div>
          </div>
          {scope === 'SELECTED' && (
            <div
              style={{
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm,
                padding: 8,
                maxHeight: 240,
                overflowY: 'auto',
              }}
            >
              {props.sections.length === 0 ? (
                <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
                  This return has no sections; only Full release is available.
                </p>
              ) : (
                props.sections.map((s) => (
                  <label
                    key={s.id}
                    htmlFor={`section-${s.id}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '4px 0',
                      paddingLeft: Math.max(0, s.depth - 1) * 14,
                      fontSize: 13,
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      id={`section-${s.id}`}
                      type="checkbox"
                      checked={selected.has(s.id)}
                      onChange={() => toggle(s.id)}
                    />
                    <span style={{ flex: 1 }}>{s.title}</span>
                    <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                      pp {s.startPage}–{s.endPage}
                    </span>
                  </label>
                ))
              )}
            </div>
          )}
          <label
            htmlFor="can-download"
            style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}
          >
            <input
              id="can-download"
              type="checkbox"
              checked={clientCanDownload}
              onChange={(e) => setClientCanDownload(e.target.checked)}
            />
            Client can download the PDF
          </label>
          <div>
            <label
              htmlFor="cover-note"
              style={{
                fontSize: 12,
                color: tokens.color.textMuted,
                display: 'block',
                marginBottom: 4,
              }}
            >
              Cover note (optional)
            </label>
            <textarea
              id="cover-note"
              value={coverNote}
              onChange={(e) => setCoverNote(e.target.value)}
              maxLength={2000}
              rows={4}
              style={{
                width: '100%',
                padding: 8,
                fontSize: 13,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm,
                fontFamily: tokens.font.body,
                resize: 'vertical',
              }}
            />
          </div>
          {err && <p style={{ fontSize: 12, color: tokens.color.danger, margin: 0 }}>{err}</p>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="ghost" onClick={props.onClose} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} disabled={busy}>
              {busy ? 'Releasing…' : 'Release'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
