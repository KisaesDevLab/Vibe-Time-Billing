// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Per-viewer play log for one engagement video.

import { useEffect, useState } from 'react';

import { Modal, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { progressPct } from '../../lib/video-upload';

interface PlayRow {
  id: string;
  viewerName: string | null;
  viewerEmail: string | null;
  startedAt: string;
  lastHeartbeatAt: string;
  furthestSeconds: number;
  durationSeconds: number | null;
  progressPct: number | null;
  completed: boolean;
  deviceKind: string | null;
}

function fmtSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

export function VideoPlaysModal({
  videoId,
  title,
  onClose,
}: {
  videoId: string;
  title: string;
  onClose: () => void;
}): JSX.Element {
  const [rows, setRows] = useState<PlayRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: PlayRow[] }>(`/api/staff/videos/${videoId}/plays`);
        setRows(r.items ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'load_failed');
        setRows([]);
      }
    })();
  }, [videoId]);

  return (
    <Modal title={`Plays — ${title}`} onClose={onClose} maxWidth={720}>
      {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
      {rows == null ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
      ) : (
        <Table<PlayRow>
          rows={rows}
          rowKey={(r) => r.id}
          empty="Not played yet."
          columns={[
            {
              key: 'viewer',
              header: 'Viewer',
              mobile: 'title',
              render: (r) => (
                <span>
                  {r.viewerName ?? 'Portal user'}
                  {r.viewerEmail && (
                    <span style={{ color: tokens.color.textMuted, fontSize: 12 }}>
                      {' '}
                      · {r.viewerEmail}
                    </span>
                  )}
                </span>
              ),
            },
            {
              key: 'when',
              header: 'Started',
              mobile: 'meta',
              render: (r) => new Date(r.startedAt).toLocaleString(),
            },
            {
              key: 'progress',
              header: 'Watched',
              mobile: 'field',
              mobileLabel: 'Watched',
              render: (r) => {
                const pct = r.completed
                  ? 100
                  : (r.progressPct ?? progressPct(r.furthestSeconds, r.durationSeconds));
                return pct == null
                  ? fmtSeconds(r.furthestSeconds)
                  : `${pct}% (${fmtSeconds(r.furthestSeconds)}${r.durationSeconds ? ` / ${fmtSeconds(r.durationSeconds)}` : ''})`;
              },
            },
            {
              key: 'done',
              header: 'Finished',
              mobile: 'badge',
              render: (r) =>
                r.completed ? <Pill tone="success">Yes</Pill> : <Pill tone="neutral">No</Pill>,
            },
            {
              key: 'device',
              header: 'Device',
              mobile: 'meta',
              render: (r) => r.deviceKind ?? '—',
            },
          ]}
        />
      )}
    </Modal>
  );
}
