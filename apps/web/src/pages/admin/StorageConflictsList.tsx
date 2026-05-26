// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// FMv2 §6 Phase D — admin conflict list page.

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { Card, Pill, Table, tokens } from '@vibe/ui';

import { api, type ApiError } from '../../api-client';

interface Conflict {
  id: string;
  type: 'link_contested' | 'pending_link';
  storage_path: string;
  bound_to: { client_id: string; client_name: string } | null;
  challenger: { client_id: string; client_name: string };
  attempted_by: { user_id: string; user_name: string };
  attempted_at: string;
  match_confidence: number | null;
}

interface OtherEvent {
  id: string;
  type: string;
  storage_path: string;
  detected_at: string;
}

interface ListResponse {
  conflicts: Conflict[];
  other_events: OtherEvent[];
  counts: {
    contested: number;
    discovered: number;
    missing: number;
    sentinel_lost: number;
    orphan: number;
  };
}

export function StorageConflictsListPage(): JSX.Element {
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await api<ListResponse>('/api/staff/storage/conflicts');
      setData(r);
    } catch (err) {
      setError((err as ApiError).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <Card title="Storage conflicts">
        <p style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</p>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card title="Storage conflicts">
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
      </Card>
    );
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg }}>
      <Card title="Reconciliation queue">
        <div style={{ display: 'flex', gap: tokens.space.lg, flexWrap: 'wrap' }}>
          <CountChip label="Contested" value={data.counts.contested} tone="warning" />
          <CountChip label="Discovered" value={data.counts.discovered} tone="neutral" />
          <CountChip label="Missing" value={data.counts.missing} tone="warning" />
          <CountChip label="Sentinel lost" value={data.counts.sentinel_lost} tone="warning" />
          <CountChip label="Orphan" value={data.counts.orphan} tone="warning" />
        </div>
      </Card>

      <Card title={`Open conflicts (${data.conflicts.length})`}>
        <Table<Conflict>
          columns={[
            {
              key: 'folder',
              header: 'Folder',
              render: (c) => (
                <code style={{ fontFamily: tokens.font.mono, fontSize: 12 }}>{c.storage_path}</code>
              ),
            },
            {
              key: 'bound',
              header: 'Currently bound',
              render: (c) => c.bound_to?.client_name ?? '—',
            },
            {
              key: 'challenger',
              header: 'Challenger',
              render: (c) => <Pill tone="warning">{c.challenger.client_name}</Pill>,
            },
            {
              key: 'by',
              header: 'Attempted by',
              render: (c) => c.attempted_by.user_name,
            },
            {
              key: 'when',
              header: 'When',
              render: (c) => (
                <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                  {new Date(c.attempted_at).toLocaleString()}
                </span>
              ),
            },
            {
              key: 'review',
              header: '',
              align: 'right',
              render: (c) => (
                <Link
                  to={`/admin/storage/conflicts/${c.id}`}
                  style={{ color: tokens.color.accent }}
                >
                  Review →
                </Link>
              ),
            },
          ]}
          rows={data.conflicts}
          rowKey={(c) => c.id}
          empty="No open conflicts. New contested link attempts will appear here for review."
        />
      </Card>

      {data.other_events.length > 0 && (
        <Card title={`Other reconciliation events (${data.other_events.length})`}>
          <Table<OtherEvent>
            columns={[
              {
                key: 'type',
                header: 'Type',
                render: (e) => <Pill tone="neutral">{e.type}</Pill>,
              },
              {
                key: 'folder',
                header: 'Folder',
                render: (e) => (
                  <code style={{ fontFamily: tokens.font.mono, fontSize: 12 }}>
                    {e.storage_path}
                  </code>
                ),
              },
              {
                key: 'detected',
                header: 'Detected',
                render: (e) => (
                  <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                    {new Date(e.detected_at).toLocaleString()}
                  </span>
                ),
              },
            ]}
            rows={data.other_events}
            rowKey={(e) => e.id}
          />
        </Card>
      )}
    </div>
  );
}

function CountChip({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'warning' | 'neutral';
}): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, color: tokens.color.textMuted }}>{label}</span>
      <Pill tone={tone}>{value}</Pill>
    </div>
  );
}
