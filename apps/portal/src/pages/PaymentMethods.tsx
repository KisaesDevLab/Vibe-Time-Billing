// SPDX-License-Identifier: Elastic-2.0
import { useEffect, useState } from 'react';

import { Button, Card, Pill, SectionHeading, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface PaymentMethodRow {
  id: string;
  kind: string;
  provider: string;
  lastFour: string | null;
  displayLabel: string | null;
  brand: string | null;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
  status: string;
}

interface AutopayEnrollment {
  id: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED';
  autopayMethodId: string | null;
  autopayPausedUntil: string | null;
}

interface AutopayPaymentMethod {
  id: string;
  kind: string;
  brand: string | null;
  last4: string | null;
  isDefault: boolean;
}

export function PaymentMethodsPage(): JSX.Element {
  const [items, setItems] = useState<PaymentMethodRow[]>([]);
  const [enrollments, setEnrollments] = useState<AutopayEnrollment[]>([]);
  const [autopayMethods, setAutopayMethods] = useState<AutopayPaymentMethod[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const [pm, ea] = await Promise.all([
        api<{ items: PaymentMethodRow[] }>('/api/portal/profile/payment-methods'),
        api<{ items: AutopayEnrollment[]; paymentMethods: AutopayPaymentMethod[] }>(
          '/api/portal/engagement-autopay',
        ),
      ]);
      setItems(pm.items ?? []);
      setEnrollments(ea.items ?? []);
      setAutopayMethods(ea.paymentMethods ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function enrollEngagement(engagementId: string, paymentMethodId: string): Promise<void> {
    setError(null);
    setStatus(null);
    try {
      await api(`/api/portal/engagement-autopay/${engagementId}`, {
        method: 'POST',
        body: JSON.stringify({ paymentMethodId }),
      });
      setStatus('Autopay updated.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function unenrollEngagement(engagementId: string): Promise<void> {
    setError(null);
    setStatus(null);
    try {
      await api(`/api/portal/engagement-autopay/${engagementId}`, { method: 'DELETE' });
      setStatus('Autopay disabled for this engagement.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  function methodLabel(m: AutopayPaymentMethod): string {
    return `${m.brand ?? m.kind}${m.last4 ? ` ····${m.last4}` : ''}`;
  }

  async function setAutopay(id: string): Promise<void> {
    setError(null);
    setStatus(null);
    try {
      await api(`/api/portal/profile/payment-methods/${id}/set-autopay`, { method: 'POST' });
      setStatus('Autopay updated.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function remove(id: string): Promise<void> {
    if (!window.confirm('Remove this payment method?')) return;
    setError(null);
    try {
      await api(`/api/portal/profile/payment-methods/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 900 }}>
      <Card title="Saved payment methods">
        {status && (
          <p style={{ color: tokens.color.success, fontSize: 12, marginBottom: 8 }}>{status}</p>
        )}
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }}>{error}</p>
        )}
        <Table<PaymentMethodRow>
          columns={[
            {
              key: 'label',
              header: 'Method',
              render: (p) => (
                <span>
                  {p.brand ?? p.kind}
                  {p.lastFour ? ` ····${p.lastFour}` : ''}
                  {p.displayLabel ? ` (${p.displayLabel})` : ''}
                </span>
              ),
            },
            {
              key: 'exp',
              header: 'Expires',
              render: (p) =>
                p.expMonth && p.expYear
                  ? `${String(p.expMonth).padStart(2, '0')}/${p.expYear}`
                  : '—',
            },
            {
              key: 'default',
              header: 'Autopay',
              render: (p) => (p.isDefault ? <Pill tone="success">default</Pill> : null),
            },
            {
              key: 'actions',
              header: '',
              render: (p) => (
                <span style={{ display: 'flex', gap: 6 }}>
                  {!p.isDefault && (
                    <Button size="sm" variant="secondary" onClick={() => void setAutopay(p.id)}>
                      Use for autopay
                    </Button>
                  )}
                  <Button size="sm" variant="secondary" onClick={() => void remove(p.id)}>
                    Remove
                  </Button>
                </span>
              ),
            },
          ]}
          rows={items}
          rowKey={(p) => p.id}
          empty="No saved payment methods. Pay an invoice to save one."
        />
      </Card>

      {autopayMethods.length > 0 && enrollments.length > 0 && (
        <Card title="Autopay enrollment">
          <SectionHeading
            eyebrow="Per engagement"
            title="Which engagements should pay automatically?"
            description="Pick a saved payment method per engagement. The recurring-billing run will charge that card the moment an invoice is created. Leave 'Off' to keep manually paying."
          />
          <Table<AutopayEnrollment>
            columns={[
              {
                key: 'name',
                header: 'Engagement',
                render: (e) => (
                  <span>
                    {e.name}
                    {e.status === 'PAUSED' && (
                      <span style={{ marginLeft: 6 }}>
                        <Pill tone="accent">paused</Pill>
                      </span>
                    )}
                  </span>
                ),
              },
              {
                key: 'enrollment',
                header: 'Autopay with',
                render: (e) => (
                  <select
                    value={e.autopayMethodId ?? ''}
                    onChange={(ev) => {
                      const next = ev.target.value;
                      if (next === '') {
                        void unenrollEngagement(e.id);
                      } else {
                        void enrollEngagement(e.id, next);
                      }
                    }}
                    style={{
                      padding: '6px 8px',
                      fontSize: 13,
                      border: `1px solid ${tokens.color.border}`,
                      borderRadius: tokens.radius.sm,
                      background: tokens.color.surface,
                      color: tokens.color.text,
                      minWidth: 220,
                    }}
                  >
                    <option value="">Off (manual pay)</option>
                    {autopayMethods.map((m) => (
                      <option key={m.id} value={m.id}>
                        {methodLabel(m)}
                        {m.isDefault ? ' (default)' : ''}
                      </option>
                    ))}
                  </select>
                ),
              },
              {
                key: 'state',
                header: 'State',
                render: (e) =>
                  e.autopayMethodId ? (
                    <Pill tone="success">enrolled</Pill>
                  ) : (
                    <Pill tone="neutral">manual</Pill>
                  ),
              },
            ]}
            rows={enrollments}
            rowKey={(e) => e.id}
            empty="No active engagements to enroll."
          />
          <p style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 8 }}>
            Engagement-level autopay overrides any firm-default plan setup. Switch to
            &quot;Off&quot; any time to resume manual payment.
          </p>
        </Card>
      )}
    </div>
  );
}
