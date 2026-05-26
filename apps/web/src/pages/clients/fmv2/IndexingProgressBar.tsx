// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// FMv2 — IndexingProgressBar (mockup 3 sub-card).
//
// Subscribes to GET /api/staff/clients/:id/folder/index-status via
// SSE on mount. Falls back to 5s polling when SSE closes
// immediately (no Redis configured or stream rejected).
//
// On `completed` event, calls onCompleted() so the parent
// ClientFilesTab re-loads the file list and removes the indexing
// state.

import { useEffect, useRef, useState } from 'react';

import { Pill, tokens } from '@vibe/ui';

import { api, type ApiError } from '../../../api-client';

export interface IndexProgress {
  status: 'queued' | 'running' | 'completed' | 'failed';
  files_total: number;
  files_indexed: number;
  bytes_indexed: number;
  visible_count: number;
  private_count: number;
  started_at: string;
  estimated_completion?: string | null;
  last_file_name?: string | null;
}

interface SnapshotResponse {
  client_folder_id: string;
  status: string;
  index_channel: string;
  live: IndexProgress | null;
}

interface Props {
  clientId: string;
  onCompleted: () => void;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function IndexingProgressBar({ clientId, onCompleted }: Props): JSX.Element {
  const [progress, setProgress] = useState<IndexProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const completedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    let pollTimer: number | null = null;

    function markCompleted(): void {
      if (completedRef.current) return;
      completedRef.current = true;
      onCompleted();
    }

    async function pollOnce(): Promise<void> {
      try {
        const snap = await api<SnapshotResponse>(
          `/api/staff/clients/${clientId}/folder/index-status`,
        );
        if (cancelled) return;
        if (snap.live) {
          setProgress(snap.live);
          if (snap.live.status === 'completed') markCompleted();
        }
      } catch (err) {
        if (cancelled) return;
        setError((err as ApiError).message);
      }
    }

    function startPolling(): void {
      void pollOnce();
      pollTimer = window.setInterval(() => void pollOnce(), 5000);
    }

    // Try SSE first.
    try {
      es = new EventSource(`/api/staff/clients/${clientId}/folder/index-status?stream=1`);
      let gotAny = false;
      es.addEventListener('progress', (ev) => {
        gotAny = true;
        try {
          const data = JSON.parse((ev as MessageEvent).data) as IndexProgress;
          setProgress(data);
        } catch {
          // ignore malformed
        }
      });
      es.addEventListener('completed', (ev) => {
        gotAny = true;
        try {
          const data = JSON.parse((ev as MessageEvent).data) as IndexProgress;
          setProgress(data);
        } catch {
          // ignore
        }
        markCompleted();
        es?.close();
      });
      es.addEventListener('failed', () => {
        setError('Indexing failed. Check storage worker logs.');
        es?.close();
      });
      es.addEventListener('snapshot', (ev) => {
        // One-shot snapshot when no Redis is wired; switch to polling.
        try {
          const data = JSON.parse((ev as MessageEvent).data) as IndexProgress;
          setProgress(data);
        } catch {
          // ignore
        }
      });
      es.onerror = () => {
        if (cancelled) return;
        // If SSE closes immediately without delivering anything, fall
        // back to polling (e.g. REDIS_URL unset → server emits a
        // single snapshot then closes).
        if (!gotAny) {
          es?.close();
          es = null;
          startPolling();
        }
      };
    } catch {
      // EventSource may not exist in some test environments.
      startPolling();
    }

    return () => {
      cancelled = true;
      if (es) es.close();
      if (pollTimer) window.clearInterval(pollTimer);
    };
  }, [clientId, onCompleted]);

  const pct =
    progress && progress.files_total > 0
      ? Math.min(100, Math.round((progress.files_indexed / progress.files_total) * 100))
      : null;

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          aria-hidden
          style={{
            display: 'inline-block',
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: tokens.color.accent,
            animation: 'fmv2-pulse 1.4s ease-in-out infinite',
          }}
        />
        <Pill tone="accent">Indexing</Pill>
        <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
          {progress ? `${progress.files_indexed} of ${progress.files_total} files` : 'Starting…'}
        </span>
        {progress && pct != null && (
          <span style={{ marginLeft: 'auto', fontSize: 12, color: tokens.color.textMuted }}>
            {pct}%
          </span>
        )}
      </div>

      <div
        style={{
          height: 6,
          background: tokens.color.border,
          borderRadius: 3,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: pct == null ? '8%' : `${pct}%`,
            background: tokens.color.accent,
            transition: 'width 200ms ease-out',
          }}
        />
      </div>

      {progress && (
        <div
          style={{
            display: 'flex',
            gap: 16,
            fontSize: 11,
            color: tokens.color.textMuted,
            flexWrap: 'wrap',
          }}
        >
          <span>{humanBytes(progress.bytes_indexed)} indexed</span>
          <span>{progress.visible_count} visible</span>
          <span>{progress.private_count} private</span>
          {progress.last_file_name && (
            <span
              style={{
                fontStyle: 'italic',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: 320,
              }}
              title={progress.last_file_name}
            >
              Last: {progress.last_file_name}
            </span>
          )}
        </div>
      )}

      {error && <div style={{ fontSize: 12, color: tokens.color.danger }}>{error}</div>}

      <style>{`
        @keyframes fmv2-pulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
