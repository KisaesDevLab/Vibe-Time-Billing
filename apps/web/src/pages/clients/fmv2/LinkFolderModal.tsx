// SPDX-License-Identifier: Elastic-2.0
//
// FMv2 — link-folder modal (mockup 2).
//
// On open, calls POST /api/staff/clients/:id/folder/match. Debounced
// search re-runs as /folder/match/search. Link button POSTs /folder/
// link → 201 = success (close + transition to indexing state),
// 409 = conflict alert with action buttons.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { tokens } from '@vibe/ui';

import { api, type ApiError } from '../../../api-client';
import { CandidateCard, type MatchCandidate } from './CandidateCard';
import { SuggestionChips } from './SuggestionChips';

interface MatchResponse {
  candidates: MatchCandidate[];
  unbound_count: number;
  suggested_queries: string[];
}

interface ConflictError {
  code: 'folder_already_bound';
  bound_to?: { client_id: string; client_name: string };
  attempt_id?: string;
  admin_url?: string;
}

interface Props {
  clientId: string;
  clientName: string;
  taxSoftwareId?: string | null;
  canReconcile: boolean;
  onClose: () => void;
  onLinked: (clientFolderId: string, storagePath: string) => void;
}

export function LinkFolderModal({
  clientId,
  clientName,
  taxSoftwareId,
  canReconcile,
  onClose,
  onLinked,
}: Props): JSX.Element {
  const [data, setData] = useState<MatchResponse | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictError | null>(null);
  const [error, setError] = useState<string | null>(null);
  const debounce = useRef<number | null>(null);

  const fetchMatch = useCallback(
    async (q: string) => {
      setLoading(true);
      setError(null);
      try {
        const url = q
          ? `/api/staff/clients/${clientId}/folder/match/search`
          : `/api/staff/clients/${clientId}/folder/match`;
        const body = q ? { query: q } : undefined;
        const res = await api<MatchResponse>(url, {
          method: 'POST',
          body: body ? JSON.stringify(body) : undefined,
        });
        setData(res);
      } catch (err) {
        const apiErr = err as ApiError;
        setError(`Failed to load matches: ${apiErr.message}`);
      } finally {
        setLoading(false);
      }
    },
    [clientId],
  );

  useEffect(() => {
    void fetchMatch('');
  }, [fetchMatch]);

  useEffect(() => {
    if (debounce.current) window.clearTimeout(debounce.current);
    if (query.trim() === '') return;
    debounce.current = window.setTimeout(() => {
      void fetchMatch(query.trim());
    }, 300);
    return () => {
      if (debounce.current) window.clearTimeout(debounce.current);
    };
  }, [query, fetchMatch]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  async function link(storagePath: string): Promise<void> {
    setBusyPath(storagePath);
    setConflict(null);
    setError(null);
    try {
      const res = await api<{ client_folder_id: string; storage_path: string }>(
        `/api/staff/clients/${clientId}/folder/link`,
        {
          method: 'POST',
          body: JSON.stringify({ storage_path: storagePath }),
        },
      );
      onLinked(res.client_folder_id, res.storage_path);
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.status === 409 && apiErr.body && typeof apiErr.body === 'object') {
        const b = apiErr.body as ConflictError;
        if (b.code === 'folder_already_bound') {
          setConflict(b);
          return;
        }
      }
      setError(apiErr.message);
    } finally {
      setBusyPath(null);
    }
  }

  const bestPath = useMemo(() => {
    if (!data) return null;
    const first = data.candidates.find((c) => c.status === 'unbound');
    return first?.storage_path ?? null;
  }, [data]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Link client to folder"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 60,
      }}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
        }}
      />
      <div
        style={{
          background: tokens.color.surface,
          borderRadius: tokens.radius.md,
          padding: 20,
          minWidth: 600,
          maxWidth: 760,
          maxHeight: '85vh',
          overflow: 'auto',
          boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
          position: 'relative',
          zIndex: 1,
        }}
      >
        <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>Link to a storage folder</h3>
        <div style={{ fontSize: 13, color: tokens.color.textMuted, marginBottom: 12 }}>
          {clientName}
          {taxSoftwareId ? ` · UltraTax ID ${taxSoftwareId}` : null}
        </div>

        {data && (
          <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 8 }}>
            {data.unbound_count} unbound folder{data.unbound_count === 1 ? '' : 's'} in the firm
            bucket.
          </div>
        )}

        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search folders…"
          style={{
            width: '100%',
            padding: 8,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.sm,
            fontSize: 14,
            marginBottom: 8,
          }}
        />

        {data && data.suggested_queries.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <SuggestionChips queries={data.suggested_queries.slice(0, 6)} onPick={setQuery} />
          </div>
        )}

        {conflict && (
          <div
            role="alert"
            style={{
              marginBottom: 12,
              padding: 10,
              background: 'rgba(255, 170, 0, 0.1)',
              border: `1px solid ${tokens.color.warning}`,
              borderRadius: tokens.radius.sm,
              fontSize: 13,
            }}
          >
            <div style={{ marginBottom: 6 }}>
              This folder is already bound to{' '}
              <strong>{conflict.bound_to?.client_name ?? 'another client'}</strong>.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={() => setConflict(null)}
                style={{
                  padding: '4px 10px',
                  fontSize: 12,
                  background: 'transparent',
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  cursor: 'pointer',
                }}
              >
                Pick a different folder
              </button>
              {canReconcile && conflict.admin_url && (
                <a
                  href={conflict.admin_url}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    padding: '4px 10px',
                    fontSize: 12,
                    background: tokens.color.accent,
                    color: 'white',
                    borderRadius: tokens.radius.sm,
                    textDecoration: 'none',
                  }}
                >
                  Open in admin
                </a>
              )}
            </div>
          </div>
        )}

        {error && (
          <div
            style={{
              marginBottom: 12,
              padding: 10,
              background: 'rgba(220, 38, 38, 0.1)',
              border: `1px solid ${tokens.color.danger}`,
              borderRadius: tokens.radius.sm,
              fontSize: 13,
              color: tokens.color.danger,
            }}
          >
            {error}
          </div>
        )}

        {loading && (
          <div style={{ fontSize: 13, color: tokens.color.textMuted, padding: 20 }}>
            Loading candidates…
          </div>
        )}

        {!loading && data && (
          <div style={{ display: 'grid', gap: 8 }}>
            {data.candidates.length === 0 ? (
              <div style={{ fontSize: 13, color: tokens.color.textMuted, padding: 12 }}>
                No matches. Try a different search, or create a new folder below.
              </div>
            ) : (
              data.candidates.map((c) => (
                <CandidateCard
                  key={c.storage_path}
                  candidate={c}
                  isBest={c.storage_path === bestPath}
                  canReconcile={canReconcile}
                  onLink={() => void link(c.storage_path)}
                  busy={busyPath === c.storage_path}
                />
              ))
            )}
          </div>
        )}

        <div
          style={{
            marginTop: 16,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingTop: 12,
            borderTop: `1px solid ${tokens.color.border}`,
          }}
        >
          <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
            Requires <code>storage:folder:bind</code> permission.
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '6px 12px',
              background: 'transparent',
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
