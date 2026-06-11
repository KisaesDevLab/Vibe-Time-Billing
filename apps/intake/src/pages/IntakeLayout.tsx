// SPDX-License-Identifier: Elastic-2.0
//
// Minimal public-facing chrome for the intake surface: a centered card on
// a plain background, a header, and a privacy footer. No nav — anonymous
// visitors never see the rest of the app.

import type { ReactNode } from 'react';

import { tokens } from '@vibe/ui';

export function IntakeLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: tokens.color.bg,
        color: tokens.color.text,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '24px 16px',
      }}
    >
      <div style={{ width: 'min(760px, 100%)' }}>
        <header style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 20, margin: 0 }}>Send documents securely</h1>
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: '4px 0 0' }}>
            Your files are encrypted and scanned before anyone at the firm sees them.
          </p>
        </header>
        <main>{children}</main>
        <footer
          style={{
            marginTop: 32,
            paddingTop: 16,
            borderTop: `1px solid ${tokens.color.border}`,
            fontSize: 12,
            color: tokens.color.textMuted,
          }}
        >
          Files are transmitted over an encrypted connection and stored encrypted at rest. Do not
          send passwords or payment-card numbers through this form.
        </footer>
      </div>
    </div>
  );
}
