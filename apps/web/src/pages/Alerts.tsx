// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { useEffect, useMemo, useState } from 'react';

import { Button, Card, ColumnFilter, Pill, Table, tokens, type SortDir } from '@vibe/ui';

import { api } from '../api-client';
import { TableSearch } from '../components/TableSearch';
import { selectRows, useColumnView } from '../lib/column-view';
import { useClientPage } from '../lib/use-paged-list';

interface AlertRow {
  id: string;
  occurredAt: string;
  entityType: 'audit_anomaly_alert' | 'scope_creep_alert' | 'wip_age_alert' | 'engagement_rollover';
  entityId: string | null;
  afterJson: Record<string, unknown> | null;
}

const KIND_VALUES = [
  { value: 'audit_anomaly_alert', label: 'audit anomaly alert' },
  { value: 'scope_creep_alert', label: 'scope creep alert' },
  { value: 'wip_age_alert', label: 'wip age alert' },
  { value: 'engagement_rollover', label: 'engagement rollover' },
];

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
  const [detail, setDetail] = useState<AlertRow | null>(null);

  const view = useColumnView('vibe.alerts.view', { sortCol: 'when', sortDir: 'desc' });

  const visible = useMemo(
    () =>
      selectRows(items, view, {
        filters: { kind: (r) => r.entityType },
        sortValues: {
          when: (r) => r.occurredAt,
          kind: (r) => r.entityType,
        },
        searchText: (r) => `${r.entityType} ${r.entityId ?? ''}`,
      }),
    [items, view],
  );

  const { paged, pagination } = useClientPage(visible);

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

  async function dismiss(id: string): Promise<void> {
    // Optimistically drop the row; a dismissed alert leaves the inbox and the
    // dashboard "Alerts" callout (both read the same endpoint).
    setItems((prev) => prev.filter((a) => a.id !== id));
    setDetail((d) => (d?.id === id ? null : d));
    try {
      await api(`/api/staff/audit/alerts/${id}/dismiss`, { method: 'POST' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to dismiss');
    }
  }

  async function dismissAll(): Promise<void> {
    // Optimistically clear the inbox; restore the prior list on failure.
    const prev = items;
    setItems([]);
    setDetail(null);
    try {
      await api('/api/staff/audit/alerts/dismiss-all', { method: 'POST' });
    } catch (err) {
      setItems(prev);
      setError(err instanceof Error ? err.message : 'failed to dismiss all');
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1200 }}>
      <SummarizeButton alerts={items} />
      <Card
        title="Inbox · worker alerts"
        action={
          items.length > 0 ? (
            <Button size="sm" variant="secondary" onClick={() => void dismissAll()}>
              Dismiss all
            </Button>
          ) : undefined
        }
      >
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
          Surfaces the recent alert events emitted by the background workers (audit anomalies, scope
          creep, aged WIP, engagement rollovers). Read-only; alerts are immutable in the audit log.
        </p>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
        <div style={{ marginBottom: 12 }}>
          <TableSearch view={view} placeholder="Search alerts…" />
        </div>
        {view.anyFilterActive && (
          <div style={{ marginBottom: 8 }}>
            <button
              type="button"
              onClick={view.clearFilters}
              style={{
                background: 'none',
                border: 'none',
                color: tokens.color.accent,
                fontSize: 12,
                cursor: 'pointer',
                padding: 0,
              }}
            >
              Clear filters
            </button>
          </div>
        )}
        <Table<AlertRow>
          columns={[
            {
              key: 'when',
              header: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  When{' '}
                  <ColumnFilter
                    ariaLabel="Sort by when"
                    values={[]}
                    selected={new Set()}
                    searchable={false}
                    sort={view.sortFor('when')}
                    onApply={(_, dir) => view.apply('when', new Set(), dir as SortDir)}
                  />
                </span>
              ) as unknown as string,
              render: (r) => new Date(r.occurredAt).toLocaleString(),
            },
            {
              key: 'kind',
              header: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  Kind{' '}
                  <ColumnFilter
                    ariaLabel="Filter / sort kind"
                    values={KIND_VALUES}
                    selected={view.filterFor('kind')}
                    sort={view.sortFor('kind')}
                    searchable={false}
                    onApply={(sel, dir) => view.apply('kind', sel, dir)}
                  />
                </span>
              ) as unknown as string,
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
            {
              key: 'actions',
              header: '',
              render: (r) => (
                <span style={{ display: 'inline-flex', gap: 6 }}>
                  <Button size="sm" variant="secondary" onClick={() => setDetail(r)}>
                    Details
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void dismiss(r.id)}>
                    Dismiss
                  </Button>
                </span>
              ),
            },
          ]}
          rows={paged}
          pagination={pagination}
          rowKey={(r) => r.id}
          empty="No alerts. Quiet day."
        />
      </Card>
      {detail && <AlertDetailModal alert={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function AlertDetailModal({
  alert,
  onClose,
}: {
  alert: AlertRow;
  onClose: () => void;
}): JSX.Element {
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 16,
      }}
    >
      <button
        type="button"
        aria-label="Close details"
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0,0,0,0.45)',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
        }}
      />
      <div
        style={{
          position: 'relative',
          background: tokens.color.surface,
          color: tokens.color.text,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.lg,
          padding: tokens.space.lg,
          maxWidth: 640,
          width: '100%',
          maxHeight: '80vh',
          overflow: 'auto',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 12,
          }}
        >
          <Pill tone={toneOf(alert.entityType)}>{alert.entityType.replace(/_/g, ' ')}</Pill>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
        <div style={{ fontSize: 13, marginBottom: 8 }}>{summarize(alert)}</div>
        <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
          {new Date(alert.occurredAt).toLocaleString()}
        </div>
        {alert.entityId && (
          <div style={{ fontSize: 12, marginBottom: 12 }}>
            Subject id: <code style={{ fontSize: 11 }}>{alert.entityId}</code>
          </div>
        )}
        <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
          Full detail
        </div>
        <pre
          style={{
            fontSize: 11,
            fontFamily: tokens.font.mono,
            padding: 12,
            borderRadius: tokens.radius.sm,
            border: `1px solid ${tokens.color.border}`,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            margin: 0,
          }}
        >
          {JSON.stringify(alert.afterJson ?? {}, null, 2)}
        </pre>
      </div>
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
