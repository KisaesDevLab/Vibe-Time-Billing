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

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Button, Card, Input, Pill, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface SectionRow {
  id: string;
  ordinal: number;
  depth: number;
  parentSectionId: string | null;
  title: string;
  kind: string;
  startPage: number;
  endPage: number;
  recipientName: string | null;
}

interface ReleaseRow {
  id: string;
  releasedToClientId: string;
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
  };
  sections: SectionRow[];
  releases: ReleaseRow[];
}

export function TaxReturnDetailPage(): JSX.Element {
  const { returnId } = useParams<{ returnId: string }>();
  const [data, setData] = useState<ReturnDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [releaseOpen, setReleaseOpen] = useState(false);

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
        <div style={{ marginTop: tokens.space.md }}>
          <Button onClick={() => setReleaseOpen(true)}>Release to client</Button>
        </div>
      </Card>

      <Card title={`Sections (${sections.length})`}>
        {sections.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
            No sections parsed for this return yet.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {sections.map((s) => (
              <li
                key={s.id}
                style={{
                  paddingLeft: Math.max(0, s.depth - 1) * 14,
                  borderBottom: `1px solid ${tokens.color.border}`,
                  padding: '6px 0',
                  fontSize: 13,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>{s.title}</span>
                  <span style={{ color: tokens.color.textMuted, fontSize: 12 }}>
                    pp {s.startPage}–{s.endPage} · {s.kind}
                  </span>
                </div>
                {s.recipientName && (
                  <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
                    Recipient: {s.recipientName}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

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
                    Released to <code>{r.releasedToClientId.slice(0, 8)}…</code>
                  </div>
                  <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
                    {r.scope === 'FULL'
                      ? 'Full return'
                      : `${r.sectionIds.length} section${r.sectionIds.length === 1 ? '' : 's'}`}
                    {r.clientCanDownload ? ' · download enabled' : ' · view only'}
                    {' · '}
                    {new Date(r.releasedAt).toLocaleDateString()}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => void revoke(r.id)}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

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
    </div>
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
