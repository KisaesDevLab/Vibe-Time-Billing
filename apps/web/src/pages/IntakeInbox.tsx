// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Staff Intake Inbox. Lists received submissions, shows decrypted details +
// files, and disposes a session into a client's File Manager folder (with
// auto-match suggestions). Also hosts "Send a link".

import { useCallback, useEffect, useState } from 'react';

import { Button, tokens } from '@vibe/ui';

import { api, type ApiError } from '../api-client';
import { SendIntakeLinkDialog } from './intake/SendIntakeLinkDialog';

interface SessionListItem {
  id: string;
  status: string;
  createdAt: string;
  readAt: string | null;
  clientName: string | null;
  clientEmail: string | null;
  message: string | null;
  targetStaffName: string;
  fileCount: number;
}

// Server error codes → messages a human can act on.
const ERROR_TEXT: Record<string, string> = {
  move_failed: 'Filing failed — the file(s) could not be copied into the client folder.',
  folder_provision_failed: 'Could not create a storage folder for this client.',
  no_files: 'No clean files to file — files may still be scanning.',
  storage_unavailable: 'File storage is not reachable right now.',
  appliance_locked: 'The appliance is locked — unlock it under Admin before filing.',
};
function friendly(err: ApiError): string {
  return ERROR_TEXT[err.message] ?? err.message;
}

interface FileItem {
  id: string;
  filename: string | null;
  mimeType: string | null;
  byteSize: number;
  kind: string;
  scanStatus: string;
}

interface Suggestion {
  clientId: string;
  clientName: string;
  score: number;
  reasons: string[];
}

interface Detail {
  session: SessionListItem & { clientPhone: string | null; source: string };
  files: FileItem[];
  suggestions: Suggestion[];
}

interface ClientOpt {
  id: string;
  name: string;
}

export function IntakeInboxPage(): JSX.Element {
  const [list, setList] = useState<SessionListItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientQuery, setClientQuery] = useState('');
  const [clientOpts, setClientOpts] = useState<ClientOpt[]>([]);
  const [chosenClient, setChosenClient] = useState<ClientOpt | null>(null);
  const [showLink, setShowLink] = useState(false);

  const loadList = useCallback(async () => {
    try {
      const r = await api<{ sessions: SessionListItem[] }>(
        '/api/staff/intake/sessions?status=received',
      );
      setList(r.sessions);
    } catch (err) {
      setError((err as ApiError).message);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const openSession = useCallback(async (id: string) => {
    setSelected(id);
    setDetail(null);
    setChosenClient(null);
    setError(null);
    try {
      setDetail(await api<Detail>(`/api/staff/intake/sessions/${id}`));
    } catch (err) {
      setError((err as ApiError).message);
    }
  }, []);

  useEffect(() => {
    if (!clientQuery.trim()) {
      setClientOpts([]);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      void api<{ items: ClientOpt[] }>(`/api/staff/clients?q=${encodeURIComponent(clientQuery)}`)
        .then((r) => {
          if (alive) setClientOpts(r.items.slice(0, 8));
        })
        .catch(() => undefined);
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [clientQuery]);

  async function dispose(clientId: string): Promise<void> {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/intake/sessions/${selected}/dispose`, {
        method: 'POST',
        body: JSON.stringify({ clientId, category: 'correspondence' }),
      });
      setDetail(null);
      setSelected(null);
      await loadList();
    } catch (err) {
      setError(friendly(err as ApiError));
    } finally {
      setBusy(false);
    }
  }

  // Toggle the read flag without disposing — updates the list highlight and
  // the nav badge's unread count.
  async function setRead(id: string, read: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/intake/sessions/${id}/read`, {
        method: 'POST',
        body: JSON.stringify({ read }),
      });
      await loadList();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteFile(fileId: string): Promise<void> {
    if (!selected) return;
    if (
      !window.confirm('Delete this file? This removes it from the submission and cannot be undone.')
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/intake/sessions/${selected}/files/${fileId}`, { method: 'DELETE' });
      // Refresh the open submission + the list (file counts).
      await openSession(selected);
      await loadList();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  async function reject(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/intake/sessions/${selected}/reject`, { method: 'POST' });
      setDetail(null);
      setSelected(null);
      await loadList();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Document Intake</h1>
        <Button onClick={() => setShowLink(true)}>Send a link</Button>
      </div>
      {error && (
        <div style={{ color: tokens.color.danger, fontSize: 13, marginTop: 8 }}>{error}</div>
      )}

      <div style={{ display: 'flex', gap: 16, marginTop: 16, alignItems: 'flex-start' }}>
        {/* List */}
        <div style={{ flex: '0 0 320px', display: 'grid', gap: 8 }}>
          {list.length === 0 && (
            <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No new submissions.</p>
          )}
          {list.map((s) => (
            <div
              key={s.id}
              style={{
                padding: 12,
                border: `1px solid ${selected === s.id ? tokens.color.accent : tokens.color.border}`,
                borderRadius: tokens.radius.md,
                background: tokens.color.surface,
                // Read submissions render dimmed so the unread ones pop.
                opacity: s.readAt ? 0.65 : 1,
              }}
            >
              <button
                type="button"
                onClick={() => void openSession(s.id)}
                style={{
                  textAlign: 'left',
                  border: 'none',
                  background: 'transparent',
                  padding: 0,
                  cursor: 'pointer',
                  width: '100%',
                  color: tokens.color.text,
                }}
              >
                <div
                  style={{
                    fontWeight: s.readAt ? 500 : 700,
                    fontSize: 14,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {!s.readAt && (
                    <span
                      aria-label="Unread"
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: tokens.color.accent,
                        display: 'inline-block',
                        flex: '0 0 auto',
                      }}
                    />
                  )}
                  {s.clientName ?? 'Unknown sender'}
                </div>
                <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
                  {s.fileCount} file{s.fileCount === 1 ? '' : 's'} · for {s.targetStaffName}
                </div>
                <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
                  {new Date(s.createdAt).toLocaleString()}
                </div>
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void setRead(s.id, !s.readAt)}
                style={{
                  marginTop: 6,
                  border: 'none',
                  background: 'transparent',
                  color: tokens.color.accent,
                  fontSize: 12,
                  padding: 0,
                  cursor: busy ? 'default' : 'pointer',
                }}
              >
                {s.readAt ? 'Mark unread' : 'Mark read'}
              </button>
            </div>
          ))}
        </div>

        {/* Detail */}
        <div style={{ flex: 1 }}>
          {!detail && (
            <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
              Select a submission to review and file it.
            </p>
          )}
          {detail && (
            <div
              style={{
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                padding: 16,
                display: 'grid',
                gap: 14,
                background: tokens.color.surface,
              }}
            >
              <div>
                <div style={{ fontWeight: 600 }}>
                  {detail.session.clientName ?? 'Unknown sender'}
                </div>
                <div style={{ fontSize: 13, color: tokens.color.textMuted }}>
                  {detail.session.clientEmail} {detail.session.clientPhone}
                </div>
                {detail.session.message && (
                  <p style={{ fontSize: 13, marginTop: 8, whiteSpace: 'pre-wrap' }}>
                    {detail.session.message}
                  </p>
                )}
              </div>

              <div>
                <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
                  Files
                </div>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
                  {detail.files.map((f) => {
                    const base = `/api/staff/intake/sessions/${detail.session.id}/files/${f.id}/download`;
                    return (
                      <li
                        key={f.id}
                        style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}
                      >
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <a href={base} style={{ color: tokens.color.accent }}>
                            {f.filename ?? 'document'}
                          </a>{' '}
                          <span style={{ color: tokens.color.textMuted }}>
                            ({(f.byteSize / 1024).toFixed(0)} KB
                            {f.kind === 'scan' ? ', assembled' : ''})
                          </span>
                        </span>
                        <a
                          href={`${base}?inline=1`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: tokens.color.accent, fontSize: 12 }}
                        >
                          Preview
                        </a>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void deleteFile(f.id)}
                          style={{
                            border: 'none',
                            background: 'transparent',
                            color: tokens.color.danger,
                            fontSize: 12,
                            cursor: busy ? 'default' : 'pointer',
                            padding: 0,
                          }}
                        >
                          Delete
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>

              {/* Disposition */}
              <div style={{ borderTop: `1px solid ${tokens.color.border}`, paddingTop: 12 }}>
                <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 6 }}>
                  File to client
                </div>
                {detail.suggestions.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                    {detail.suggestions.map((s) => (
                      <button
                        key={s.clientId}
                        type="button"
                        disabled={busy}
                        onClick={() => void dispose(s.clientId)}
                        style={{
                          padding: '6px 10px',
                          borderRadius: tokens.radius.pill,
                          border: `1px solid ${tokens.color.accent}`,
                          background: 'transparent',
                          color: tokens.color.accent,
                          fontSize: 13,
                          cursor: 'pointer',
                        }}
                        title={s.reasons.join(', ')}
                      >
                        {s.clientName} ↦
                      </button>
                    ))}
                  </div>
                )}
                <input
                  placeholder="Search clients…"
                  value={chosenClient ? chosenClient.name : clientQuery}
                  onChange={(e) => {
                    setChosenClient(null);
                    setClientQuery(e.target.value);
                  }}
                  style={{
                    width: '100%',
                    padding: 8,
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.sm,
                    fontSize: 14,
                  }}
                />
                {!chosenClient && clientOpts.length > 0 && (
                  <div style={{ display: 'grid', gap: 2, marginTop: 4 }}>
                    {clientOpts.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          setChosenClient(c);
                          setClientOpts([]);
                        }}
                        style={{
                          textAlign: 'left',
                          padding: 6,
                          fontSize: 13,
                          border: 'none',
                          background: 'transparent',
                          cursor: 'pointer',
                          color: tokens.color.text,
                        }}
                      >
                        {c.name}
                      </button>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <Button
                    disabled={!chosenClient || busy}
                    onClick={() => chosenClient && void dispose(chosenClient.id)}
                  >
                    File to {chosenClient ? chosenClient.name : 'client'}
                  </Button>
                  <Button variant="ghost" disabled={busy} onClick={() => void reject()}>
                    Reject
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {showLink && <SendIntakeLinkDialog onClose={() => setShowLink(false)} />}
    </div>
  );
}
