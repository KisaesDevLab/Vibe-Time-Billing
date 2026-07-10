// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Public-facing chrome for the intake surface. Soft light background with a
// firm-branded sticky top bar (wordmark eyebrow + "Encrypted & secure" pill).
// The page content sits on a centered stage. `bare` drops the top bar for
// surfaces that supply their own chrome (the booking page brings its own).

import type { ReactNode } from 'react';

import { SecureBadge, bodyFont, headFont, palette } from '../ui';

export function IntakeLayout({
  children,
  bare = false,
}: {
  children: ReactNode;
  /** Hide the firm top bar — e.g. the booking page, which supplies its own. */
  bare?: boolean;
}): JSX.Element {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: palette.pageGradient,
        color: palette.inkBody,
        fontFamily: bodyFont,
        WebkitFontSmoothing: 'antialiased',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {!bare && (
        <div
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 30,
            display: 'flex',
            flexWrap: 'wrap',
            gap: '10px 20px',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '11px clamp(14px, 4vw, 32px)',
            background: 'rgba(255,255,255,0.85)',
            backdropFilter: 'blur(14px)',
            borderBottom: `1px solid ${palette.border}`,
          }}
        >
          <span
            style={{
              fontFamily: headFont,
              fontWeight: 600,
              fontSize: 12,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: palette.accent,
            }}
          >
            Secure intake
          </span>
          <SecureBadge />
        </div>
      )}
      <div
        style={{
          flex: 1,
          width: '100%',
          display: 'flex',
          justifyContent: 'center',
          padding: 'clamp(22px, 4vw, 48px) 16px 64px',
        }}
      >
        <main style={{ width: 'min(720px, 100%)' }}>{children}</main>
      </div>
    </div>
  );
}
