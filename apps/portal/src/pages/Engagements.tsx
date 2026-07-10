// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CP4 — Client portal engagement status board (Build Plan §2.5).
//
// Read-only view of active + paused engagements for the active client.
// One card per engagement: name, period, partner, status pill, progress
// bar (when milestones present), next milestone, last activity, and an
// "awaiting from you: N" badge when there are open client requests.

import { useEffect, useState } from 'react';

import { Card, EmptyState, Pill, SectionHeading, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { useScope } from '../scope-context';

type StatusPill = 'in_progress' | 'awaiting_client' | 'scheduled' | 'filed' | 'blocked' | 'paused';

interface NextMilestone {
  id: string;
  name: string;
  dueDate: string | null;
}

interface ActiveEngagement {
  id: string;
  clientId?: string;
  name: string;
  partnerName: string | null;
  startDate: string | null;
  endDate: string | null;
  dueDate: string | null;
  lastActivity: string;
  statusPill: StatusPill;
  // 0101 — firm-defined client-facing text; overrides the derived pill label
  // when set, falls back to STATUS_LABEL[statusPill] otherwise.
  clientLabel?: string | null;
  clientDescription?: string | null;
  progressPct: number | null;
  nextMilestone: NextMilestone | null;
  awaitingFromYou: number;
}

const STATUS_LABEL: Record<StatusPill, string> = {
  in_progress: 'In progress',
  awaiting_client: 'Awaiting you',
  scheduled: 'Scheduled',
  filed: 'Filed',
  blocked: 'Blocked',
  paused: 'Paused',
};

const STATUS_TONE: Record<StatusPill, 'success' | 'warning' | 'danger' | 'accent' | 'neutral'> = {
  in_progress: 'success',
  awaiting_client: 'warning',
  scheduled: 'neutral',
  filed: 'neutral',
  blocked: 'danger',
  paused: 'accent',
};

export function EngagementsPage(): JSX.Element {
  const [items, setItems] = useState<ActiveEngagement[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { scope, scopeQuery, clientNames } = useScope();

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: ActiveEngagement[] }>(
          `/api/portal/engagements/active${scopeQuery}`,
        );
        setItems(r.items ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed to load');
      } finally {
        setLoaded(true);
      }
    })();
  }, [scopeQuery]);

  const consolidated = scope === 'all_accessible';

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 900, margin: '0 auto' }}>
      <SectionHeading
        title="Your engagements"
        description="Active engagements with your firm and where each one stands today."
      />
      {consolidated && (
        <div
          style={{
            padding: '8px 12px',
            background: tokens.color.accentMuted,
            borderRadius: tokens.radius.sm,
            fontSize: 12,
            color: tokens.color.accent,
          }}
        >
          Showing engagements from <strong>all clients you can access</strong>.
        </div>
      )}

      {!loaded ? (
        <Card>
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            icon="📋"
            title="No active engagements"
            body="When your firm starts work on your behalf, the engagement will appear here with status updates."
          />
        </Card>
      ) : (
        <div style={{ display: 'grid', gap: tokens.space.md }}>
          {items.map((e) => (
            <EngagementCard
              key={e.id}
              engagement={e}
              clientName={consolidated && e.clientId ? clientNames[e.clientId] : undefined}
            />
          ))}
        </div>
      )}

      {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
    </div>
  );
}

export function EngagementCard({
  engagement,
  clientName,
}: {
  engagement: ActiveEngagement;
  clientName?: string;
}): JSX.Element {
  const period = formatPeriod(engagement.startDate, engagement.endDate, engagement.dueDate);
  return (
    <Card>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 16,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{engagement.name}</div>
          <div style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 4 }}>
            {clientName && (
              <>
                <strong style={{ color: tokens.color.text }}>{clientName}</strong>
                {' · '}
              </>
            )}
            {period}
            {engagement.partnerName && ` · ${engagement.partnerName}`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
          {engagement.awaitingFromYou > 0 && (
            <Pill tone="warning">{engagement.awaitingFromYou} awaiting you</Pill>
          )}
          <Pill tone={STATUS_TONE[engagement.statusPill]}>
            {engagement.clientLabel ?? STATUS_LABEL[engagement.statusPill]}
          </Pill>
        </div>
      </div>

      {engagement.clientDescription && (
        <div style={{ marginTop: 8, fontSize: 12, color: tokens.color.textMuted }}>
          {engagement.clientDescription}
        </div>
      )}

      {engagement.progressPct != null && (
        <div style={{ marginTop: 12 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 11,
              color: tokens.color.textMuted,
              marginBottom: 4,
            }}
          >
            <span>Progress</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{engagement.progressPct}%</span>
          </div>
          <div
            style={{
              width: '100%',
              height: 6,
              background: tokens.color.surface,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: 3,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${engagement.progressPct}%`,
                height: '100%',
                background: tokens.color.success,
              }}
            />
          </div>
        </div>
      )}

      {engagement.nextMilestone && (
        <div
          style={{
            marginTop: 12,
            padding: tokens.space.sm,
            background: tokens.color.surface,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.sm,
            fontSize: 12,
          }}
        >
          <span style={{ color: tokens.color.textMuted }}>Next milestone: </span>
          <strong>{engagement.nextMilestone.name}</strong>
          {engagement.nextMilestone.dueDate && (
            <span style={{ color: tokens.color.textMuted }}>
              {' '}
              · due {engagement.nextMilestone.dueDate}
            </span>
          )}
        </div>
      )}

      <div style={{ marginTop: 8, fontSize: 11, color: tokens.color.textMuted }}>
        Last activity {new Date(engagement.lastActivity).toLocaleDateString()}
      </div>
    </Card>
  );
}

function formatPeriod(
  startDate: string | null,
  endDate: string | null,
  dueDate: string | null,
): string {
  if (startDate && endDate) return `${startDate} → ${endDate}`;
  if (startDate && dueDate) return `Started ${startDate} · due ${dueDate}`;
  if (dueDate) return `Due ${dueDate}`;
  if (startDate) return `Started ${startDate}`;
  return 'Ongoing';
}
