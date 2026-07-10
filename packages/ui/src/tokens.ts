// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
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

/** Re-anchored typography baseline. What used to render at 115% is
 *  now treated as the design 100% — every step is a multiple of this
 *  baseline. The underlying value (1.15) is the absolute zoom applied
 *  to the body; the percent label shown in the FontSizeControl is
 *  `scale / FONT_SCALE_BASELINE * 100`, so 1.15 displays as 100%. */
export const FONT_SCALE_BASELINE = 1.15;

/** Discrete font-scale steps wired to the FontSizeControl. The named
 *  percentages are 85% / 100% / 115% / 130% of the new baseline; the
 *  literal numbers below are absolute zoom values (baseline × ratio,
 *  rounded for stable comparison after localStorage round-trips). */
export const FONT_SCALE_STEPS = [0.98, 1.15, 1.32, 1.5] as const;
export type FontScale = (typeof FONT_SCALE_STEPS)[number];
export const DEFAULT_FONT_SCALE: FontScale = FONT_SCALE_BASELINE;
export const FONT_SCALE_STORAGE_KEY = 'vibe-font-scale';

/** Pre-React inline-script body that applies the persisted font-scale
 *  before paint, mirroring themeBootstrapScript. Saves a FOUC where
 *  the page flashes at the baseline and snaps to the user's choice.
 *  Old localStorage values from the previous step set (0.9 / 1.0 /
 *  1.15 / 1.3) won't match the new allowed list and fall through to
 *  the new default. */
export const fontScaleBootstrapScript = `
(function() {
  try {
    var raw = localStorage.getItem(${JSON.stringify(FONT_SCALE_STORAGE_KEY)});
    var allowed = ${JSON.stringify(FONT_SCALE_STEPS)};
    var baseline = ${FONT_SCALE_BASELINE};
    var n = raw ? parseFloat(raw) : baseline;
    if (!isFinite(n) || allowed.indexOf(n) === -1) n = baseline;
    document.documentElement.style.setProperty('--vibe-font-scale', String(n));
    if (document.body) document.body.style.zoom = String(n);
  } catch (e) {
    /* ignore */
  }
})();
`.trim();

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
