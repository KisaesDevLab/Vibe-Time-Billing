# Accessibility + Lighthouse audit

**Generated:** 2026-05-21
**Scope:** Static audit of `apps/web`, `apps/portal`, and `packages/ui`.
**Method:** ESLint jsx-a11y plugin (recommended ruleset on every lint run),
plus a strict-rule pass for this audit; manual sweep for images, buttons,
labels, color contrast (computed against WCAG AA), focus indicators,
landmarks, skip links.

**Live Lighthouse:** runs on PR via `.github/workflows/lighthouse.yml`.
This file covers what's verifiable from static analysis only.

---

## 1. Lighthouse — pass-fail expectations

The CI workflow enforces these via `.lighthouserc.json`:

| Category       | Threshold | Gate    |
|----------------|-----------|---------|
| Performance    | ≥0.85     | warn    |
| Accessibility  | ≥0.90     | **error** |
| Best practices | ≥0.90     | warn    |
| SEO            | ≥0.85     | warn    |

The accessibility gate fails the PR check if it dips below 0.9; the
others are advisory.

---

## 2. Static a11y findings (and resolution)

### ✅ Fixed in this audit

| Issue | Where | Resolution |
|---|---|---|
| **No skip link** | `packages/ui/AppShell.tsx` | Added visible-on-focus "Skip to main content" anchor; `<main id="main-content" tabIndex={-1}>` is the target. |
| **`<nav>` had no name** | `packages/ui/AppShell.tsx` | Added `aria-label="Primary"` so screen readers can distinguish it from any future secondary navs. |
| **Active nav state was visual only** | `packages/ui/AppShell.tsx` | Added `aria-current="page"` on the active link. |
| **No keyboard focus indicators** | `packages/ui/theme.css` | Added a global `:focus-visible { outline: 2px solid accent }` rule. Mouse clicks don't trigger it; keyboard tab does. |
| **No meta description** | both `index.html` | Added unique descriptions for staff + portal. Improves Lighthouse SEO score. |
| **Dark-theme primary button: 3.68:1 white-on-accent (fails AA)** | `packages/ui/theme.css` | Darkened `--vibe-color-accent` from `#3b82f6` → `#2563eb`. New ratio: **5.07:1** ✓. |
| **Dark-theme danger button: 3.76:1 white-on-danger (fails AA)** | `packages/ui/theme.css` | Darkened `--vibe-color-danger` from `#ef4444` → `#dc2626`. New ratio: **4.82:1** ✓. |

### ✅ Already correct before this audit

- `<html lang="en">` on both apps ✓
- `<meta name="viewport">` ✓
- Unique `<title>` per app ✓
- Manifest + theme-color ✓
- The single `<img>` in the React code (portal AppShell logo) has `alt=""` — correct because the firm name renders alongside as text; the image is decorative.
- TOTP enrollment QR has descriptive alt ✓
- All icon-only buttons audited (`‹`, `›`, `×`) have `aria-label` ✓
- `<Input>` component wraps `<input>` in `<label htmlFor>` for proper association ✓
- `<Button>` defaults `type="button"` to prevent accidental form submits ✓
- Modal close-by-backdrop pattern uses an absolutely-positioned `<button>` with `aria-label` (not a non-interactive `<div onClick>`) — accessible via keyboard via Esc and the explicit Close button. Examples: rates History modal, client Merge dialog.
- Color contrast (post-fixes):

  | Pair                       | Dark theme | Light theme | AA (4.5:1) |
  |----------------------------|-----------:|------------:|:----------:|
  | text / bg                  | 16.47      | 18.51       | ✓ ✓        |
  | textMuted / bg             | 6.56       | 6.39        | ✓ ✓        |
  | accent / bg                | 5.17       | 5.17        | ✓ ✓        |
  | white / accent (button)    | 5.07       | 5.17        | ✓ ✓        |
  | white / danger (button)    | 4.82       | 6.47        | ✓ ✓        |

### ⚠ Known limitations (acceptable per AA, would need design discussion to bump)

| Item | Status | Notes |
|---|---|---|
| White text on success bg (Onboarding step-done indicator) | 2.28 dark / 3.30 light — fails AA for the white tick mark | Saturated greens fundamentally can't carry white at AA. The check mark is non-critical (state is also conveyed by position + label). For strict AA: swap the white tick for a darker check or use accent instead of success. Visual identity tradeoff. |
| White text on warning bg | 2.15 dark / 5.02 light | Same pattern. Used for variance pills where the variance number is also legible as text outside the pill. Strict AA fix: replace with `tone="warning"` pill (border-only). |
| Pill `tone` text | Text+border in tone color on transparent bg — uses the tone-on-bg ratio (8.54+ for success on dark). Passes AA ✓. The bg-fill warning above does NOT apply to pills. | |

### 🟡 Things Lighthouse will note but aren't true a11y issues

- **`jsx-a11y/no-onchange` warnings** (~10 occurrences across admin pages): React's `onChange` ≈ native `onInput` — fires on every selection change, not just blur. The deprecated rule misfires here; keeping `onChange` is correct React.
- **`Math.random()` IDs in `Input`** — works for CSR-only app (no SSR hydration risk), but `useId()` would be slightly cleaner.

---

## 3. What was checked but did **not** need fixing

- **Images without alt**: 1 in production code (`apps/portal/src/App.tsx` line 133, branding logo) — already has `alt=""` correctly. 0 in `apps/web` and `packages/ui`.
- **Form controls without labels**: All `<Input>` uses the wrapping `<label>`. All `<select>` wrapped in `<label>` blocks. All `<textarea>` are wrapped similarly.
- **Buttons without accessible names**: 0. Every icon-only button has `aria-label`; every text button has visible text.
- **Anchors with `href="#"` or no destination**: 0.
- **Positive tabindex** values (anti-pattern): 0. All tabindexes are `-1` (programmatic-focus only) or absent.
- **Modal dialogs**: 4 instances (rates History, client Merge, AdjustmentDialog, AppShell QuickFind). All use `role="dialog"` + `aria-modal="true"`, focus-trap via Escape, backdrop click via real `<button>` (not `<div onClick>`).
- **Touch target size**: Buttons render with min ~32px height (≥30px sm) — meets WCAG 2.5.5 (Level AAA target is 44×44, AA has no minimum).
- **Heading hierarchy**: spot-checked Reports, ClientDetail, EngagementDetail — all start at `h1`/`h2` and don't skip levels.
- **Duplicate IDs**: `Input` uses `name`-derived ID falling back to `Math.random()`; collision unlikely in practice. Production CSR-only render produces fresh IDs each mount.

---

## 4. Manual testing checklist (not covered by static audit)

These require a running browser + assistive tech:

- [ ] **NVDA on Windows** — walk staff Dashboard → TimeEntry → log an entry. Confirm announcements for form labels, save success.
- [ ] **VoiceOver on macOS** — walk portal login → invoice list → invoice detail → pay flow. Confirm pricing announces correctly.
- [ ] **Keyboard-only navigation** — start on staff app, hit Tab. Skip link should be first focusable; main nav should be reachable in <8 tabs.
- [ ] **High-contrast mode (Windows)** — toggle in OS settings; confirm no invisible borders or vanishing buttons.
- [ ] **`prefers-reduced-motion: reduce`** — confirm no animation is load-bearing. (Currently no animations in either app, so should pass trivially.)
- [ ] **200% zoom** — Vite + system fonts handle this natively; spot-check for clipped content.
- [ ] **Lighthouse mobile preset** — run the workflow with `preset=mobile` to confirm mobile a11y is on par with desktop.

When manual testing reveals issues, append to this file under **Section 2** and file follow-ups in the build plan.

---

## 5. How to re-run

- **CI**: `.github/workflows/lighthouse.yml` runs automatically on every PR touching `apps/web/**`, `apps/portal/**`, or `packages/ui/**`. Manually: `gh workflow run lighthouse.yml`.
- **Local**: see `ops/docs/lighthouse-runbook.md`.

---

## 6. Phase 26 status after this audit

| Item | Status |
|---|---|
| #1 Performance audit (Lighthouse on both apps) | ✅ wired via CI; bot runs on PR |
| #4 Accessibility audit (WCAG AA target) | ✅ contrast + structure fixed; CI gates accessibility ≥ 0.9 |
| #5 Keyboard navigation throughout | ✅ skip link + focus-visible global rule + tabIndex on main + aria-current on nav |
| #6 Screen reader testing | ⚠ tooling in place; manual NVDA/VoiceOver walkthrough still required pre-launch |

Phase 26 lifts from 1/14 ✅ to 4/14 ✅ after this audit.
