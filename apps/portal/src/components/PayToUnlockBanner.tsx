// SPDX-License-Identifier: Elastic-2.0
//
// Pay-to-unlock client-side gate (Phase 13 #24, 14 #13, 16 #20).
//
// Hook + banner that surface unpaid invoices the firm has gated for
// document download. Server enforces the gate on the actual render
// endpoints (402 pay_to_unlock_locked); this UI gives clients the
// 'why is this disabled?' explanation + a direct path to pay.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { Card, Pill, tokens } from '@vibe/ui';

import { api } from '../api-client';

export interface PayToUnlockBlocker {
  invoiceId: string;
  invoiceNumber: string;
  dueDate: string | null;
  balanceCents: number;
  daysOverdue: number;
  gatingKind: 'EXPLICIT' | 'OVERDUE';
}

export interface UnlockStatus {
  unlocked: boolean;
  blockers: PayToUnlockBlocker[];
  loaded: boolean;
}

export function useUnlockStatus(): UnlockStatus {
  const [state, setState] = useState<UnlockStatus>({ unlocked: true, blockers: [], loaded: false });
  useEffect(() => {
    let cancelled = false;
    void api<Omit<UnlockStatus, 'loaded'>>('/api/portal/profile/pay-to-unlock')
      .then((r) => {
        if (cancelled) return;
        setState({ ...r, loaded: true });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ unlocked: true, blockers: [], loaded: true });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

const formatCents = (c: number): string =>
  `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function PayToUnlockBanner(): JSX.Element | null {
  const status = useUnlockStatus();
  if (!status.loaded || status.unlocked || status.blockers.length === 0) return null;
  const total = status.blockers.reduce((s, b) => s + b.balanceCents, 0);
  const explicit = status.blockers.filter((b) => b.gatingKind === 'EXPLICIT');
  return (
    <Card
      title="Documents locked — payment required"
      action={<Pill tone="danger">{formatCents(total)} due</Pill>}
    >
      <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: '0 0 12px' }}>
        {explicit.length > 0
          ? `The firm has gated document downloads on ${explicit.length} unpaid invoice${
              explicit.length === 1 ? '' : 's'
            }. Settle the balance${explicit.length === 1 ? '' : 's'} below to unlock.`
          : `One or more invoices are more than 30 days overdue.`}
      </p>
      <div style={{ display: 'grid', gap: 8 }}>
        {status.blockers.map((b) => (
          <div
            key={b.invoiceId}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 12px',
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
              fontSize: 13,
            }}
          >
            <div>
              <Link
                to={`/invoices/${b.invoiceId}`}
                style={{ color: tokens.color.accent, fontWeight: 500 }}
              >
                Invoice {b.invoiceNumber}
              </Link>
              <span style={{ color: tokens.color.textMuted, marginLeft: 8 }}>
                {b.gatingKind === 'EXPLICIT'
                  ? 'Document access gated by firm'
                  : `${b.daysOverdue} days overdue`}
              </span>
            </div>
            <strong>{formatCents(b.balanceCents)}</strong>
          </div>
        ))}
      </div>
    </Card>
  );
}
