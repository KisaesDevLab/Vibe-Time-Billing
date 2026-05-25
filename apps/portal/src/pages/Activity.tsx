// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CP6 — Portal activity log page. Implements CLIENT_PORTAL_BUILD_PLAN
// §2.14. Chronological feed of who-did-what affecting the active
// client: portal identity's own actions + staff-initiated events on
// the client's invoices, requests, and engagements.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { Card, EmptyState, Pill, SectionHeading, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { useScope } from '../scope-context';

type ActorKind = 'self' | 'staff' | 'system';

interface ActivityRow {
  id: string;
  occurredAt: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorKind: ActorKind;
  actorName: string | null;
}

export function ActivityPage(): JSX.Element {
  const [items, setItems] = useState<ActivityRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { scope, scopeQuery } = useScope();

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: ActivityRow[] }>(`/api/portal/activity${scopeQuery}`);
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
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 800, margin: '0 auto' }}>
      <SectionHeading
        title="Activity"
        description="A record of recent actions on your account — yours and your firm's."
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
          Showing activity from <strong>all clients you can access</strong>.
        </div>
      )}

      <Card>
        {!loaded ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>
        ) : items.length === 0 ? (
          <EmptyState
            icon="📜"
            title="No activity yet"
            body="Once you or your firm makes changes here, they'll appear in this log."
          />
        ) : (
          <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
            {items.map((row) => (
              <ActivityRow key={row.id} row={row} />
            ))}
          </ol>
        )}
      </Card>

      {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
    </div>
  );
}

function ActivityRow({ row }: { row: ActivityRow }): JSX.Element {
  const summary = summarize(row);
  const link = entityLink(row);
  return (
    <li
      style={{
        padding: tokens.space.md,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.sm,
        background: tokens.color.surface,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14 }}>
            {link ? (
              <Link to={link} style={{ color: tokens.color.text }}>
                {summary}
              </Link>
            ) : (
              summary
            )}
          </div>
          <div style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 4 }}>
            {new Date(row.occurredAt).toLocaleString()}
          </div>
        </div>
        <ActorPill kind={row.actorKind} name={row.actorName} />
      </div>
    </li>
  );
}

function ActorPill({ kind, name }: { kind: ActorKind; name: string | null }): JSX.Element {
  if (kind === 'self') return <Pill tone="accent">you</Pill>;
  if (kind === 'staff') return <Pill tone="neutral">{name ?? 'your firm'}</Pill>;
  return <Pill tone="neutral">system</Pill>;
}

function summarize(row: ActivityRow): string {
  const verb = ACTION_VERB[row.action] ?? row.action.toLowerCase();
  const noun = ENTITY_NOUN[row.entityType] ?? row.entityType.replace(/_/g, ' ');
  return `${capitalize(verb)} ${noun}`;
}

function entityLink(row: ActivityRow): string | null {
  if (!row.entityId) return null;
  switch (row.entityType) {
    case 'invoice':
      return `/invoices/${row.entityId}`;
    case 'engagement':
      return `/engagements`;
    case 'client_request':
      return `/requests`;
    case 'file':
      return `/files`;
    default:
      return null;
  }
}

const ACTION_VERB: Record<string, string> = {
  CREATE: 'created',
  UPDATE: 'updated',
  DELETE: 'deleted',
  ARCHIVE: 'archived',
  VIEW: 'viewed',
  DOWNLOAD: 'downloaded',
  PAY: 'paid',
  SIGN: 'signed',
};

const ENTITY_NOUN: Record<string, string> = {
  invoice: 'an invoice',
  payment: 'a payment',
  payment_method: 'a payment method',
  file: 'a file',
  client_request: 'a request',
  engagement: 'an engagement',
  portal_session: 'a session',
  portal_alt_contact: 'an alternate contact',
  client_portal_access: 'portal access',
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
