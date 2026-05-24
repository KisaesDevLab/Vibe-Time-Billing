# Client Portal — UI Plan

**App:** `apps/portal`
**Companion to:** `CLIENT_PORTAL_BUILD_PLAN.md`
**Purpose:** Visual + interaction language for the portal. What things look like, why, and how they compose.

This is meant as a working document — every shipped screen reflects these rules and every proposed screen should be designed against them.

---

## 1. Information hierarchy

The portal serves a client who logs in 0–4 times a month. They're never a power user, often on mobile, and frequently anxious (open invoice, missing document, upcoming deadline). The UI must lead with **what the client owes / must do** and bury everything else.

**Overview screen order, top to bottom:**

1. **Past-due alert** (red banner) — if any invoice is overdue. Includes amount + "Review" CTA.
2. **Items to respond to** (Connect Requests banner) — Phase 24. "You have N items to respond to."
3. **Open proposals** (Proposals banner) — Phase 25. "N proposals awaiting your review."
4. **Roadmap pins** — only shown when the Roadmap overlay tweak is on.
5. **Needs your attention** (left) + **Open invoices** (right) — stacked on mobile so attention is first.
6. **Engagement status** — Phase 16+. Each active engagement with progress + next milestone.
7. **Upcoming appointments** + **Upcoming tax payments** — side-by-side. Stacks on mobile.
8. **Three stat cards** — Outstanding, Paid YTD, Next payment.
9. **Recent activity** — short event log.

The whole screen must be skim-able in <5 seconds and the most urgent action should be one tap away.

---

## 2. Design tokens

The portal extends `@vibe/ui` tokens with three visual-style variants. All cards/buttons/etc. read from CSS variables; switching `data-style` on `<html>` swaps all surfaces atomically.

### Theme

- **Dark** (default) — `--c-bg: #0b0d10`, `--c-text: #e6edf3`, `--c-accent: #2563eb`.
- **Light** — `--c-bg: #ffffff`, `--c-text: #0f1419`, same accent.

Both meet WCAG AA on standard text. Pill backgrounds use `color-mix(in oklab, color N%, transparent)` so they stay readable across themes.

### Visual style

- **Strict** — matches existing tokens.ts exactly. System font, 6/10px radii, no card shadow.
- **Refined** (default) — Inter font, 8/12px radii, soft card shadow, larger headings with tighter tracking. Same palette.
- **Refresh** — Newsreader serif headlines + Inter body. Warmer dark palette (warm grays + cream). 4/8px radii. Lighter card shadow. Use when the firm has a warm/personal brand.

### Brand accent

Single CSS variable `--brand-accent-override` set by the firm. Tweaks panel exposes a curated palette: blue (#2563eb), green (#16a34a), purple (#9333ea), red (#dc2626), orange (#ea580c). Free-pick is not exposed to keep accessibility on contrast-bounded combinations.

### Typography scale

| Token            | Default | Refined | Refresh    |
| ---------------- | ------- | ------- | ---------- |
| `--h1-size`      | 28      | 32      | 38         |
| `--h2-size`      | 22      | 24      | 28         |
| `--stat-size`    | 26      | 30      | 36         |
| `--font-heading` | system  | Inter   | Newsreader |
| `--font-display` | system  | Inter   | Newsreader |

Mobile reduces `--h1` / `--h2` / `--stat` by ~25%.

### Radii / spacing

`--r-sm` (6 / 8 / 4), `--r-md` (10 / 12 / 8), `--r-pill` (always 999). Standard 16px gap between cards; 24px between sections; 28/32px section padding on desktop, 16/14px on mobile.

---

## 3. UI primitives

All shared in `src/ui.jsx`:

### `<Card title action padding>`

The default surface. `var(--c-surface)` background, 1px border, optional header with title + slot for action button. Children land in 16px padding by default (`md`); `sm` for tight lists, `lg` for dialogs.

### `<Pill tone dot>`

Status indicator. Tones: `neutral`, `success`, `warning`, `danger`, `accent`. `dot` adds a leading colored circle. Background is a low-opacity tint of the tone color via `color-mix`; foreground is the tone color full-strength. Always uppercase, 11px, 0.2 letter-spacing, 600 weight.

### `<Button variant size icon>`

Variants: `primary` (accent fill), `secondary` (transparent + border), `ghost` (transparent), `danger`, `success`. Sizes: `sm` (12px), `md` (13px), `lg` (14px). `icon` prepends an Icon component.

### `<Input label icon suffix hint error>`

Single-line text input wrapped in a labeled group. Icon slots into the left. Suffix slot for trailing pill/text (e.g. "verified" pill). `hint` is muted helper text; `error` is danger-toned. Border picks up `var(--c-danger)` when `error` is set.

### `<Table columns rows rowKey onRowClick compact>`

Horizontally scrollable on overflow. Header row: 10px uppercase muted text. Data row: 13px text, 12px padding, optional click handler with hover row tint. Single-column responsive fallback isn't built in — for mobile, swap to a custom card list (see `InvoiceCardList`, `FileCardList`).

### `<Stat label value sub tone icon>`

Big number for dashboards. `tone` colors the value (success / warning / danger). Always renders the label in 11px uppercase muted text above the value in `--stat-size` display font.

### `<SectionHeading eyebrow title action>`

Page-level title with optional eyebrow (small uppercase) and right-aligned action slot. Wraps on narrow screens.

### `<EmptyState icon title body action>`

Empty-list fallback. Centered 48px round icon background, title, body, optional CTA below.

---

## 4. Shell + navigation

### `<AppShell>`

Two layouts via `variant`:

**Desktop.** 240px left sidebar (brand mark + entity switcher + nav + identity footer) + scrollable main column with sticky topbar (breadcrumb + portal status pill). Nav items get a subtle accent-tinted background when active; the active foreground stays primary text color, not accent, to avoid over-emphasis.

**Mobile.** Single column. 50px top bar with brand mark on the left and a chevron-down button on the right. Tapping the chevron drops a full-screen menu sheet with the same nav. Content area pads 16/14px.

### Roadmap overlay

When the Roadmap tweak is on:

- Sidebar shows a "Proposed" section below shipped nav with future screens (Proposals, Requests, Messages, Appointments, Tax payments, Tax docs).
- Each future-screen nav row gets a small "P25" / "P24" / "P16+" badge in accent-tinted background.
- Each shipped screen renders a dashed-border banner above the content with per-screen pins (title + description + phase).
- Topbar shows a "Roadmap view" accent pill so the user knows they're seeing speculative UI.

### Entity switcher

In the sidebar when `clients.length > 1`. Expandable button → dropdown of clients with the active one highlighted. Each entry shows the entity name + the client's role/relationship (Member-Manager, GP, Self). Hidden entirely when single-entity.

---

## 5. Screen patterns

### List + detail (Invoices, Letters, Files, Messages, Proposals, Requests)

- List uses `<Table>` on desktop, custom card list on mobile.
- Row click navigates to detail (or opens a dialog for read-only docs like Letters).
- Detail uses a "Back" ghost button + `<SectionHeading>` with a status `<Pill>` as the action slot.
- Detail is typically 2-column: primary content on the left (line items, document body), action panel on the right (pay button, sign block, share, related docs).

### Card grids (Switch, Engagement status)

- `repeat(auto-fit, minmax(280px, 1fr))` on desktop, single column on mobile.
- Each card is a button so the whole surface is clickable.
- Active state = accent border + accent eyebrow; otherwise default border + muted eyebrow.

### Stepper flows (Proposals, Letter accept)

4-step horizontal stepper at the top of the page. Each step is a 26px round badge (filled accent for current, success-check for done, muted for upcoming) + label. Connecting hairlines fill in as steps complete. Stepper scrolls horizontally on mobile rather than wrapping — the labels stay readable.

Each step renders its own card content + a Back/Continue button pair at the bottom (Back = secondary, Continue = primary, disabled until valid).

---

## 6. Color usage rules

| Color                       | Semantic                        | Where                                                                                   |
| --------------------------- | ------------------------------- | --------------------------------------------------------------------------------------- |
| `--c-accent` (blue default) | Brand / actionable / hyperlink  | Primary buttons, accent pills, links, stepper current step, brand mark                  |
| `--c-success` (green)       | Confirmed / paid / accepted     | "Paid" pill, signed agreement banner, verified contacts, autopay-on pill                |
| `--c-warning` (amber)       | Attention needed but not broken | "Awaiting" pills, RSVP-needed, autopay paused, soon-due (≤7d) tax payments              |
| `--c-danger` (red)          | Past due / locked / error       | Overdue banners, locked file rows, past-due tax payments, revision-needed Request items |
| `--c-text-muted`            | De-emphasized text              | Helper hints, timestamps, secondary lines in 2-line rows                                |

**Pill background = color-mix 18–22%** of the foreground color with transparent. This produces a soft tint that reads clearly on both dark and light surfaces without needing a separate variable per theme.

---

## 7. Tax payments — surface design (proposed)

Because this is the highest-stakes new feature, write down what makes it good:

1. **Never look like the firm collects payment.** Every CTA on a tax payment row is `Pay at {agency}` with an ↗ icon and `target="_blank"`. Never "Pay" alone — clients have misclicked that and tried to pay the firm.
2. **Disclaimer at the top, every time.** "Holland CPA does not collect tax payments…" — even when the screen is otherwise empty. Required for liability.
3. **Color = urgency, not severity.** A red left border on a tax payment row means "due soon", not "you did something wrong". Same color/shape vocabulary as the past-due-invoice banner is fine because the action is the same: pay the agency now.
4. **Auto-filed cases ≠ payable.** Sales tax that the firm files gets a `firm files` success pill and **no Pay button**. The client should not feel obligated to do anything for these rows; they're informational only.
5. **Confidence band.** A `medium` confidence Q3+ estimate gets an `estimated` neutral pill. Avoid implying precision we don't have.

---

## 8. Proposals — surface design (proposed)

1. **The tier cards do the heavy lifting.** Side-by-side at desktop width, stacked on mobile. Each card carries a clear price + cadence in the display font, an optional "Save $X vs à la carte" line, a recommended ribbon for the partner's preferred tier, and a checkmark list. Excluded services render struck-through and muted — kept visible so the client can see what they'd give up by going down a tier.
2. **One signature, one authorization.** The client signs a single typed name and authorizes a single payment method, in two consecutive steps. Anchor's flow shows that splitting these is fine; combining them loses the signature audit trail.
3. **Rendered signature.** When the client types their name on the sign step, render it below the input in serif italics (`Newsreader`). This is decorative, not legally meaningful — but it makes the typed signature feel like an action, not a form field.
4. **The "Done" screen sells the agreement, not the sale.** Once signed, lead with what happens next: the letter is filed in Files, the engagement appears on Overview, auto-charge starts on date X, etc. The point is to make the client feel ownership of the engagement, not relief that the transaction is over.

---

## 9. Mobile patterns

- **No grids of 2+.** Every multi-column grid collapses to a single column at <720px via CSS variable swap on `[data-mobile="true"]`.
- **Tables become cards.** Invoices and Files render as `<InvoiceCardList>` / `<FileCardList>` on mobile. Multi-column tables (Statement ledger, Notification grid) keep their tables but with horizontal scroll.
- **44px minimum hit targets.** All buttons size up at mobile; icon buttons get explicit 30×30 minimum.
- **Sticky topbar.** Brand + screen title + menu chevron — always visible. Sidebar is replaced by an overlay menu sheet.
- **iOS frame for prototype.** The prototype frames mobile in `<IOSDevice>` to make device proportions explicit. Real PWA install (Phase 26) means we never actually render inside an iOS frame in production.

---

## 10. Tweaks panel

Used during design review and customer demos. Lives in the bottom-right when the toolbar Tweaks toggle is on.

| Tweak           | Values                     | Effect                               |
| --------------- | -------------------------- | ------------------------------------ |
| Theme           | Dark / Light               | Sets `[data-theme]`                  |
| Device          | Desktop / Mobile           | Sets `[data-mobile]` + swaps frame   |
| Visual style    | Strict / Refined / Refresh | Sets `[data-style]`                  |
| Logged in       | on/off                     | Routes between login and app         |
| Client entities | 1 / 3                      | Toggles entity switcher visibility   |
| Roadmap overlay | on/off                     | Shows proposed nav + per-screen pins |
| Jump to screen  | every nav item             | Quick navigation during demo         |
| Brand color     | curated swatches           | Sets `--brand-accent-override`       |

**Important:** Tweaks are a designer affordance — they don't ship to the real portal. They exist so a partner or stakeholder can see all states in one place.

---

## 11. Accessibility

- **Focus rings.** All interactive elements have `:focus-visible` outlines in `--c-accent`, 2px, offset 2.
- **Contrast.** Body text is 4.5:1 minimum against `--c-bg` on both themes. Muted text and small labels stay above 3:1.
- **Hit targets.** 44×44 minimum on mobile; 30×30 on desktop icon buttons.
- **Status conveyed both by color and text.** Pills always carry a text label, never just a color. Urgency on tax payments is communicated by left-border color **and** "due in Nd" text **and** a date.
- **Forms.** Every input has an explicit `<label>` via the `<Input>` component. Required-field hints go in `hint`, errors in `error`, never just color.
- **Motion.** No spin loaders, no parallax. Transitions are 100–150ms property changes (background, border, transform). Respect `prefers-reduced-motion` by tightening these to 0ms (TODO — not yet implemented).

---

## 12. What we intentionally don't have

- No bottom tab bar on mobile. The portal isn't visited often enough to earn permanent screen real estate; the menu sheet is faster to add to.
- No notification center in the topbar. Notifications go to email/SMS — that's the entire point of the notification prefs screen. The portal isn't where clients want to be notified.
- No "Activity feed" as a primary nav item. Activity is a card on Overview, scoped to recent + relevant. A separate feed of every event is firm-side, not client-side.
- No theme toggle in the topbar. Theme follows the firm's brand. The Tweaks panel exposes it for designers; production end-users see whatever the firm picked.
- No avatars beyond initials. The portal doesn't ask for or store client photos.

---

## 13. Source-of-truth files in the prototype

| Concern                                                                                                                 | File                      |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Design tokens + themes + visual styles                                                                                  | `src/theme.css`           |
| All UI primitives (Card, Pill, Button, Input, Table, Stat, etc.)                                                        | `src/ui.jsx`              |
| AppShell + Nav + RoadmapInjector + RoadmapPin                                                                           | `src/shell.jsx`           |
| Mock data + roadmap pin definitions                                                                                     | `src/data.jsx`            |
| Login + Home + Invoices + Invoice detail                                                                                | `src/screens-core.jsx`    |
| Letters + Files (preview + share) + Payment methods + Notifications + Profile + Switch + Messages + Tax docs + Requests | `src/screens-aux.jsx`     |
| Proposals + Appointments + Tax payments + Overview cards for the same                                                   | `src/screens-future.jsx`  |
| Routing + Tweaks panel + Device frame                                                                                   | `src/app.jsx`             |
| HTML entry                                                                                                              | `Vibe Client Portal.html` |

When refactoring into the real `apps/portal` codebase, each screen file maps to a `pages/X.tsx`; UI primitives stay in `@vibe/ui`.
