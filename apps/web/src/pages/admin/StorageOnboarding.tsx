// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Storage onboarding (Phase 4 of FILE_MANAGER_ADDENDUM.md).
//
// Three columns:
//   Unmatched folders — top-level paths in B2 with no `client_folders`
//     binding. Each one carries a list of candidate matches (top 3) +
//     a click-to-bind affordance.
//   Match preview — when a folder is selected, shows the candidates +
//     a "Bind" action. Also exposes "Search any client" for the cases
//     where fuzzy matching missed.
//   Unmatched clients — clients in this firm with no `client_folders`
//     row. Acts as the right-hand target list when the admin wants to
//     bind a folder to a specific client.

import { useEffect, useMemo, useState } from 'react';

import { Button, Card, Combobox, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { usePermission } from '../../auth-context';

interface MatchCandidate {
  clientId: string;
  confidence: number;
  reason: 'tax_software_id' | 'normalized_name';
}

interface UnmatchedFolder {
  path: string;
  taxSoftwareIdParsed: string | null;
  candidates: MatchCandidate[];
}

interface BoundFolder {
  path: string;
  clientFolderId: string;
  clientId: string;
  clientName: string;
}

interface ProblemFolder {
  path: string;
  kind: 'orphan' | 'sentinel_changed' | 'conflict';
  detail?: string;
}

interface UnmatchedClient {
  id: string;
  name: string;
  clientFacingName: string | null;
  taxSoftwareId: string | null;
}

interface ScanResult {
  bucketArea: string;
  systemPrefix: string;
  unmatchedFolders: UnmatchedFolder[];
  boundFolders: BoundFolder[];
  problemFolders: ProblemFolder[];
  unmatchedClients: UnmatchedClient[];
}

const AUTO_BIND_THRESHOLD = 0.9;

export function StorageOnboardingPage(): JSX.Element {
  const canView = usePermission('storage:folder:view');
  const canBind = usePermission('storage:folder:bind');
  const bindTooltip = canBind ? undefined : 'You need storage:folder:bind to bind folders';

  const [scan, setScan] = useState<ScanResult | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [manualClientId, setManualClientId] = useState<string>('');

  async function load(): Promise<void> {
    setError(null);
    try {
      const r = await api<ScanResult>('/api/staff/admin/storage/scan');
      setScan(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'scan_failed');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const selectedFolder = useMemo(
    () => scan?.unmatchedFolders.find((f) => f.path === selectedPath) ?? null,
    [scan, selectedPath],
  );

  const clientLookup = useMemo(() => {
    const m = new Map<string, UnmatchedClient>();
    for (const c of scan?.unmatchedClients ?? []) m.set(c.id, c);
    return m;
  }, [scan]);

  async function bind(folderPath: string, clientId: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api('/api/staff/admin/storage/bind', {
        method: 'POST',
        body: JSON.stringify({ folderPath, clientId }),
      });
      setSelectedPath(null);
      setManualClientId('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'bind_failed');
    } finally {
      setBusy(false);
    }
  }

  async function autoBindHighConfidence(): Promise<void> {
    if (!scan) return;
    setBusy(true);
    setError(null);
    const targets = scan.unmatchedFolders
      .map((f) => ({ folder: f, best: f.candidates[0] }))
      .filter(
        (t): t is { folder: UnmatchedFolder; best: MatchCandidate } =>
          !!t.best && t.best.confidence >= AUTO_BIND_THRESHOLD,
      );
    let bound = 0;
    let failed = 0;
    for (const t of targets) {
      try {
        await api('/api/staff/admin/storage/bind', {
          method: 'POST',
          body: JSON.stringify({ folderPath: t.folder.path, clientId: t.best.clientId }),
        });
        bound += 1;
      } catch {
        failed += 1;
      }
    }
    setBusy(false);
    if (failed > 0) setError(`Auto-bind: ${bound} succeeded, ${failed} failed`);
    await load();
  }

  async function unbind(clientFolderId: string): Promise<void> {
    if (!window.confirm('Remove this folder binding? The sentinel file in B2 will be deleted.')) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/api/staff/admin/storage/unbind', {
        method: 'POST',
        body: JSON.stringify({ clientFolderId, deleteSentinel: true }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unbind_failed');
    } finally {
      setBusy(false);
    }
  }

  if (!scan) {
    return (
      <div style={{ padding: tokens.space.lg }}>
        {error ? (
          <p style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</p>
        ) : (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        )}
      </div>
    );
  }

  const autoCandidates = scan.unmatchedFolders.filter(
    (f) => (f.candidates[0]?.confidence ?? 0) >= AUTO_BIND_THRESHOLD,
  );

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1400 }}>
      {error && (
        <Card>
          <p style={{ color: tokens.color.danger, fontSize: 13, margin: 0 }}>{error}</p>
        </Card>
      )}

      <Card title="Storage onboarding">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
            Bucket area: <code>{scan.bucketArea || '/'}</code> · System prefix:{' '}
            <code>{scan.systemPrefix}</code> · {scan.boundFolders.length} bound ·{' '}
            {scan.unmatchedFolders.length} unmatched · {scan.problemFolders.length} problems ·{' '}
            {scan.unmatchedClients.length} clients without folders
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={() => void load()} disabled={busy || !canView}>
              Refresh
            </Button>
            <Button
              onClick={() => void autoBindHighConfidence()}
              disabled={busy || autoCandidates.length === 0 || !canBind}
              title={bindTooltip}
              variant="primary"
            >
              Auto-bind ≥ 90% ({autoCandidates.length})
            </Button>
          </div>
        </div>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: tokens.space.lg }}>
        {/* Column 1 — Unmatched folders */}
        <Card title={`Unmatched folders (${scan.unmatchedFolders.length})`}>
          {scan.unmatchedFolders.length === 0 ? (
            <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
              All discovered folders are bound.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {scan.unmatchedFolders.map((f) => {
                const top = f.candidates[0];
                const isSelected = selectedPath === f.path;
                return (
                  <button
                    key={f.path}
                    type="button"
                    onClick={() => setSelectedPath(f.path)}
                    style={{
                      textAlign: 'left',
                      padding: '8px 10px',
                      borderRadius: tokens.radius.sm,
                      border: `1px solid ${isSelected ? tokens.color.accent : tokens.color.border}`,
                      background: isSelected ? tokens.color.accentMuted : tokens.color.surface,
                      cursor: 'pointer',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <span style={{ fontSize: 13, fontFamily: tokens.font.mono }}>{f.path}</span>
                    {top ? (
                      <Pill tone={top.confidence >= AUTO_BIND_THRESHOLD ? 'success' : 'neutral'}>
                        {Math.round(top.confidence * 100)}%
                      </Pill>
                    ) : (
                      <Pill tone="warning">no match</Pill>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </Card>

        {/* Column 2 — Match preview for selected */}
        <Card title="Match preview">
          {!selectedFolder ? (
            <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
              Select a folder from the left to see candidate matches.
            </p>
          ) : (
            <div style={{ display: 'grid', gap: 12 }}>
              <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
                <code>{selectedFolder.path}</code>
                {selectedFolder.taxSoftwareIdParsed && (
                  <>
                    {' · parsed id: '}
                    <code>{selectedFolder.taxSoftwareIdParsed}</code>
                  </>
                )}
              </div>
              {selectedFolder.candidates.length === 0 ? (
                <p style={{ fontSize: 12, color: tokens.color.textMuted }}>
                  No matches above the threshold. Pick a client manually below.
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {selectedFolder.candidates.map((c) => {
                    const client = clientLookup.get(c.clientId);
                    return (
                      <div
                        key={c.clientId}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: 8,
                          padding: '6px 10px',
                          border: `1px solid ${tokens.color.border}`,
                          borderRadius: tokens.radius.sm,
                        }}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <span style={{ fontSize: 13 }}>{client ? client.name : c.clientId}</span>
                          <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                            {c.reason === 'tax_software_id' ? 'tax software id' : 'name match'} ·{' '}
                            {Math.round(c.confidence * 100)}%
                          </span>
                        </div>
                        <Button
                          onClick={() => void bind(selectedFolder.path, c.clientId)}
                          disabled={busy || !canBind}
                          title={bindTooltip}
                        >
                          Bind
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
              <div
                style={{
                  borderTop: `1px solid ${tokens.color.border}`,
                  paddingTop: 12,
                  display: 'grid',
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                  Or pick any client manually:
                </span>
                <Combobox
                  options={scan.unmatchedClients.map((c) => ({
                    value: c.id,
                    label: c.name + (c.taxSoftwareId ? ` (${c.taxSoftwareId})` : ''),
                  }))}
                  value={manualClientId}
                  onChange={setManualClientId}
                  placeholder="Search clients without folders…"
                />
                <Button
                  disabled={busy || !manualClientId || !canBind}
                  title={bindTooltip}
                  onClick={() => void bind(selectedFolder.path, manualClientId)}
                  variant="primary"
                >
                  Bind to selected client
                </Button>
              </div>
            </div>
          )}
        </Card>

        {/* Column 3 — Unmatched clients */}
        <Card title={`Unmatched clients (${scan.unmatchedClients.length})`}>
          {scan.unmatchedClients.length === 0 ? (
            <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
              Every active client has a folder binding.
            </p>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                maxHeight: 480,
                overflowY: 'auto',
              }}
            >
              {scan.unmatchedClients.map((c) => (
                <div
                  key={c.id}
                  style={{
                    fontSize: 13,
                    padding: '6px 8px',
                    borderBottom: `1px solid ${tokens.color.border}`,
                  }}
                >
                  <div>{c.name}</div>
                  {c.taxSoftwareId && (
                    <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
                      <code>{c.taxSoftwareId}</code>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card title={`Bound folders (${scan.boundFolders.length})`}>
        {scan.boundFolders.length === 0 ? (
          <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>No bindings yet.</p>
        ) : (
          <div style={{ display: 'grid', gap: 4 }}>
            {scan.boundFolders.map((b) => (
              <div
                key={b.clientFolderId}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '6px 8px',
                  borderBottom: `1px solid ${tokens.color.border}`,
                  fontSize: 13,
                }}
              >
                <span style={{ fontFamily: tokens.font.mono }}>{b.path}</span>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ color: tokens.color.textMuted }}>{b.clientName}</span>
                  <Button
                    onClick={() => void unbind(b.clientFolderId)}
                    disabled={busy || !canBind}
                    title={bindTooltip}
                  >
                    Unbind
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {scan.problemFolders.length > 0 && (
        <Card title={`Problems (${scan.problemFolders.length})`}>
          <div style={{ display: 'grid', gap: 4 }}>
            {scan.problemFolders.map((p) => (
              <div
                key={p.path}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '6px 8px',
                  borderBottom: `1px solid ${tokens.color.border}`,
                  fontSize: 13,
                }}
              >
                <span style={{ fontFamily: tokens.font.mono }}>{p.path}</span>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Pill
                    tone={
                      p.kind === 'conflict' ? 'danger' : p.kind === 'orphan' ? 'warning' : 'neutral'
                    }
                  >
                    {p.kind}
                  </Pill>
                  {p.detail && (
                    <span style={{ fontSize: 11, color: tokens.color.textMuted }}>{p.detail}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
