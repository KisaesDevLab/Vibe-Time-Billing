// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState } from 'react';

import { Card, Pill, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { useAuth } from '../auth-context';

interface Blocker {
  invoiceId: string;
  invoiceNumber: string;
  dueDate: string | null;
  balanceCents: number;
  daysOverdue: number;
}

const formatCents = (c: number): string => `$${(c / 100).toLocaleString()}`;

export function HomePage(): JSX.Element {
  const { me } = useAuth();
  const [blockers, setBlockers] = useState<Blocker[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ unlocked: boolean; blockers: Blocker[] }>(
          '/api/portal/profile/pay-to-unlock',
        );
        setBlockers(r.blockers ?? []);
      } catch {
        // ignore — endpoint may be off in dev
      }
    })();
  }, []);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 700, margin: '0 auto' }}>
      {blockers.length > 0 && (
        <Card
          title="Action required"
          action={
            <Pill tone="danger">
              {blockers.length} blocker{blockers.length === 1 ? '' : 's'}
            </Pill>
          }
        >
          <p style={{ fontSize: 13, marginTop: 0, color: tokens.color.text }}>
            The following invoices are over 30 days past due. Pay them to unlock all portal
            features.
          </p>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {blockers.map((b) => (
              <li
                key={b.invoiceId}
                style={{
                  fontSize: 13,
                  padding: 10,
                  borderTop: `1px solid ${tokens.color.border}`,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span>
                  <a href={`/invoices/${b.invoiceId}`} style={{ color: tokens.color.accent }}>
                    Invoice {b.invoiceNumber}
                  </a>{' '}
                  · {b.daysOverdue}d overdue · {b.dueDate ?? '—'}
                </span>
                <strong>{formatCents(b.balanceCents)}</strong>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card title="Welcome" action={<Pill tone="success">portal</Pill>}>
        <p style={{ fontSize: 14, color: tokens.color.textMuted }}>
          Signed in as identity{' '}
          <code style={{ color: tokens.color.text }}>{me?.portalIdentityId}</code>. Active client{' '}
          <code style={{ color: tokens.color.text }}>{me?.activeClientId}</code>.
        </p>
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
          Open invoices, statement history, and payment methods are listed on the left. Use the
          entity switcher in the header to change which client you&apos;re viewing.
        </p>
      </Card>
    </div>
  );
}
