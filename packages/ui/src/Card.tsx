// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import type { CSSProperties, ReactNode } from 'react';

import { tokens } from './tokens';

export interface CardProps {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
  /** DOM id, e.g. so in-page anchors / scrollIntoView can target the card. */
  id?: string;
}

export function Card({ title, action, children, style, id }: CardProps): JSX.Element {
  return (
    <section
      id={id}
      style={{
        background: tokens.color.surface,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.lg,
        padding: tokens.space.lg,
        color: tokens.color.text,
        fontFamily: tokens.font.body,
        ...style,
      }}
    >
      {(title || action) && (
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: tokens.space.md,
          }}
        >
          {title && <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}
