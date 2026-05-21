// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Design tokens shared across staff and portal apps. Color tokens resolve
// to CSS custom properties defined in theme.css — switching the
// `data-theme` attribute on <html> swaps light/dark without re-render.
// Per-firm branding (logo + colors) overrides these at runtime via
// Phase 20 admin config.

export const tokens = {
  color: {
    bg: 'var(--vibe-color-bg)',
    surface: 'var(--vibe-color-surface)',
    border: 'var(--vibe-color-border)',
    text: 'var(--vibe-color-text)',
    textMuted: 'var(--vibe-color-text-muted)',
    accent: 'var(--vibe-color-accent)',
    accentMuted: 'var(--vibe-color-accent-muted)',
    success: 'var(--vibe-color-success)',
    warning: 'var(--vibe-color-warning)',
    danger: 'var(--vibe-color-danger)',
  },
  radius: { sm: 4, md: 8, lg: 12, pill: 999 },
  space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  font: {
    body: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif',
    mono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  },
} as const;

export type Tokens = typeof tokens;

export type ThemeMode = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'vibe-theme';

/**
 * Read-then-apply helper for the pre-React inline script. Inlined in
 * index.html avoids the FOUC where the page paints with the default
 * theme before the user's saved choice loads.
 */
export const themeBootstrapScript = `
(function() {
  try {
    var stored = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    var prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    var theme = stored || (prefersLight ? 'light' : 'dark');
    document.documentElement.dataset.theme = theme;
  } catch (e) {
    document.documentElement.dataset.theme = 'dark';
  }
})();
`.trim();
