// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { Card, Pill, tokens } from '@vibe/ui';

import { useAuth } from '../auth-context';
import { PayToUnlockBanner } from '../components/PayToUnlockBanner';

export function HomePage(): JSX.Element {
  const { me } = useAuth();

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 700, margin: '0 auto' }}>
      <PayToUnlockBanner />
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
