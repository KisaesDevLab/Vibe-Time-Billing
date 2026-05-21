// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Shared AI panel surface (Phase 23 #23). Consistent visual treatment
// for every embedded AI feature — distinct from regular content via
// a thin accent border + ✨ marker, hides when AI is disabled at the
// firm level (the caller passes enabled=false), and renders error /
// loading / result states uniformly.

import { type ReactNode } from 'react';

import { tokens } from './tokens';

export interface AiPanelProps {
  /** Short label shown in the panel header. */
  title: string;
  /** Pulled from /ai/status — when false the panel renders nothing. */
  enabled?: boolean;
  /** Buttons/inputs rendered in the header (e.g. Generate). */
  action?: ReactNode;
  /** Provider name from /ai/status — appears as a tiny tag. */
  providerId?: string;
  /** Whether a request is in flight. */
  busy?: boolean;
  /** Last error message from a failed AI call. */
  error?: string | null;
  /** Result content; usually <p>{text}</p> or a custom list. */
  children?: ReactNode;
}

export function AiPanel({
  title,
  enabled = true,
  action,
  providerId,
  busy = false,
  error,
  children,
}: AiPanelProps): JSX.Element | null {
  if (!enabled) return null;
  return (
    <div
      style={{
        position: 'relative',
        padding: 12,
        border: `1px solid ${tokens.color.accent}`,
        borderRadius: tokens.radius.md,
        background: tokens.color.surface,
        display: 'grid',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: tokens.color.accent,
            letterSpacing: 0.4,
            textTransform: 'uppercase',
          }}
        >
          ✨ AI · {title}
        </span>
        {providerId && (
          <span
            style={{
              fontSize: 10,
              padding: '1px 6px',
              borderRadius: tokens.radius.pill,
              border: `1px solid ${tokens.color.border}`,
              color: tokens.color.textMuted,
            }}
          >
            {providerId}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {action}
      </div>
      {busy && (
        <p style={{ margin: 0, fontSize: 12, color: tokens.color.textMuted }}>Asking the model…</p>
      )}
      {error && !busy && (
        <p style={{ margin: 0, fontSize: 12, color: tokens.color.danger }}>{error}</p>
      )}
      {!busy && !error && children}
    </div>
  );
}
