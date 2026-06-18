# design-sync notes — @vibe/ui

## Build / environment

- Shape: **package** (no Storybook). Entry: `./packages/ui/dist/index.js` (tsc output — run `cfg.buildCmd` = `pnpm --filter @vibe/ui build` first).
- `--node-modules packages/ui/node_modules` (React resolves there, not repo root).
- Render check needs Chromium **system libs** — install once per machine:
  `sudo /home/adminvibe/github-projects/Vibe-Time-Billing/.ds-sync/node_modules/.bin/playwright install-deps chromium`
  (cached browser is chromium-1223 → playwright 1.60.0, installed into `.ds-sync`).

## Theme

- The DS defaults to **DARK**: `theme.css` defines the palette on `:root, [data-theme='dark']`; `[data-theme='light']` swaps. Previews render on the dark default (honest). Designs can switch by setting `data-theme="light"` on an ancestor.

## Known render warns (triaged — not new on re-sync)

- The icon exports render small/blank by nature (a single ~16px glyph): `ChevronDown`, `ChevronRight`, `Download`, `Eye`, `Flag`, `Folder`, `Lock`, `Printer`, `Search`, `ShareIcon`, `Paperclip`. Authored previews show them at a visible size.
- `AuthLayout` / `Stat` floor/thin until authored.

## Re-sync risks

- Bundle is `@vibe/ui`'s real `dist/` — rebuild before re-sync when `packages/ui/src` changes.
- Previews are authored compositions (in `.design-sync/previews/`); they import from `@vibe/ui` and assume the current prop APIs — re-check against `<Name>.d.ts` after a UI refactor.

## Preview authoring (first sync)

- All 32 components have authored previews in `.design-sync/previews/` (real CPA content on the dark surface), graded good.
- **AuthLayout** mounts `useLightAuthTheme()` → sets `<html data-theme="light">` when no saved theme (auth screens are light-default). Its cards render LIGHT while every other component renders dark — correct product behavior. It mutates shared `<html>`; isolated-capture has no bleed, but if a future config captures multiple components per page, add a per-cell `data-theme` reset.
- `ThemeToggle`/`FontSizeControl` hooks (`useTheme`/`useFontScale`) are self-contained — no `cfg.provider` needed.
- Cosmetic: small controls (ThemeToggle, FontSizeControl, Sparkline, AiPanel short states) leave empty dark frame below the widget (tall capture cell). Not a defect; tighten via `cfg.overrides.<Name>.cardMode` later if desired.
