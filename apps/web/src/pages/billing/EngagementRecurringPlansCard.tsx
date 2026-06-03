// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Per-engagement Recurring billing plans card. Lists plans scoped to
// this engagement and exposes a "+ New plan" button that opens the
// shared composer prefilled with the engagement id.
//
// Lives on EngagementDetail under the Letter generator + Messages
// cards. The admin/recurring-plans page surfaces the same plans but
// across every engagement; this card is the contextual entry point
// when staff are already looking at a specific engagement.

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { Button, Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { formatCents } from '../../lib/money';

import { RecurringPlanComposer } from './RecurringPlanComposer';

interface PlanRow {
  id: string;
  engagementName: string;
  clientName: string;
  frequency: string;
  amountCents: number;
  nextRunDate: string;
  status: 'ACTIVE' | 'PAUSED' | 'CANCELLED';
  autoPayFlag: boolean;
}

interface Props {
  engagementId: string;
  engagementName: string;
}

export function EngagementRecurringPlansCard({ engagementId, engagementName }: Props): JSX.Element {
  const [plans, setPlans] = useState<PlanRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCompose, setShowCompose] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: PlanRow[] }>(
        `/api/staff/recurring-plans?engagementId=${engagementId}`,
      );
      setPlans(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load_failed');
      setPlans([]);
    }
  }, [engagementId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      {showCompose && (
        <RecurringPlanComposer
          engagementId={engagementId}
          engagementOptions={[{ id: engagementId, name: engagementName }]}
          onCreated={() => {
            setShowCompose(false);
            void load();
          }}
          onCancel={() => setShowCompose(false)}
        />
      )}
      <Card
        title="Recurring billing plans"
        action={
          <Button
            size="sm"
            variant={showCompose ? 'ghost' : 'secondary'}
            onClick={() => setShowCompose((v) => !v)}
          >
            {showCompose ? 'Cancel' : '+ New plan'}
          </Button>
        }
      >
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
            {error}
          </p>
        )}
        {plans == null ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>
        ) : plans.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
            No recurring plans on this engagement. Click <strong>+ New plan</strong> to bill the
            client on a schedule (monthly bookkeeping, quarterly advisory, etc.). The recurring
            billing worker generates invoices automatically on each cycle.
          </p>
        ) : (
          <Table<PlanRow>
            columns={[
              {
                key: 'freq',
                header: 'Frequency',
                render: (p) => <Pill>{p.frequency}</Pill>,
              },
              {
                key: 'amount',
                header: 'Amount',
                align: 'right',
                render: (p) => formatCents(p.amountCents),
              },
              { key: 'next', header: 'Next run', render: (p) => p.nextRunDate },
              {
                key: 'status',
                header: 'Status',
                render: (p) => (
                  <Pill
                    tone={
                      p.status === 'ACTIVE'
                        ? 'success'
                        : p.status === 'PAUSED'
                          ? 'warning'
                          : 'neutral'
                    }
                  >
                    {p.status}
                  </Pill>
                ),
              },
              {
                key: 'autopay',
                header: 'Autopay',
                render: (p) => (p.autoPayFlag ? <Pill tone="success">on</Pill> : <Pill>off</Pill>),
              },
              {
                key: 'manage',
                header: '',
                align: 'right',
                render: () => (
                  <Link
                    to="/admin/recurring-plans"
                    style={{
                      fontSize: 12,
                      color: tokens.color.accent,
                      textDecoration: 'none',
                    }}
                  >
                    Manage →
                  </Link>
                ),
              },
            ]}
            rows={plans}
            rowKey={(p) => p.id}
            empty=""
          />
        )}
      </Card>
    </>
  );
}
