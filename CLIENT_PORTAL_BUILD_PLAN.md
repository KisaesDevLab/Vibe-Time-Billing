# Client Portal — Build Plan

**Repository:** `KisaesDevLab/Vibe-Time-Billing`
**App:** `apps/portal`
**Scope of this document:** What's shipped today, what's proposed, and the phase ordering for each addition.

This document mirrors the structure of `BUILD_PLAN.md` and is intended to slot in as a deeper expansion of **Phase 16 — Client portal** plus the future portal work that touches Phases 21, 23, 24, 25, and 26.

---

## 1. Today (Phase 16)

The portal is a self-hosted React 18 + Vite + TypeScript SPA. It re-uses `@vibe/ui` (`AppShell`, `Card`, `Pill`, `Button`, `Input`, `Table`, `Stat`, design tokens). Auth is magic-link (email) or 6-digit SMS code; sessions are challenged on new devices.

### Shipped screens

| Screen                        | Route              | File                          | Status  |
| ----------------------------- | ------------------ | ----------------------------- | ------- |
| Login (magic link / SMS code) | `/login`           | `pages/Login.tsx`             | shipped |
| Overview (home)               | `/`                | `pages/Home.tsx`              | shipped |
| Invoices — list               | `/invoices`        | `pages/Invoices.tsx`          | shipped |
| Invoices — detail + pay       | `/invoices/:id`    | `pages/Invoices.tsx`          | shipped |
| Engagement letters            | `/letters`         | `pages/Letters.tsx`           | shipped |
| Files (with pay-to-unlock)    | `/files`           | `pages/Files.tsx`             | shipped |
| Payment methods               | `/payment-methods` | `pages/PaymentMethods.tsx`    | shipped |
| Notification preferences      | `/notifications`   | `pages/NotificationPrefs.tsx` | shipped |
| Profile + alt contacts        | `/profile`         | `pages/AltContacts.tsx`       | shipped |
| Switch entity                 | `/switch`          | `pages/Switch.tsx`            | shipped |

### Shared portal-side concerns (all shipped)

- **Per-client preferences.** Notification prefs are stored per `access_id`, not per identity. The same identity may have different prefs across entities.
- **Pay-to-unlock.** `PayToUnlockBanner.tsx` reads `lockedUntilInvoiceId` on a file and renders an inline banner with a deep-link to the blocking invoice. The server enforces the rule; the banner is informational.
- **Entity switcher.** Multi-entity identities post a list of `client_access` rows; switching writes `activeClientId` to localStorage and re-fetches scoped data.
- **Statement of account.** **Removed** from the portal in v2 — clients found the running-balance ledger confusing next to the existing Invoices view. The firm can still email a PDF statement (Phase 15 firm-side feature).

---

## 2. Proposed (in priority order)

### 2.1 Per-payment receipt download — Phase 16 #19 (small)

**Why.** Today a paid invoice shows "Paid in full on …" with no document. Clients ask their accountants for receipts during expense audits.
**UI.** On invoice detail, when `paidCents > 0`, expose a **Download receipt** button per payment row. Use the same Stripe `receipt_url` we already store; fall back to a server-generated PDF for ACH and offline payments.
**Server.** `GET /api/portal/payments/:id/receipt` — renders a one-page PDF (firm branding, invoice number, payment method, amount, applied date, processor ref).
**Data.** No schema change — `payments.receipt_id` already exists.

### 2.2 Autopay per engagement — Phase 16 #17 (small)

**Why.** Today autopay is global on a payment method. Clients want autopay on the recurring bookkeeping but to manually pay one-off advisory invoices.
**UI.** On Payment Methods, add an "Autopay enrollment" card listing each active engagement with a toggle ("Enable" / "Pause"). Toggle writes `engagements.autopay_method_id`.
**Server.** Billing job already iterates engagements; just respect the new column.
**Data.** Add `engagements.autopay_method_id NULL` and `autopay_paused_until DATE NULL`.

### 2.3 Dedicated profile page — Phase 16 #21 (small)

**Why.** Identity, alt contacts, and sessions are currently scattered between `AltContacts.tsx` and the implicit "Switch" page.
**UI.** Single `Profile.tsx` route consolidating: identity (read-only name/email/phone), preferred login method, alt contacts table with verify flow, active sessions list with revoke, "Sign out everywhere" action.
**Server.** Sessions endpoint already exists for staff app; reuse with `client_session` scope.

### 2.4 Browser-based file preview + share — internal #22 (medium)

**Why.** Today clients have to download a file to read it, then re-upload to forward it to a CPA, bank, or attorney. Both are friction.
**UI.**

- **Preview** — inline PDF viewer with toolbar (page nav, download, share). Renders via PDF.js for `application/pdf`; for other types, server returns a watermarked PNG render or a "Download to view" fallback.
- **Share** — a per-file share-link generator with controls for: recipient emails (firm-bounded auto-complete), access level (view-only / download), expiry (24h / 7d / 30d / never), require sign-in toggle, optional note. Generates a signed URL with per-share encryption key.
  **Server.** New table `file_shares` (id, file_id, created_by_access_id, recipients JSONB, access_level, expires_at, encryption_key_wrapped, require_login). New endpoint `GET /shared/:token` that decrypts on demand and logs access.
  **Data.** Already in `files` table; new `file_shares` + `file_share_events` (for audit log).

### 2.5 Engagement status board on Overview — Phase 16+ (medium)

**Why.** Clients want to know "where do I stand?" on every active engagement without asking. The firm sees this in the staff app; the portal does not.
**UI.** Overview gains an "Engagement status" card listing each active engagement with: name, period, partner, status pill (in-progress / awaiting-client / scheduled / filed / blocked), progress bar, next milestone + due date, last activity, "awaiting from you: N items" badge when applicable.
**Server.** Compute from existing `engagements`, `engagement_milestones`, and `request_lists`. New endpoint `GET /api/portal/engagements/active` returning a denormalized view.
**Data.** Add `engagements.next_milestone_id` and `engagements.next_milestone_due_at` for fast read; existing tables otherwise.

### 2.6 Upcoming appointments — Phase 16+ (medium)

**Why.** The firm books calls via their scheduler; the client gets an email and possibly a calendar invite. The portal has nothing.
**UI.** Overview gains an "Upcoming appointments" card showing the next 3 with date block (Mon/22/Tue), title, time + duration, attendees (lead + others), location (video / in-person / phone), and per-row actions: **Join** (video), **Accept** (RSVP pending), **Reschedule** (if the firm allows). Full Appointments screen lists upcoming + past with the same row, an agenda summary, and a "Book new" button that opens the firm's availability picker.
**Server.** Either:

- (a) **Read-only mirror** — firm syncs from Google Calendar / Microsoft 365 / Calendly via webhook into `appointments`. Portal reads only.
- (b) **First-party** — Vibe owns appointment booking. Defer to a later phase; (a) ships first.
  **Data.** New `appointments` table (client_id, partner_id, title, type ENUM('video','in_person','phone'), start_at, duration_min, location, agenda JSONB, attendees JSONB, rsvp_state, ics_uid, cal_source).

### 2.7 Upcoming tax payments — Phase 16+ (medium, **flagship feature**)

**Why.** This is the #1 friction in any tax engagement — clients miss estimated payments, then get IRS letters and blame the firm. Putting due dates + amounts + the right pay-link on the portal eliminates an entire support category.
**UI.** Overview gains an "Upcoming tax payments" card; full screen lists upcoming + past.

- **Row anatomy.** Urgency-colored left border (red <0 days, yellow ≤7, blue ≤30, neutral otherwise) · name · authority + form code + due date · "in Nd" / "Nd late" · amount · **Pay at [agency portal]** external link.
- **Critical disclaimer** at top of screen: "Holland CPA does not collect tax payments. Pay each agency directly using the linked portals below — they are official government sites." Renders an `info` icon in every row.
- **Firm-files cases** (e.g. monthly sales tax) tagged with a green "firm files" pill — no Pay button, no action expected from client.
- **Confidence band.** Pills like "estimated" for Q3+ projections so clients don't anchor on imprecise numbers.
  **Server.** New `tax_payments` table populated by the firm (manually or from tax-prep software). The portal does **not** initiate payment — it only stores due date / amount / pay URL.
  **Data.** `tax_payments` (id, client_id, name, authority, form_code, period, due_date, amount_cents, payment_url, payment_label, payment_method_description, status ENUM('upcoming','firm_will_file','paid','skipped'), note, confidence ENUM('high','medium','low')).
  **Pay-link directory.** Maintain a curated list of authority → URL in a config file; common entries:
- IRS Direct Pay (`https://www.irs.gov/payments/direct-pay`)
- EFTPS (`https://www.eftps.gov`)
- MyTax Illinois (`https://mytax.illinois.gov`)
- Each state's portal — table maintained as part of release notes.

### 2.8 Proposals + Live Agreements — Phase 25 (large, **biggest scope-add**)

**Inspiration.** Anchor (`sayanchor.com`) — proposal → multi-tier select → sign → payment authorization in one flow, converting to a "live agreement" that drives recurring billing.

**Why now.** Today, new engagements require: (a) the firm sending a PDF letter, (b) the client signing and returning, (c) the firm chasing for ACH/card setup, (d) the firm manually creating recurring billing. Four steps, four points of failure, often a 2–4 week sales cycle. Anchor's flow collapses this to a single ~2-minute portal interaction.

**Screens.**

| Screen                 | Description                                                                                                                                                                                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proposals — list       | Open + signed proposals. Each row: title, subtitle, sentBy, tier count, sent-relative, expires                                                                                                                                                                                            |
| Proposal detail        | 4-step stepper: Review → Choose tier → Sign → Payment setup → Done                                                                                                                                                                                                                        |
| Step 1 — Review        | Cover note (paragraph from partner), "What's included" (4 bullets), Terms (cancellation, payment terms, processing fees, governing law)                                                                                                                                                   |
| Step 2 — Choose tier   | Side-by-side cards (1–4 tiers). Each card: name, tagline, price + cadence (month / one-time), annual savings vs à-la-carte (if applicable), recommended ribbon, checkmark list of included services (struck-out for excluded), radio select. Add-ons listed below (required vs optional). |
| Step 3 — Sign          | Pricing summary (recurring + one-time + due-at-signing breakdown), typed-name signature field rendering in serif italics, IP+timestamp+hash disclaimer.                                                                                                                                   |
| Step 4 — Payment setup | Method picker (existing saved method / new ACH / new card), Plaid instant-verify roadmap, "Authorize & activate" CTA, authorization summary panel.                                                                                                                                        |
| Step 5 — Done          | Welcome card + "What happens next" (1. letter filed in Files, 2. engagement appears on Overview, 3. auto-charge schedule, 4. open Requests if input needed) + live-agreement summary with hash + change log link.                                                                         |

**Live agreements.** Once signed, a proposal converts to a live agreement: a row in `agreements` that's the source of truth for the engagement's scope, pricing, and authorized payment method. **Editable** — partner can adjust scope, pricing, or terms post-signing; every change is written to a `change_log` table that both parties can review.

**Counter-propose.** A client can request a custom tier or modified scope without rejecting — kicks back to the partner with a typed note, partner amends and re-sends.

**Server.**

- New tables: `proposals` (id, client_id, title, subtitle, status, sent_at, expires_at, sent_by_user_id, cover_note, terms JSONB, signed_at, signed_by, signature_text, ip, agreement_hash), `proposal_tiers` (id, proposal_id, name, tagline, price_cents, price_cadence, annual_savings_cents, recommended, services JSONB), `proposal_addons` (id, proposal_id, name, price_cents, optional), `agreements` (id, client_id, proposal_id, selected_tier_id, status, autopay_method_id), `agreement_change_log` (id, agreement_id, changed_by_user_id, at, diff JSONB, note).
- New endpoints: `GET /api/portal/proposals`, `GET /api/portal/proposals/:id`, `POST /api/portal/proposals/:id/sign` (idempotent), `POST /api/portal/proposals/:id/counter`.
- Staff side: `POST /api/firm/proposals` (create), `PATCH /api/firm/agreements/:id` (with auto-logged diff).

**Payment authorization.** Reuse Stripe Setup Intents — the proposal sign flow creates a setup intent, the payment step confirms it, the resulting payment method is attached to the new agreement with `autopay` on by default.

### 2.9 Tax document viewer — Phase 16+ (medium, optional)

**Why.** Today tax returns are stored in Files like any other PDF. They're 14–40 pages, structured into form sections + schedules. Clients want a side rail with "Jump to K-1", "Jump to Schedule M-1".
**UI.** A dedicated viewer when `files.category = 'tax_return'`. Left rail with form sections (page anchors). Inline annotations for the firm's notes ("This year's M-1 adjustment was…").
**Server.** Page-index extraction during file ingest (Tika or pdf-parse). Index stored on `files.metadata`.
**Open question.** Not clear whether this earns its keep vs. just improving the generic PDF viewer (Phase 16+ #2.4) and adding bookmarks in-PDF. Defer until preview is shipped and we know.

### 2.10 Vibe Connect integration — Phases 21, 24 (cross-cutting)

The portal will gain two Connect-driven screens:

**Messages — Phase 21.**
Threaded messaging between client and partner. Falls back to email/SMS if Connect is not deployed at this firm. Thread anchors to invoices, engagements, requests, or appointments. **"Question this invoice"** button on invoice detail opens a pre-tagged thread.

**Requests (Request Lists) — Phase 24.**
Structured document/info checklists from the firm. Each item is `needed` / `submitted` / `done` / `revision` (with a typed note). Client responds via:

1. **Take photo** (mobile camera capture — best for paper docs)
2. **Upload file**
3. **Reply with note** (for text-only items)

Items + responses are end-to-end encrypted under the Connect conversation key. List metadata (titles, status, counts) is cleartext to enable nudges and progress bars.

Auto-nudges configurable by the firm (e.g. 72h / 24h / day-of). Respect SMS quiet hours from notification prefs.

Banner on Overview: "You have N items to respond to. Starting with [first list]." Matches Connect's `REQUESTS_CLIENT.md` phrasing.

### 2.11 Engagement letters — in-portal e-sign (Phase 16+, small)

**Why.** Today "Accept" records IP + timestamp. Add typed-name signature + drawn-signature field for v2+ engagements. Also: side-by-side redline against last accepted version when `version > 1`.
**UI.** Reuse the proposal sign-flow signature component. Add a tabbed redline view in the letter dialog.
**Server.** Store signature text + drawn-signature SVG + agreement hash.

### 2.12 PWA install + push notifications — Phase 26 (medium)

**Why.** Mobile native parity without app stores. Most clients check the portal from their phone.
**UI.** Subtle "Install" banner on mobile after 3 visits. iOS push uses Apple Push Web; Android via standard service worker.
**Server.** New `client_push_tokens` table; webpush library on the worker side; respect notification prefs.

### 2.13 Multi-entity consolidated view — Phase 16+ (medium)

**Why.** Today an identity with 3 entities switches between them. Most clients want a roll-up first: "I owe $X across all entities, here are open items by entity."
**UI.** Add a "Consolidated" pseudo-entity to the switcher. Overview shows totals across entities; clicking an entity-scoped row drills into that entity.
**Server.** Reuse existing endpoints with a `?scope=all_accessible` query.

### 2.14 Portal-side audit log — Phase 16+ (small)

**Why.** Today clients can't see what the firm has viewed/done on their behalf. SOC-2-flavored firms ask for this.
**UI.** Profile gains "Access history" — a paginated list of staff-initiated actions visible to the client (file uploads, file shares, payment-method changes, sign-in attempts).
**Server.** Filter the existing `audit_log` table to client-visible events.

### 2.15 AI summary — Phase 23 (small, depends on local LLM)

**Why.** Plain-English "here's where you stand" for clients who don't read financial statements.
**UI.** Overview gains an "AI summary" card — short paragraph generated by the local LLM, refreshed daily.
**Server.** Cron job per active client. Cache result for 24h. Strip PII before passing to model.

---

## 3. Phase mapping

| Phase             | Portal scope                                                                                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **16** (current)  | Login, overview, invoices, letters, files, payment methods, notifications, profile, switch — **shipped**                                                                                |
| **16 follow-ups** | Per-payment receipts (2.1), autopay per engagement (2.2), profile page (2.3), engagement letters e-sign (2.11)                                                                          |
| **16+ medium**    | File preview + share (2.4), engagement status (2.5), appointments (2.6), **tax payments (2.7)**, tax doc viewer (2.9 optional), multi-entity consolidated view (2.13), audit log (2.14) |
| **21**            | Vibe Connect Messages on portal                                                                                                                                                         |
| **23**            | AI summary (2.15)                                                                                                                                                                       |
| **24**            | Vibe Connect Requests on portal (2.10)                                                                                                                                                  |
| **25**            | **Proposals + Live Agreements** (2.8) — the biggest single addition                                                                                                                     |
| **26**            | PWA + push (2.12)                                                                                                                                                                       |

---

## 4. Open architectural questions

- **Tax payments — opt-in per engagement?** Some clients prefer their firm doesn't surface tax obligations at all. Default: surfaced; firm can hide per-client.
- **Proposals on which billing engine?** If the firm uses an external billing tool (QBO, Anchor itself), do we still own the proposal sign flow? Likely yes; we hand off the signed agreement + payment method to the external system.
- **Connect dependency.** Messages and Requests both require Connect to be deployed. Firms without Connect get a graceful fallback (email + SMS for messages; no Requests UI at all).
- **Tax-doc viewer ROI.** May be subsumed by generic preview improvements — re-evaluate after 2.4 ships.

---

## 5. Out of scope (deliberately)

These have been considered and **declined** for the portal:

- **Bookkeeping data view** — clients want to see their financial reports. The firm should send these as files; building a generic GL viewer is a separate product.
- **Tax return preparation flow** — clients should not prepare their own returns in this portal. Use the firm's tax software.
- **Time entry** — even if a client tracks their own hours, it doesn't belong here.
- **Native mobile app** — PWA covers this without two codebases.
