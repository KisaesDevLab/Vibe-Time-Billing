// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import type { ReactNode } from 'react';

import { tokens } from './tokens';

export interface AuthLayoutProps {
  brand: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function AuthLayout({
  brand,
  title,
  subtitle,
  children,
  footer,
}: AuthLayoutProps): JSX.Element {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: tokens.color.bg,
        color: tokens.color.text,
        fontFamily: tokens.font.body,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: tokens.space.lg,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 380,
          background: tokens.color.surface,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.lg,
          padding: tokens.space.xxl,
        }}
      >
        <div
          style={{
            fontSize: 12,
            color: tokens.color.textMuted,
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            marginBottom: tokens.space.sm,
          }}
        >
          {brand}
        </div>
        <h1 style={{ margin: 0, fontSize: 22 }}>{title}</h1>
        {subtitle && (
          <p style={{ color: tokens.color.textMuted, marginTop: 6, fontSize: 13 }}>{subtitle}</p>
        )}
        <div style={{ marginTop: tokens.space.xl }}>{children}</div>
        {footer && (
          <div
            style={{
              marginTop: tokens.space.xl,
              paddingTop: tokens.space.md,
              borderTop: `1px solid ${tokens.color.border}`,
              fontSize: 12,
              color: tokens.color.textMuted,
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
