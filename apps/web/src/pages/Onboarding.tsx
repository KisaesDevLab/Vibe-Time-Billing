// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { useEffect, useState } from 'react';

import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { BRAND } from '../brand';

interface Snapshot {
  counts: {
    clients: number;
    engagements: number;
    invoices: number;
    users: number;
    recurringPlans: number;
  };
}

interface Step {
  key: string;
  label: string;
  href: string;
  doneWhen: (s: Snapshot | null) => boolean;
  why: string;
}

const STEPS: Step[] = [
  {
    key: 'taxonomy',
    label: 'Set up service lines and work codes',
    href: '/admin/taxonomy',
    doneWhen: () => false,
    why: 'Time entries need a work code; the engagement-template installer can seed both.',
  },
  {
    key: 'templates',
    label: 'Install starter engagement templates',
    href: '/admin/templates',
    doneWhen: () => false,
    why: 'Pre-built templates for 1040 / 1120-S / 1065 / Audit / Bookkeeping fit most firms.',
  },
  {
    key: 'users',
    label: 'Invite staff and assign roles',
    href: '/admin/users',
    doneWhen: (s) => (s ? s.counts.users > 1 : false),
    why: 'Each staff member gets TOTP-enforced login and a timekeeper rate.',
  },
  {
    key: 'rates',
    label: 'Set timekeeper rates',
    href: '/admin/rates',
    doneWhen: () => false,
    why: 'Without rates, time entries refuse to log.',
  },
  {
    key: 'clients',
    label: 'Add at least one client',
    href: '/clients',
    doneWhen: (s) => (s ? s.counts.clients > 0 : false),
    why: 'Engagements live under a client; the partner-in-charge is required.',
  },
  {
    key: 'engagement',
    label: 'Create an engagement',
    href: '/clients',
    doneWhen: (s) => (s ? s.counts.engagements > 0 : false),
    why: 'Pick the fee structure that matches what you bill — 7 structures supported.',
  },
  {
    key: 'time',
    label: 'Log your first time entry',
    href: '/time',
    doneWhen: () => false,
    why: 'Time entries snapshot the rate at creation — historical reports never shift.',
  },
  {
    key: 'branding',
    label: 'Add firm branding (logo + accent + support contact)',
    href: '/admin',
    doneWhen: () => false,
    why: 'Branding renders on invoice PDFs and the portal shell.',
  },
];

export function OnboardingPage(): JSX.Element {
  const [snap, setSnap] = useState<Snapshot | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ snapshot: Snapshot | null }>(
          '/api/staff/admin/compliance/firm-snapshot',
        );
        setSnap(r.snapshot);
      } catch {
        // ignore
      }
    })();
  }, []);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 800 }}>
      <Card title={`Welcome to ${BRAND}`}>
        <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 0 }}>
          Run through this checklist once to get the appliance fully operational.
        </p>
        <div style={{ display: 'grid', gap: 12 }}>
          {STEPS.map((step, i) => {
            const done = step.doneWhen(snap);
            return (
              <div
                key={step.key}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'auto 1fr auto',
                  gap: 12,
                  alignItems: 'center',
                  padding: 12,
                  borderRadius: tokens.radius.sm,
                  background: tokens.color.surface,
                  border: `1px solid ${tokens.color.border}`,
                }}
              >
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: '50%',
                    background: done ? tokens.color.success : tokens.color.border,
                    color: '#fff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  {done ? '✓' : i + 1}
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>{step.label}</div>
                  <div style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 2 }}>
                    {step.why}
                  </div>
                </div>
                <a href={step.href}>
                  <Button size="sm" variant={done ? 'secondary' : 'primary'}>
                    {done ? 'Review' : 'Go'}
                  </Button>
                </a>
              </div>
            );
          })}
        </div>
        {snap && (
          <p style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 16 }}>
            Current counts: {snap.counts.clients} clients · {snap.counts.engagements} engagements ·{' '}
            {snap.counts.invoices} invoices · {snap.counts.users} users{' '}
            <Pill tone="neutral">live</Pill>
          </p>
        )}
      </Card>
    </div>
  );
}
