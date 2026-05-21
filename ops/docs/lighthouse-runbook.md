# Lighthouse + accessibility runbook

This is a CI-driven check, not a local-only tool. The same configuration
runs on PR and on demand via `gh workflow run lighthouse.yml`.

## CI

`.github/workflows/lighthouse.yml` builds both `apps/web` and
`apps/portal`, then runs `@lhci/cli` against the built artifacts using
`.lighthouserc.json`. Reports are uploaded as an artifact named
`lighthouse-reports`; download from the workflow run page.

Score thresholds (gates on PR):

| Category       | Target | Gate    |
|----------------|--------|---------|
| Performance    | ≥0.85  | warn    |
| Accessibility  | ≥0.90  | **error** |
| Best practices | ≥0.90  | warn    |
| SEO            | ≥0.85  | warn    |

Accessibility-specific audits gated as errors:

- `color-contrast` — every text+background pair WCAG AA (4.5:1)
- `image-alt` — every img has alt or role=presentation
- `label` — every form control has an associated label
- `button-name` — every button has accessible text
- `link-name` — every anchor has accessible text
- `html-has-lang` — `<html lang>` set
- `meta-viewport` — viewport meta with width=device-width
- `document-title` — `<title>` non-empty
- `duplicate-id-active` — no duplicate IDs on focusable elements

## Local run

```bash
# 1. Build the app you want to audit.
pnpm --filter @vibe/web build      # or @vibe/portal

# 2. Install Lighthouse CLI globally (one-time).
npm install -g lighthouse @lhci/cli

# 3. Serve the dist locally on port 5000.
npx serve apps/web/dist -p 5000 &

# 4. Run Lighthouse against it.
lighthouse http://localhost:5000 \
  --output=html --output-path=./report.html \
  --view \
  --chrome-flags='--headless=new --no-sandbox'
```

Or use the harness lhci config directly (matches CI):

```bash
pnpm --filter @vibe/web build
lhci autorun --config=.lighthouserc.json
```

Reports land in `.lighthouseci/`.

## Manual a11y testing

Lighthouse catches the obvious. Beyond it:

- **NVDA / VoiceOver / JAWS**: run a screen reader through each top-level
  page in `apps/portal` (clients may be older / less tech-savvy). Focus
  on: login → invoice list → invoice detail → pay flow → receipt.
- **Keyboard-only**: tab through the staff app top-to-bottom on a
  Dashboard refresh. The skip link should appear on first tab; main
  content should be reachable in <10 tabs.
- **High-contrast mode**: toggle Windows high-contrast and confirm no
  invisible borders / disappearing buttons.
- **Reduced motion**: set `prefers-reduced-motion: reduce`; no animation
  should be load-bearing.

## What this audit does not cover

- Real-world performance on slow networks — that's an integration
  measurement on a deployed instance, not a static build.
- Cognitive load / readability — separate UX review.
- Internationalization — out of scope for v1 (USD-only per Q2).

## Findings log

Static audit findings recorded in
`ops/docs/progress/a11y-lighthouse-audit.md`.
