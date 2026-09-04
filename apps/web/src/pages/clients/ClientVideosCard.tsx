// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Client-level roll-up of engagement videos (0235). Read-only: upload and
// management happen on the engagement page, which each title links to.

import { useEffect, useState } from 'react';

import { Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { formatAvailableUntil, videoStatusPill } from '../../lib/video-upload';
import type { StaffVideoRow } from '../engagements/EngagementVideosCard';

export function ClientVideosCard({ clientId }: { clientId: string }): JSX.Element {
  const [rows, setRows] = useState<StaffVideoRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: StaffVideoRow[] }>(`/api/staff/clients/${clientId}/videos`);
        setRows(r.items ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'load_failed');
        setRows([]);
      }
    })();
  }, [clientId]);

  return (
    <Card title="Videos">
      <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
        Every video shared with this client across their engagements. Upload and manage videos from
        the engagement page.
      </p>
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }}>{error}</p>
      )}
      {rows == null ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>
      ) : (
        <Table<StaffVideoRow>
          rows={rows}
          rowKey={(r) => r.id}
          empty="No videos shared with this client yet."
          columns={[
            {
              key: 'title',
              header: 'Video',
              mobile: 'title',
              render: (r) => <a href={`/engagements/${r.engagementId}`}>{r.title}</a>,
            },
            {
              key: 'engagement',
              header: 'Engagement',
              mobile: 'meta',
              render: (r) => r.engagementName ?? '—',
            },
            {
              key: 'status',
              header: 'Status',
              mobile: 'badge',
              render: (r) => {
                const p = videoStatusPill(r);
                return <Pill tone={p.tone}>{p.label}</Pill>;
              },
            },
            {
              key: 'plays',
              header: 'Plays',
              mobile: 'field',
              mobileLabel: 'Plays',
              render: (r) => (r.playCount === 0 ? '—' : String(r.playCount)),
            },
            {
              key: 'uploaded',
              header: 'Uploaded',
              mobile: 'field',
              mobileLabel: 'Uploaded',
              render: (r) => new Date(r.uploadedAt).toLocaleDateString(),
            },
            {
              key: 'expires',
              header: 'Available',
              mobile: 'field',
              mobileLabel: 'Available',
              render: (r) => (r.status === 'AVAILABLE' ? formatAvailableUntil(r.expiresAt) : '—'),
            },
          ]}
        />
      )}
    </Card>
  );
}
