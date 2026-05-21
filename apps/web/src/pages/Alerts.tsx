// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState } from 'react';

import { Button, Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface AlertRow {
  id: string;
  occurredAt: string;
  entityType: 'audit_anomaly_alert' | 'scope_creep_alert' | 'wip_age_alert' | 'engagement_rollover';
  entityId: string | null;
  afterJson: Record<string, unknown> | null;
}

function summarize(r: AlertRow): string {
  const j = r.afterJson ?? {};
  switch (r.entityType) {
    case 'audit_anomaly_alert':
      return `Actor ${String(j['actorKind'])} ${String(j['actorId']).slice(0, 8)}… exceeded ${j['threshold']}/h (saw ${j['eventsLastHour']})`;
    case 'scope_creep_alert':
      return `${Number(j['creepPct'] ?? 0).toFixed(1)}% out-of-scope hours over ${j['windowDays']}d`;
    case 'wip_age_alert':
      return `Oldest unbilled entry ${j['oldestEntryDate']}; ${j['unbilledHours']}h / $${
        Number(j['unbilledAmountCents'] ?? 0) / 100
      } at risk`;
    case 'engagement_rollover':
      return `Engagement ending ${j['endDate']} — auto-rollover candidate`;
  }
}

function toneOf(kind: AlertRow['entityType']): 'accent' | 'warning' | 'danger' {
  switch (kind) {
    case 'audit_anomaly_alert':
      return 'danger';
    case 'wip_age_alert':
      return 'warning';
    case 'scope_creep_alert':
      return 'warning';
    case 'engagement_rollover':
      return 'accent';
  }
}

export function AlertsPage(): JSX.Element {
  const [items, setItems] = useState<AlertRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: AlertRow[] }>('/api/staff/audit/alerts');
        setItems(r.items ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed');
      }
    })();
  }, []);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1200 }}>
      <SummarizeButton alerts={items} />
      <Card title="Inbox · worker alerts">
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
          Surfaces the recent alert events emitted by the background workers (audit anomalies, scope
          creep, aged WIP, engagement rollovers). Read-only; alerts are immutable in the audit log.
        </p>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
        <Table<AlertRow>
          columns={[
            {
              key: 'when',
              header: 'When',
              render: (r) => new Date(r.occurredAt).toLocaleString(),
            },
            {
              key: 'kind',
              header: 'Kind',
              render: (r) => (
                <Pill tone={toneOf(r.entityType)}>{r.entityType.replace(/_/g, ' ')}</Pill>
              ),
            },
            {
              key: 'entity',
              header: 'Subject',
              render: (r) =>
                r.entityId ? <code style={{ fontSize: 11 }}>{r.entityId.slice(0, 8)}…</code> : '—',
            },
            {
              key: 'summary',
              header: 'Summary',
              render: (r) => summarize(r),
            },
          ]}
          rows={items}
          rowKey={(r) => r.id}
          empty="No alerts. Quiet day."
        />
      </Card>
    </div>
  );
}

function SummarizeButton({ alerts }: { alerts: AlertRow[] }): JSX.Element {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function ask(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ narrative: string }>('/api/staff/ai/anomaly-summary', {
        method: 'POST',
        body: JSON.stringify({
          alerts: alerts.map((a) => ({ entityType: a.entityType })),
        }),
      });
      setText(r.narrative);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }
  if (alerts.length === 0) return <></>;
  return (
    <Card title="AI summary">
      <Button size="sm" variant="secondary" onClick={() => void ask()} disabled={busy}>
        {busy ? 'Asking AI…' : '✨ Summarize these alerts'}
      </Button>
      {text && (
        <p
          style={{
            marginTop: 12,
            fontSize: 13,
            color: tokens.color.text,
            background: tokens.color.surface,
            padding: 12,
            borderRadius: tokens.radius.sm,
            whiteSpace: 'pre-wrap',
          }}
        >
          {text}
        </p>
      )}
      {err && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{err}</p>}
    </Card>
  );
}
