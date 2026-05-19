// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Design tokens shared across staff and portal apps. Per-firm branding
// (logo + colors) overrides these at runtime via Phase 20 admin config.

export const tokens = {
  color: {
    bg: '#0b0d10',
    surface: '#11151b',
    border: '#1f2630',
    text: '#e6edf3',
    textMuted: '#8b97a6',
    accent: '#3b82f6',
    accentMuted: '#1e3a8a',
    success: '#22c55e',
    warning: '#f59e0b',
    danger: '#ef4444',
  },
  radius: { sm: 4, md: 8, lg: 12, pill: 999 },
  space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  font: {
    body: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif',
    mono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  },
} as const;

export type Tokens = typeof tokens;
