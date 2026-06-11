// SPDX-License-Identifier: Elastic-2.0
//
// Top-level error boundary. Without one, a render-time exception anywhere
// in the tree unmounts the whole SPA to a blank white screen. This catches
// it and shows a recoverable fallback (reload) instead.

import { Component, type ErrorInfo, type ReactNode } from 'react';

import { tokens } from './tokens';

interface Props {
  children: ReactNode;
  /** Optional label for the boundary (shown in the console log). */
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(`[${this.props.label ?? 'app'}] render error:`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: tokens.color.bg,
          color: tokens.color.text,
          fontFamily: tokens.font.body,
          padding: 24,
        }}
      >
        <div style={{ maxWidth: 460, textAlign: 'center', display: 'grid', gap: 12 }}>
          <h1 style={{ fontSize: 20, margin: 0 }}>Something went wrong</h1>
          <p style={{ fontSize: 14, color: tokens.color.textMuted, margin: 0 }}>
            This page hit an unexpected error. Reloading usually fixes it. If it keeps happening,
            let your administrator know.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                padding: '8px 16px',
                background: tokens.color.accent,
                color: '#fff',
                border: 'none',
                borderRadius: tokens.radius.sm,
                cursor: 'pointer',
                fontSize: 14,
              }}
            >
              Reload
            </button>
            <button
              type="button"
              onClick={() => {
                window.location.href = '/';
              }}
              style={{
                padding: '8px 16px',
                background: 'transparent',
                color: tokens.color.text,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm,
                cursor: 'pointer',
                fontSize: 14,
              }}
            >
              Go home
            </button>
          </div>
        </div>
      </div>
    );
  }
}
