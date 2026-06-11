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

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { Button, Card, Combobox, Input, Pill, tokens } from '@vibe/ui';

import { api, getCsrfToken } from '../api-client';
import { usePermission } from '../auth-context';
import { dollarsInputToCents } from '../lib/money';
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
  const [signaturesOpen, setSignaturesOpen] = useState(false);
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

      <SignaturesCard onCollect={() => setSignaturesOpen(true)} />

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

      {signaturesOpen && (
        <CollectSignaturesDialog
          returnId={ret.id}
          clientId={ret.clientId}
          onClose={() => setSignaturesOpen(false)}
          onCreated={(requestId) => navigate(`/signatures/${requestId}`)}
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
// Signatures card — entry point to the collect-signatures flow.
// ---------------------------------------------------------------------------

function SignaturesCard({ onCollect }: { onCollect: () => void }): JSX.Element {
  const canWrite = usePermission('proposal:write');
  return (
    <Card title="Signatures">
      <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 0 }}>
        Build an e-signature package from this return — detected signature pages, default documents,
        and any ad-hoc attachments — then route it to the signers for review.
      </p>
      <Button disabled={!canWrite} onClick={onCollect}>
        Collect signatures
      </Button>
      {!canWrite && (
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 8, marginBottom: 0 }}>
          You need write access to collect signatures.
        </p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Collect-signatures dialog — detect pages, pick templates/ad-hoc docs,
// choose signers (with filing status for 1040), then create the request.
// ---------------------------------------------------------------------------

interface DetectPage {
  pageNumber: number;
  bookmarkTitle: string;
  layoutKey: string;
  profileFormType: string | null;
}
interface DetectTemplate {
  id: string;
  name: string;
  totalPages: number;
  autoInclude: boolean;
}
interface DetectBookmark {
  pageNumber: number;
  title: string;
  depth: number;
}
interface SignatureDetect {
  formCode: string;
  signatureFormType: string;
  pages: DetectPage[];
  allBookmarks: DetectBookmark[];
  templates: DetectTemplate[];
  noRulesConfigured: boolean;
  noSource: boolean;
}

// Default field layout for a manually-picked bookmark page (no rule matched).
function defaultLayoutForForm(signatureFormType: string): string {
  if (signatureFormType === '8879') return 'us-8879';
  if (signatureFormType.startsWith('8879-')) return 'entity-8879';
  return 'generic';
}

type SignerRole = 'taxpayer' | 'spouse' | 'officer';

const ROLE_OPTIONS: ReadonlyArray<{ value: SignerRole; label: string }> = [
  { value: 'taxpayer', label: 'Taxpayer' },
  { value: 'spouse', label: 'Spouse' },
  { value: 'officer', label: 'Officer' },
];

// One reconciled person on the client (subset of /clients/:id/people we need).
interface SigPerson {
  key: string;
  name: string;
  email: string | null;
  hint: string;
  personId?: string;
  clientContactId?: string;
  portalIdentityId?: string;
}

interface SigPeopleApiEntry {
  key: string;
  kind: string;
  contact: {
    id: string;
    personId: string;
    fullName: string;
    email?: string | null;
    isPrimary?: boolean;
  } | null;
  access: {
    portalIdentityId: string;
    fullName: string;
    primaryEmail?: string | null;
  } | null;
  pendingInvitation: {
    proposedFullName: string;
    invitedEmail?: string | null;
  } | null;
}

const SIG_KIND_HINT: Record<string, string> = {
  linked: 'Contact + portal',
  contact_only: 'Contact',
  portal_only: 'Portal user',
  invited: 'Invited',
};

function toSigPerson(e: SigPeopleApiEntry): SigPerson | null {
  const name =
    e.contact?.fullName ?? e.access?.fullName ?? e.pendingInvitation?.proposedFullName ?? '';
  if (!name) return null;
  const email =
    e.contact?.email ?? e.access?.primaryEmail ?? e.pendingInvitation?.invitedEmail ?? null;
  const hint = e.contact?.isPrimary ? 'Primary contact' : (SIG_KIND_HINT[e.kind] ?? e.kind);
  return {
    key: e.key,
    name,
    email,
    hint,
    personId: e.contact?.personId,
    clientContactId: e.contact?.id,
    portalIdentityId: e.access?.portalIdentityId,
  };
}

// Default role for a freshly-picked signer given the return's form type and
// (for 1040) the chosen filing status / existing picks.
function defaultRoleFor(
  signatureFormType: string,
  filingStatus: 'single' | 'mfj',
  alreadyTaxpayer: boolean,
): SignerRole {
  if (signatureFormType === '8879') {
    return filingStatus === 'mfj' && alreadyTaxpayer ? 'spouse' : 'taxpayer';
  }
  if (signatureFormType.startsWith('8879-')) return 'officer';
  return 'taxpayer';
}

interface PickedSigner {
  person: SigPerson;
  role: SignerRole;
}

function CollectSignaturesDialog({
  returnId,
  clientId,
  onClose,
  onCreated,
}: {
  returnId: string;
  clientId: string;
  onClose: () => void;
  onCreated: (requestId: string) => void;
}): JSX.Element {
  const [detect, setDetect] = useState<SignatureDetect | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [checkedPages, setCheckedPages] = useState<Set<number>>(new Set());
  const [checkedBookmarks, setCheckedBookmarks] = useState<Set<number>>(new Set());
  const [checkedTemplates, setCheckedTemplates] = useState<Set<string>>(new Set());
  const [filingStatus, setFilingStatus] = useState<'single' | 'mfj'>('single');
  const [showBookmarks, setShowBookmarks] = useState(false);

  const [people, setPeople] = useState<SigPerson[]>([]);
  const [picked, setPicked] = useState<PickedSigner[]>([]);

  const [adHocKeys, setAdHocKeys] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Load the signature-detect payload + the client's people.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await api<SignatureDetect>(`/api/staff/tax/returns/${returnId}/signature-detect`);
        if (cancelled) return;
        setDetect(r);
        setCheckedPages(new Set(r.pages.map((p) => p.pageNumber)));
        setCheckedTemplates(new Set(r.templates.filter((t) => t.autoInclude).map((t) => t.id)));
      } catch (e) {
        if (!cancelled) setLoadErr(e instanceof Error ? e.message : 'detect_failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [returnId]);

  useEffect(() => {
    let cancelled = false;
    void api<{ items?: SigPeopleApiEntry[]; people?: SigPeopleApiEntry[] }>(
      `/api/staff/clients/${clientId}/people`,
    )
      .then((r) => {
        if (cancelled) return;
        const raw = r.items ?? r.people ?? [];
        const entries = raw.map(toSigPerson).filter((x): x is SigPerson => x !== null);
        const seen = new Set<string>();
        setPeople(entries.filter((e) => (seen.has(e.key) ? false : (seen.add(e.key), true))));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  const is1040 = detect?.signatureFormType === '8879';

  function togglePage(n: number): void {
    setCheckedPages((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  }
  function toggleBookmark(n: number): void {
    setCheckedBookmarks((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  }
  function renderBookmarkList(bookmarks: DetectBookmark[]): JSX.Element {
    return (
      <div
        style={{
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.sm,
          padding: 8,
          maxHeight: 220,
          overflowY: 'auto',
        }}
      >
        {bookmarks.map((b, i) => (
          <label
            key={`${b.pageNumber}-${i}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '4px 0',
              paddingLeft: 8 + Math.min(b.depth, 4) * 14,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={checkedBookmarks.has(b.pageNumber)}
              onChange={() => toggleBookmark(b.pageNumber)}
            />
            <span style={{ flex: 1 }}>{b.title}</span>
            <span style={{ color: tokens.color.textMuted, fontSize: 12 }}>p.{b.pageNumber}</span>
          </label>
        ))}
      </div>
    );
  }
  function toggleTemplate(id: string): void {
    setCheckedTemplates((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function togglePerson(p: SigPerson, checked: boolean): void {
    setPicked((prev) => {
      if (checked) {
        if (prev.some((s) => s.person.key === p.key)) return prev;
        const hasTaxpayer = prev.some((s) => s.role === 'taxpayer');
        const role = defaultRoleFor(detect?.signatureFormType ?? '', filingStatus, hasTaxpayer);
        return [...prev, { person: p, role }];
      }
      return prev.filter((s) => s.person.key !== p.key);
    });
  }
  function setRole(key: string, role: SignerRole): void {
    setPicked((prev) => prev.map((s) => (s.person.key === key ? { ...s, role } : s)));
  }

  const pickedKeys = new Set(picked.map((s) => s.person.key));

  async function uploadAdHoc(file: File): Promise<void> {
    setUploading(true);
    setError(null);
    try {
      const csrf = getCsrfToken();
      const res = await fetch(`/api/staff/tax/returns/${returnId}/signature-doc`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/pdf',
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        },
        body: file,
      });
      if (!res.ok) throw new Error(`upload_failed_${res.status}`);
      const body = (await res.json()) as { key: string };
      setAdHocKeys((prev) => [...prev, body.key]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'upload_failed');
    } finally {
      setUploading(false);
    }
  }

  async function submit(): Promise<void> {
    if (!detect) return;
    const signers = picked
      .filter((s) => s.person.name.trim() && (s.person.email ?? '').trim())
      .map((s) => ({
        name: s.person.name.trim(),
        email: (s.person.email ?? '').trim(),
        role: s.role,
        personId: s.person.personId,
        clientContactId: s.person.clientContactId,
        portalIdentityId: s.person.portalIdentityId,
      }));
    if (signers.length === 0) {
      setError('Add at least one signer with a name and email.');
      return;
    }
    // Merge rule-detected pages (their layout + optional placement profile)
    // with manually-picked bookmark pages (a default layout for the return
    // type). Detected layout wins.
    const pageLayout = new Map<number, { layoutKey: string; profileFormType: string | null }>();
    for (const p of detect.pages) {
      if (checkedPages.has(p.pageNumber)) {
        pageLayout.set(p.pageNumber, {
          layoutKey: p.layoutKey,
          profileFormType: p.profileFormType ?? null,
        });
      }
    }
    const manualLayout = defaultLayoutForForm(detect.signatureFormType);
    for (const b of detect.allBookmarks ?? []) {
      if (checkedBookmarks.has(b.pageNumber) && !pageLayout.has(b.pageNumber)) {
        pageLayout.set(b.pageNumber, { layoutKey: manualLayout, profileFormType: null });
      }
    }
    const returnPages = [...pageLayout.entries()].map(([page, v]) => ({ page, ...v }));
    const templateIds = detect.templates.filter((t) => checkedTemplates.has(t.id)).map((t) => t.id);
    if (returnPages.length === 0 && templateIds.length === 0 && adHocKeys.length === 0) {
      setError('Select at least one page or document to include.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ requestId: string }>(
        `/api/staff/tax/returns/${returnId}/signature-request`,
        {
          method: 'POST',
          body: JSON.stringify({ signers, returnPages, templateIds, adHocKeys }),
        },
      );
      onCreated(r.requestId);
    } catch (e) {
      const code = e instanceof Error ? e.message : 'failed';
      setError(
        code.includes('empty_package')
          ? 'Select at least one page or document.'
          : code.includes('no_signers')
            ? 'Add at least one signer.'
            : code.includes('not_found')
              ? 'This return could not be found.'
              : `Could not create the request: ${code}`,
      );
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="collect-sig-title"
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
        <h2 id="collect-sig-title" style={{ margin: 0, fontSize: 18 }}>
          Collect signatures
        </h2>

        {loadErr ? (
          <p style={{ fontSize: 13, color: tokens.color.danger, marginTop: tokens.space.md }}>
            Could not detect signature pages: {loadErr}
          </p>
        ) : !detect ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: tokens.space.md }}>
            Detecting signature pages…
          </p>
        ) : (
          <div style={{ marginTop: tokens.space.md, display: 'grid', gap: 16 }}>
            {/* Detected signature pages */}
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                Detected signature pages
              </div>
              {detect.pages.length === 0 ? (
                <>
                  <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 8 }}>
                    No signature pages detected from bookmarks
                    {detect.noRulesConfigured && (
                      <>
                        {' — '}
                        configure rules in Admin → Signatures
                      </>
                    )}
                    {detect.noSource && <> — the return has no source PDF</>}.
                    {(detect.allBookmarks?.length ?? 0) > 0
                      ? ' Pick the signature page(s) from the bookmark list below, or proceed with documents.'
                      : ' You can still proceed with documents below.'}
                  </div>
                  {(detect.allBookmarks?.length ?? 0) > 0 &&
                    renderBookmarkList(detect.allBookmarks)}
                </>
              ) : (
                <>
                  <div
                    style={{
                      border: `1px solid ${tokens.color.border}`,
                      borderRadius: tokens.radius.sm,
                      padding: 8,
                      maxHeight: 180,
                      overflowY: 'auto',
                    }}
                  >
                    {detect.pages.map((p) => (
                      <label
                        key={p.pageNumber}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '4px 0',
                          fontSize: 13,
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checkedPages.has(p.pageNumber)}
                          onChange={() => togglePage(p.pageNumber)}
                        />
                        <span style={{ flex: 1 }}>
                          p.{p.pageNumber} — {p.bookmarkTitle}
                        </span>
                      </label>
                    ))}
                  </div>
                  {/* Optional: add pages the rules missed, from the full bookmark list. */}
                  {(() => {
                    const detectedPageSet = new Set(detect.pages.map((p) => p.pageNumber));
                    const extra = (detect.allBookmarks ?? []).filter(
                      (b) => !detectedPageSet.has(b.pageNumber),
                    );
                    if (extra.length === 0) return null;
                    return (
                      <div style={{ marginTop: 8 }}>
                        <button
                          type="button"
                          onClick={() => setShowBookmarks((v) => !v)}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: tokens.color.accent,
                            fontSize: 12,
                            cursor: 'pointer',
                            padding: 0,
                          }}
                        >
                          {showBookmarks ? '▾ Hide bookmarks' : '＋ Add a page from bookmarks'}
                        </button>
                        {showBookmarks && (
                          <div style={{ marginTop: 6 }}>{renderBookmarkList(extra)}</div>
                        )}
                      </div>
                    );
                  })()}
                </>
              )}
            </div>

            {/* Default documents */}
            {detect.templates.length > 0 && (
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                  Default documents
                </div>
                <div
                  style={{
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.sm,
                    padding: 8,
                  }}
                >
                  {detect.templates.map((t) => (
                    <label
                      key={t.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '4px 0',
                        fontSize: 13,
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checkedTemplates.has(t.id)}
                        onChange={() => toggleTemplate(t.id)}
                      />
                      <span style={{ flex: 1 }}>{t.name}</span>
                      <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                        {t.totalPages}pp
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Filing status (1040 only) */}
            {is1040 && (
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Filing status</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button
                    size="sm"
                    variant={filingStatus === 'single' ? 'primary' : 'secondary'}
                    onClick={() => setFilingStatus('single')}
                  >
                    Single
                  </Button>
                  <Button
                    size="sm"
                    variant={filingStatus === 'mfj' ? 'primary' : 'secondary'}
                    onClick={() => setFilingStatus('mfj')}
                  >
                    Married filing jointly
                  </Button>
                </div>
                <p style={{ fontSize: 11, color: tokens.color.textMuted, margin: '6px 0 0' }}>
                  {filingStatus === 'mfj'
                    ? 'Taxpayer + Spouse signer slots.'
                    : 'One Taxpayer signer slot.'}
                </p>
              </div>
            )}

            {/* Signers */}
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Signers</div>
              {people.length === 0 ? (
                <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
                  No people found on this client.
                </div>
              ) : (
                <div
                  style={{
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.sm,
                    maxHeight: 200,
                    overflowY: 'auto',
                  }}
                >
                  {people.map((p) => {
                    const noEmail = !p.email;
                    const sel = pickedKeys.has(p.key);
                    const role = picked.find((s) => s.person.key === p.key)?.role;
                    return (
                      <div
                        key={p.key}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '6px 10px',
                          fontSize: 13,
                          borderBottom: `1px solid ${tokens.color.border}`,
                        }}
                      >
                        <label
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            flex: 1,
                            opacity: noEmail ? 0.5 : 1,
                            cursor: noEmail ? 'not-allowed' : 'pointer',
                          }}
                        >
                          <input
                            type="checkbox"
                            disabled={noEmail}
                            checked={sel}
                            onChange={(e) => togglePerson(p, e.target.checked)}
                          />
                          <span style={{ flex: 1 }}>
                            {p.name}
                            {p.email ? (
                              <span style={{ color: tokens.color.textMuted }}> · {p.email}</span>
                            ) : (
                              <span style={{ color: tokens.color.danger }}>
                                {' '}
                                · no email on file
                              </span>
                            )}
                          </span>
                          <Pill>{p.hint}</Pill>
                        </label>
                        {sel && (
                          <div style={{ width: 130 }}>
                            <Combobox
                              options={ROLE_OPTIONS.map((o) => ({
                                value: o.value,
                                label: o.label,
                              }))}
                              value={role ?? 'taxpayer'}
                              onChange={(v) => setRole(p.key, v as SignerRole)}
                              ariaLabel={`Role for ${p.name}`}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Add document */}
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                Add document (optional)
              </div>
              <input
                type="file"
                accept="application/pdf"
                disabled={uploading}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadAdHoc(f);
                  e.target.value = '';
                }}
                style={{ fontSize: 13 }}
              />
              <p style={{ fontSize: 11, color: tokens.color.textMuted, margin: '6px 0 0' }}>
                {uploading
                  ? 'Uploading…'
                  : adHocKeys.length > 0
                    ? `${adHocKeys.length} document${adHocKeys.length === 1 ? '' : 's'} attached.`
                    : 'Attach a one-off PDF to include in the package.'}
              </p>
            </div>

            {error && (
              <p style={{ fontSize: 12, color: tokens.color.danger, margin: 0 }}>{error}</p>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={() => void submit()} disabled={busy}>
                {busy ? 'Creating…' : 'Create & review'}
              </Button>
            </div>
          </div>
        )}
      </div>
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

interface EngagementOption {
  id: string;
  name: string;
  clientId: string;
}
interface JurisdictionOption {
  id: string;
  name: string;
  active: boolean;
}
interface PaymentTypeOption {
  id: string;
  jurisdictionId: string;
  name: string;
  paymentUrl: string | null;
  active: boolean;
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
  const [busy, setBusy] = useState(false);

  // Composer state — mirrors the client Billing-tab "Schedule tax
  // payment" form (catalog-driven dropdowns + optional engagement/notes),
  // but stays scoped to this return (sends taxReturnId).
  const [showCreate, setShowCreate] = useState(false);
  const [engagements, setEngagements] = useState<EngagementOption[]>([]);
  const [jurisdictions, setJurisdictions] = useState<JurisdictionOption[]>([]);
  const [paymentTypes, setPaymentTypes] = useState<PaymentTypeOption[]>([]);
  const [createEngagementId, setCreateEngagementId] = useState('');
  const [createJurisdictionId, setCreateJurisdictionId] = useState('');
  const [createPaymentTypeId, setCreatePaymentTypeId] = useState('');
  const [createTaxYear, setCreateTaxYear] = useState<number | ''>(taxYear);
  const [createAmount, setCreateAmount] = useState('');
  const [createDueDate, setCreateDueDate] = useState('');
  const [createNotes, setCreateNotes] = useState('');

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

  function resetComposer(): void {
    setShowCreate(false);
    setCreateEngagementId('');
    setCreateJurisdictionId('');
    setCreatePaymentTypeId('');
    setCreateTaxYear(taxYear);
    setCreateAmount('');
    setCreateDueDate('');
    setCreateNotes('');
  }

  async function openCreate(): Promise<void> {
    setError(null);
    setShowCreate(true);
    if (engagements.length === 0) {
      try {
        const r = await api<{ items: EngagementOption[] }>(
          `/api/staff/engagements?clientId=${encodeURIComponent(clientId)}`,
        );
        setEngagements(r.items ?? []);
      } catch {
        // Engagement select stays empty; tax payments can still be saved without one.
      }
    }
    // Load the firm's jurisdiction + payment-type catalog. The type
    // dropdown is filtered to the picked jurisdiction at render time.
    try {
      const [j, t] = await Promise.all([
        api<{ items: JurisdictionOption[] }>('/api/staff/admin/tax-jurisdictions'),
        api<{ items: PaymentTypeOption[] }>('/api/staff/admin/tax-payment-types'),
      ]);
      const activeJur = (j.items ?? []).filter((x) => x.active);
      setJurisdictions(activeJur);
      setPaymentTypes((t.items ?? []).filter((x) => x.active));
      // Pre-select the catalog jurisdiction matching the return's, if any.
      const match = activeJur.find(
        (x) => x.name.toLowerCase() === jurisdiction.trim().toLowerCase(),
      );
      if (match) setCreateJurisdictionId(match.id);
    } catch {
      // Catalog empty → the form will tell the user to configure it.
    }
  }

  async function performCreate(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    const juris = jurisdictions.find((j) => j.id === createJurisdictionId);
    const type = paymentTypes.find((t) => t.id === createPaymentTypeId);
    if (!juris || !type || !createDueDate) return;
    const amountCents = dollarsInputToCents(createAmount);
    if (amountCents == null || amountCents < 0) {
      setError('Amount must be a non-negative number.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Send the resolved names (so historical rows survive catalog
      // deletes) + the URL snapshot. Stays linked to this return via
      // taxReturnId.
      const body: Record<string, unknown> = {
        clientId,
        taxReturnId: returnId,
        jurisdiction: juris.name,
        paymentType: type.name,
        amountCents,
        dueDate: createDueDate,
      };
      if (type.paymentUrl) body['paymentUrl'] = type.paymentUrl;
      if (createEngagementId) body['engagementId'] = createEngagementId;
      if (createTaxYear !== '') body['taxYear'] = Number(createTaxYear);
      if (createNotes) body['notes'] = createNotes;
      await api('/api/staff/tax-payments', { method: 'POST', body: JSON.stringify(body) });
      resetComposer();
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
    <Card
      title={`Tax payments (${rows.length})`}
      action={
        <Button
          size="sm"
          variant={showCreate ? 'ghost' : 'secondary'}
          onClick={() => {
            if (showCreate) resetComposer();
            else void openCreate();
          }}
        >
          {showCreate ? 'Cancel' : '+ Schedule tax payment'}
        </Button>
      }
    >
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 0 }} role="alert">
          {error}
        </p>
      )}
      {showCreate && (
        <form
          onSubmit={(e) => void performCreate(e)}
          style={{
            display: 'grid',
            gap: 10,
            padding: 12,
            marginBottom: 14,
            background: tokens.color.surface,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.sm,
          }}
        >
          <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
            Schedules a tax obligation linked to this return. The client sees it on the portal home
            page with the due date. Notes stay firm-internal.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <LabeledSelect
              label="Jurisdiction *"
              value={createJurisdictionId}
              onChange={(v) => {
                setCreateJurisdictionId(v);
                setCreatePaymentTypeId('');
              }}
              options={[
                { value: '', label: 'Select…' },
                ...jurisdictions.map((j) => ({ value: j.id, label: j.name })),
              ]}
            />
            <LabeledSelect
              label="Payment type *"
              value={createPaymentTypeId}
              onChange={setCreatePaymentTypeId}
              disabled={!createJurisdictionId}
              options={[
                {
                  value: '',
                  label: createJurisdictionId ? 'Select…' : 'Pick a jurisdiction first',
                },
                ...paymentTypes
                  .filter((t) => t.jurisdictionId === createJurisdictionId)
                  .map((t) => ({
                    value: t.id,
                    label: t.paymentUrl ? `${t.name} (online)` : t.name,
                  })),
              ]}
            />
            <LabeledSelect
              label="Engagement (optional)"
              value={createEngagementId}
              onChange={setCreateEngagementId}
              options={[
                { value: '', label: '— None —' },
                ...engagements.map((en) => ({ value: en.id, label: en.name })),
              ]}
            />
            <Input
              label="Tax year"
              type="number"
              value={createTaxYear === '' ? '' : String(createTaxYear)}
              onChange={(e) =>
                setCreateTaxYear(e.target.value === '' ? '' : Number(e.target.value))
              }
              placeholder={`${taxYear}`}
            />
            <Input
              label="Amount (USD) *"
              value={createAmount}
              onChange={(e) => setCreateAmount(e.target.value)}
              placeholder="2500.00"
              required
            />
            <Input
              label="Due date *"
              type="date"
              value={createDueDate}
              onChange={(e) => setCreateDueDate(e.target.value)}
              required
            />
          </div>
          {(() => {
            const t = paymentTypes.find((x) => x.id === createPaymentTypeId);
            if (!t?.paymentUrl) return null;
            return (
              <p style={{ fontSize: 11, color: tokens.color.textMuted, margin: 0 }}>
                Client portal link:{' '}
                <a href={t.paymentUrl} target="_blank" rel="noopener noreferrer">
                  {t.paymentUrl}
                </a>
              </p>
            );
          })()}
          {jurisdictions.length === 0 && (
            <p style={{ fontSize: 12, color: tokens.color.warning, margin: 0 }}>
              No jurisdictions configured yet — set them up in{' '}
              <strong>Admin → Catalog → Tax payments</strong>.
            </p>
          )}
          <Input
            label="Internal notes (not shown to client)"
            value={createNotes}
            onChange={(e) => setCreateNotes(e.target.value)}
            placeholder="Optional"
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? 'Scheduling…' : 'Schedule'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={resetComposer}>
              Cancel
            </Button>
          </div>
        </form>
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

// Labeled <select> — mirrors the client Billing-tab Tax Payments composer
// so the two add-payment forms look identical.
function LabeledSelect({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  disabled?: boolean;
}): JSX.Element {
  const id = `select-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <label htmlFor={id} style={{ fontSize: 11, color: tokens.color.textMuted }}>
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{
          padding: '10px 12px',
          fontSize: 14,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.md,
          background: tokens.color.surface,
          color: disabled ? tokens.color.textMuted : tokens.color.text,
          fontFamily: tokens.font.body,
          boxSizing: 'border-box',
          width: '100%',
          opacity: disabled ? 0.7 : 1,
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
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
