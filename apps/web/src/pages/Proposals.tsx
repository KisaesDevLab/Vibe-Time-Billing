// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// PP4a — Proposals list page (top-level /proposals route).
//
// Lists every proposal for the firm with status, client, totals, last
// touch. Filter chips by status; "New proposal" button kicks off the
// create flow.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { Button, Card, Combobox, Pill, SectionHeading, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

type Status =
  | 'DRAFT'
  | 'SENT'
  | 'VIEWED'
  | 'IN_PROGRESS'
  | 'ACCEPTED'
  | 'DECLINED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'COUNTERED';

interface ProposalRow {
  id: string;
  clientId: string;
  clientName: string | null;
  status: Status;
  title: string;
  totalOneTimeCents: number;
  totalRecurringCents: number;
  recurringInterval: string | null;
  sentAt: string | null;
  expiresAt: string | null;
  acceptedAt: string | null;
  draftRevision: number;
  createdAt: string;
  updatedAt: string;
}

function dollars(c: number): string {
  return (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

const STATUS_TONE: Record<Status, 'accent' | 'success' | 'warning' | 'danger' | 'neutral'> = {
  DRAFT: 'neutral',
  SENT: 'accent',
  VIEWED: 'accent',
  IN_PROGRESS: 'warning',
  ACCEPTED: 'success',
  DECLINED: 'danger',
  EXPIRED: 'warning',
  CANCELLED: 'neutral',
  COUNTERED: 'warning',
};

export function ProposalsListPage(): JSX.Element {
  const [items, setItems] = useState<ProposalRow[]>([]);
  const [filterStatus, setFilterStatus] = useState<Status | ''>('');
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load(): Promise<void> {
    const params = new URLSearchParams();
    if (filterStatus) params.set('status', filterStatus);
    const qs = params.toString();
    const r = await api<{ items: ProposalRow[] }>(`/api/staff/proposals${qs ? `?${qs}` : ''}`);
    setItems(r.items ?? []);
    setLoaded(true);
  }

  useEffect(() => {
    void load().catch((e) => setErr(e instanceof Error ? e.message : 'load_failed'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterStatus]);

  const counts = useMemo(() => {
    const c: Partial<Record<Status, number>> = {};
    for (const i of items) c[i.status] = (c[i.status] ?? 0) + 1;
    return c;
  }, [items]);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1200 }}>
      <SectionHeading
        title="Proposals"
        description="Draft, send, and track engagement proposals."
      />
      <Card>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ width: 200 }}>
            <Combobox
              ariaLabel="Status filter"
              value={filterStatus}
              onChange={(v) => setFilterStatus((v as Status | '') ?? '')}
              options={[
                { value: '', label: `All (${items.length})` },
                ...(
                  [
                    'DRAFT',
                    'SENT',
                    'VIEWED',
                    'IN_PROGRESS',
                    'ACCEPTED',
                    'DECLINED',
                    'EXPIRED',
                    'CANCELLED',
                    'COUNTERED',
                  ] as Status[]
                ).map((s) => ({ value: s, label: `${s} (${counts[s] ?? 0})` })),
              ]}
            />
          </div>
          <div style={{ flex: 1 }} />
          <Link to="/proposals/new" style={{ textDecoration: 'none' }}>
            <Button size="sm">New proposal</Button>
          </Link>
        </div>
        {err && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{err}</p>}
      </Card>

      <Card>
        {!loaded ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>
        ) : items.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
            No proposals yet. Click “New proposal” to start the first one.
          </p>
        ) : (
          <Table<ProposalRow>
            columns={[
              {
                key: 'title',
                header: 'Title',
                render: (r) => (
                  <Link
                    to={`/proposals/${r.id}/edit`}
                    style={{ color: tokens.color.accent, textDecoration: 'none' }}
                  >
                    {r.title}
                  </Link>
                ),
              },
              {
                key: 'client',
                header: 'Client',
                render: (r) => r.clientName ?? '—',
              },
              {
                key: 'status',
                header: 'Status',
                render: (r) => <Pill tone={STATUS_TONE[r.status]}>{r.status}</Pill>,
              },
              {
                key: 'fee',
                header: 'Fees',
                align: 'right',
                render: (r) => (
                  <div style={{ fontSize: 12 }}>
                    {Number(r.totalOneTimeCents) > 0 && (
                      <div>{dollars(Number(r.totalOneTimeCents))} one-time</div>
                    )}
                    {Number(r.totalRecurringCents) > 0 && (
                      <div style={{ color: tokens.color.textMuted }}>
                        {dollars(Number(r.totalRecurringCents))} / {r.recurringInterval}
                      </div>
                    )}
                    {Number(r.totalOneTimeCents) === 0 && Number(r.totalRecurringCents) === 0 && (
                      <span style={{ color: tokens.color.textMuted }}>—</span>
                    )}
                  </div>
                ),
              },
              {
                key: 'rev',
                header: 'Rev',
                align: 'right',
                render: (r) => `v${r.draftRevision}`,
              },
              {
                key: 'touched',
                header: 'Last update',
                render: (r) => new Date(r.updatedAt).toLocaleString(),
              },
            ]}
            rows={items}
            rowKey={(r) => r.id}
          />
        )}
      </Card>
    </div>
  );
}
