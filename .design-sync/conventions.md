# Vibe Time & Billing UI (`@vibe/ui`) — how to build with it

A React component library for a CPA practice-management product (staff app + client portal). Components are plain function components styled with **inline styles driven by design tokens** — there is **no utility-class system** and no styled-props theme system. Build layout glue the same way: import `tokens` and use it in `style={{…}}`.

## Setup / theming

- The palette lives in **`theme.css`** as CSS custom properties (`--vibe-color-*`). Import it once at the app root (`import '@vibe/ui/theme.css'`). Components read those variables through the `tokens` object, so **without that stylesheet everything renders unstyled**.
- **Dark is the default** (`:root` defines the dark palette). Set `data-theme="light"` on `<html>` to switch to light. `ThemeToggle` flips it; auth screens (`AuthLayout`) force light. No React provider is required — tokens resolve from CSS, and `ThemeToggle`/`FontSizeControl` are self-contained.

## The styling idiom — use `tokens`, never invent class names

Import `{ tokens } from '@vibe/ui'` and compose with these REAL keys (each color is a `var(--vibe-color-*)`):

- `tokens.color`: `bg`, `surface`, `border`, `text`, `textMuted`, `accent`, `accentMuted`, `success`, `warning`, `danger`
- `tokens.space`: `xs`(4) `sm`(8) `md`(12) `lg`(16) `xl`(24) `xxl`(32)
- `tokens.radius`: `sm`(4) `md`(8) `lg`(12) `pill`(999)
- `tokens.font`: `body`, `mono`

Example glue: `<div style={{ background: tokens.color.surface, border: \`1px solid \${tokens.color.border}\`, borderRadius: tokens.radius.md, padding: tokens.space.lg, color: tokens.color.text }}>`. Don't hard-code hex — go through tokens so light/dark both work.

## Component variants are discrete props (not classes)

- `Button` — `variant`: `primary | secondary | danger | ghost`; `size`: `sm | md`.
- `Pill` — `tone`: `neutral | accent | success | warning | danger`.
- `Stat` — `{ label, value, tone?: neutral|success|warning|danger|accent, caption? }`.
- `Table` — `{ columns: {key,header,render,align?}[], rows, rowKey, empty?, footer? }` (generic).
- `Combobox`/`MultiCombobox` — `options: {value,label,description?}[]` + `value`/`selected` + `onChange`.
- `Tabs` — `tabs: {key,label,badge?}[]`, caller owns the panel. `Wizard` — `steps: {key,label,content}[]` + `open` + `primaryAction`/`secondaryAction`.
- `AppShell` — `{ navItems: NavItem[], children }` (sidebar + realm badge + content). `AuthLayout` — centered auth card (light). `SectionHeading`, `EmptyState`, `Card`, `Input`, `AiPanel`, `Sparkline`, `Markdown`, `ColumnFilter`, `ThemeToggle`, `FontSizeControl`, plus stroke icons (`Search`, `Lock`, `Eye`, `Folder`, `Download`, `Printer`, `Flag`, `ShareIcon`, `ChevronDown/Right`, `Paperclip`) taking `size`/`color`.

## Where the truth lives

Read `_ds/<folder>/styles.css` (+ its `@import`s) for the exact tokens, and each component's `<Name>.d.ts` (the prop contract) and `<Name>.prompt.md` before composing. Prefer real components for controls; use tokens only for your own layout.

## One idiomatic snippet

```tsx
import { Card, Button, Stat, Pill, tokens } from '@vibe/ui';

<div
  style={{
    display: 'grid',
    gap: tokens.space.lg,
    background: tokens.color.bg,
    padding: tokens.space.xl,
  }}
>
  <div
    style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))',
      gap: tokens.space.md,
    }}
  >
    <Stat label="WIP balance" value="$48,250" tone="accent" caption="+$3,100 this week" />
    <Stat label="Overdue" value="7" tone="danger" />
  </div>
  <Card title="Allen, David — 1040" action={<Pill tone="warning">Review</Pill>}>
    <p style={{ color: tokens.color.textMuted, margin: 0 }}>3 documents awaiting review.</p>
    <div style={{ marginTop: tokens.space.md, display: 'flex', gap: tokens.space.sm }}>
      <Button variant="primary">Generate pre-bill</Button>
      <Button variant="secondary">Add time</Button>
    </div>
  </Card>
</div>;
```
