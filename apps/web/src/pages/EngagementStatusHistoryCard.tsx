// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Per-engagement progress-status change history: who moved it from one
// status to another, and when. Reads the already-logged audit trail via
// GET /api/staff/engagements/:id/status-history.

import { useEffect, useState } from 'react';

import { Card, Pill, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface StatusHistoryRow {
  occurredAt: string;
  actorName: string | null;
  fromKey: string | null;
  fromLabel: string | null;
  toKey: string | null;
  toLabel: string | null;
}

export function EngagementStatusHistoryCard({
  engagementId,
}: {
  engagementId: string;
}): JSX.Element {
  const [items, setItems] = useState<StatusHistoryRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: StatusHistoryRow[] }>(
          `/api/staff/engagements/${engagementId}/status-history`,
        );
        setItems(r.items ?? []);
      } catch {
        setItems([]);
      } finally {
        setLoaded(true);
      }
    })();
  }, [engagementId]);

  return (
    <Card title="Status history">
      {!loaded ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>
      ) : items.length === 0 ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
          No status changes recorded yet.
        </p>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {items.map((r, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
                flexWrap: 'wrap',
              }}
            >
              <span style={{ color: tokens.color.textMuted, minWidth: 130 }}>
                {new Date(r.occurredAt).toLocaleString()}
              </span>
              <strong>{r.actorName ?? 'System'}</strong>
              <span style={{ color: tokens.color.textMuted }}>moved</span>
              <Pill tone="neutral">{r.fromLabel ?? r.fromKey ?? '—'}</Pill>
              <span style={{ color: tokens.color.textMuted }}>→</span>
              <Pill tone="success">{r.toLabel ?? r.toKey ?? '—'}</Pill>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
