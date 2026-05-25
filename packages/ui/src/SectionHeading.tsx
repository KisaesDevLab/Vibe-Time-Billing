// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CP0 — Section heading. UI plan §2 calls for an eyebrow (small
// uppercase label) above the title, with an optional right-side
// action slot (e.g. a "View all" link). Used by the portal Home shell
// and the Tax Payments page sections.

import type { CSSProperties, ReactNode } from 'react';

import { tokens } from './tokens';

export interface SectionHeadingProps {
  /** Small uppercase eyebrow text rendered above the title. */
  eyebrow?: ReactNode;
  title: ReactNode;
  /** Optional right-side slot (link, button, badge). */
  action?: ReactNode;
  /** Optional explainer below the title. */
  description?: ReactNode;
  style?: CSSProperties;
}

export function SectionHeading({
  eyebrow,
  title,
  action,
  description,
  style,
}: SectionHeadingProps): JSX.Element {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        gap: tokens.space.md,
        marginBottom: tokens.space.md,
        ...style,
      }}
    >
      <div>
        {eyebrow && (
          <div
            style={{
              fontSize: 11,
              color: tokens.color.textMuted,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginBottom: 2,
            }}
          >
            {eyebrow}
          </div>
        )}
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: tokens.color.text }}>
          {title}
        </h2>
        {description && (
          <p
            style={{
              margin: '4px 0 0',
              fontSize: 13,
              color: tokens.color.textMuted,
              maxWidth: 600,
            }}
          >
            {description}
          </p>
        )}
      </div>
      {action && <div style={{ flexShrink: 0 }}>{action}</div>}
    </header>
  );
}
