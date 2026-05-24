# Vibe Time & Billing — Proposal Module Build Plan (Addendum)

> **Status:** Addendum to the Vibe Time & Billing core build plan.
> **Module scope:** Full proposal-to-engagement lifecycle integrated into the existing `vibe-tb` appliance.
> **License:** Inherits Vibe Time & Billing core license.
> **Env prefix:** `VIBETB_` (proposal-specific vars: `VIBETB_PROPOSAL_*`)
> **DB schema:** `vibetb` (proposal-specific tables prefixed `proposal_`, `engagement_`, `request_*`)
> **Phase prefix:** `P##` (this addendum starts at P01; integrate into core plan sequencing as appropriate).
> **Cost to firms:** $0 — bundled with T&B core.

---

## §0. Foundation & Conventions (must read before P01)

### §0.1 Locked architectural decisions

| Area                              | Decision                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Tenancy                           | Single firm per appliance instance                                                                     |
| Stripe Connect mode               | **Standard** — firm owns its own Stripe account; Vibe takes 0%                                         |
| Payment methods                   | Full Payment Element: Card + ACH (Financial Connections) + Link + Apple/Google Pay                     |
| Billing schedules supported in v1 | (a) On-acceptance, (b) Recurring monthly, (c) On-completion milestone, (d) Split: deposit + recurring  |
| E-signature                       | OpenSign sidecar (AGPL) running inside the appliance                                                   |
| Proposal template engine          | Visual block editor (drag-drop sections)                                                               |
| Packaging                         | 3-tier package selector (Bronze/Silver/Gold) supported in proposals                                    |
| Services catalog                  | Flat list with firm-defined tags                                                                       |
| Service categories                | 6 hard-coded: Tax, Bookkeeping, Audit, Advisory, Payroll, CFO                                          |
| Renewal uplift                    | Three modes available, firm picks per engagement: (a) manual %, (b) realization-based, (c) CPI-indexed |
| Quick-bill                        | Ad-hoc invoice without proposal supported                                                              |
| Time-tracking                     | Time entries link to engagement; WIP-only (no auto-billing in v1)                                      |
| Client portal auth                | Magic-link **+** optional client account with password                                                 |
| Client portal domain              | Custom domain via firm's CNAME from day one                                                            |
| View tracking                     | Per-section view tracking                                                                              |
| Document storage                  | MinIO sidecar inside appliance, 7-year retention                                                       |
| PDF generation                    | Headless Chromium (Puppeteer) sidecar                                                                  |
| Email delivery                    | Multi-provider: SMTP / Postmark / EmailIt                                                              |
| SMS delivery                      | Multi-provider: Twilio / TextLink                                                                      |
| Client import                     | **Manual entry only** in v1 (no CSV, no QBO/Xero sync)                                                 |
| AI features                       | **None** in v1                                                                                         |
| Dashboard KPIs                    | Pipeline, MRR, renewals, cash flow, conversion funnel                                                  |

### §0.2 Explicitly deferred to v1.5/v2

These features were considered and intentionally deferred. **Do not build them in v1**; ensure schema/contracts leave room for them.

- Multi-signer with role-based signing (sign-only / pay-only / view-only) — _schema must support multiple signatures per proposal; UI is single-signer only_
- Mid-engagement amendments (one-click scope change with proration)
- PBC / Client Request List module
- QuickBooks Online sync (clients, invoices, payments, COA)
- Xero sync
- CSV client import
- AI features: scope-of-work drafting, pricing suggestions, renewal language, PBC anomaly detection
- Hosted/managed-instance offering
- Multi-tenant / multi-firm / multi-office support

### §0.3 Flags to revisit before kickoff

These were noted during Q&A. Decide before P01 begins.

1. **Multi-signer scope.** Partnership/S-corp/audit engagements often require ≥2 signers (engagement partner + officer; two partners; etc.). v1 single-signer-only is the locked decision, but: (a) schema must remain plural (`signatures` table, not a `signature_*` column on `proposals`); (b) acceptance portal hides the "add signer" UI but tolerates ≥1 row at the API layer; (c) document this so v1.5 only ships UI work.
2. **OpenSign AGPL × T&B core license.** OpenSign runs as a separate sidecar container reached over the network. AGPL applies to the OpenSign binary only; the network boundary keeps T&B core's BSL/PolyForm clean. Add a one-line note to `LICENSING.md`.
3. **Manual client entry friction.** A firm with 200 clients cannot hand-enter all of them. Consider an emergency one-night CSV import sprint inside P02 (low cost, high adoption value). Locked decision is "no sync" — confirm whether minimal CSV is in or out before P02 begins.
4. **No QBO sync means no GL export.** Firms running both Vibe T&B and Vibe MyBooks may expect proposal revenue to flow MyBooks → GL. Confirm whether MyBooks consumes T&B engagement data via a shared DB read, or whether QBO sync remains a v1.5 priority for non-MyBooks firms.

### §0.4 Conventions

- **Language stack:** React 18 + TypeScript + Vite (frontend), Node.js 20 + Express + Drizzle ORM (backend), PostgreSQL 16, Redis 7, BullMQ
- **Sidecars:** OpenSign, MinIO, Puppeteer-PDF, all in the same `docker compose` stack reachable on the internal `vibe_net` network
- **Containers:** distroless multi-stage builds, GHCR-published, image-signed via cosign
- **Monetary values:** BIGINT cents — never floats
- **Times:** UTC in DB, render in firm's timezone
- **IDs:** Use ULIDs (`ulid()` from `ulidx`) for all primary keys, except where Stripe ID strings (`cus_`, `sub_`, `pm_`, etc.) are the natural primary
- **Naming:** Snake-case in DB, camel-case in TS, kebab-case in URLs
- **Tests:** Vitest unit + Playwright e2e for every phase
- **Coverage gate:** ≥80% on new code per phase
- **Linting:** ESLint + Prettier + Drizzle Studio dry-run on every migration

---

## §1. Phase-by-phase build plan

Each phase has: **goal**, **dependencies**, **deliverables**, **checklist**, **acceptance criteria**, **complexity** (S/M/L/XL).

### P01 — Foundation & schema migration **[L]**

**Goal.** All proposal/engagement/payment/signature tables exist; migrations run cleanly forward and backward; seed data loads.

**Deps.** Vibe T&B core foundation must be present.

**Deliverables.**

- 20+ Drizzle migrations
- Seed data for 6 service categories
- README section on schema topology

**Checklist.**

- [ ] Create `proposals` table (status enum, totals, dates, brochure_jsonb)
- [ ] Create `proposal_versions` (immutable, content_jsonb, content_hash SHA-256)
- [ ] Create `proposal_line_items` (service_id, qty, unit_price_cents, billing_type, recurring_interval)
- [ ] Create `packages` and `package_services`
- [ ] Create `proposal_packages` (junction to track which packages a proposal offers)
- [ ] Create `services_catalog` (with `category` ENUM constrained to 6 values)
- [ ] Create `service_tags` and `service_tag_assignments`
- [ ] Create `terms_templates` and `proposal_terms_snapshot`
- [ ] Create `signatures` table (**plural design**) with all audit-trail fields
- [ ] Create `payment_mandates` (Stripe IDs, mandate_text_hash)
- [ ] Create `engagements` and `engagement_scope` (scope is frozen from accepted proposal)
- [ ] Create `engagement_deliverables`
- [ ] Create `stripe_subscriptions`, `stripe_invoices`, `stripe_customers` mapping tables
- [ ] Create `webhook_events` (PK = Stripe event ID, for idempotency)
- [ ] Create `proposal_activity` (event log for view/click/section tracking)
- [ ] Create `proposal_section_views` (per-section view tracking)
- [ ] Create `magic_links` (single-use tokens, expiry)
- [ ] Create `client_accounts` (optional password-based accounts)
- [ ] Create `firm_settings_proposals` (Stripe account ID, branding, notifications config)
- [ ] Create `quick_bills` (ad-hoc invoices not tied to a proposal)
- [ ] Create `renewals` (candidate engagements, uplift method, status)
- [ ] Create indexes on all FK columns + `proposal.status`, `engagement.status`, `engagement.client_id`
- [ ] Add `engagement_id` FK to existing `time_entries` table (T&B core)
- [ ] Seed 6 service categories with default COA-code placeholders
- [ ] Seed 1 default terms template per category
- [ ] Backward migration scripts for every forward migration

**Acceptance.** `pnpm drizzle migrate up && pnpm drizzle migrate down && pnpm drizzle migrate up` succeeds with no data loss on empty DB.

---

### P02 — Services catalog **[M]**

**Goal.** Firm staff can CRUD services with tags, prices, billing types, and category assignment.

**Deps.** P01.

**Checklist.**

- [ ] REST: `GET /v1/services`, `POST /v1/services`, `PATCH /v1/services/:id`, `DELETE /v1/services/:id`
- [ ] REST: `GET /v1/service-tags`, tag CRUD
- [ ] Services list UI with filter by category and tag
- [ ] Service editor with: name, description (markdown), default price (cents), billing_type, recurring_interval, category dropdown (6 hard-coded), tags multi-select, add-on flag, parent-service picker (for add-ons)
- [ ] Bulk-edit prices (% or flat-amount delta across selected services)
- [ ] Soft-delete (services in use by active engagements cannot be hard-deleted)
- [ ] Audit log entries on every change
- [ ] Vitest: CRUD coverage, validation rules
- [ ] Playwright: create-edit-delete-restore happy path

**Acceptance.** A firm user can create a "Monthly Bookkeeping" service tagged "Recurring/Bookkeeping" priced at $500/mo, list it, edit price, soft-delete, and restore.

---

### P03 — Packages (3-tier Bronze/Silver/Gold) **[M]**

**Goal.** Firms can define reusable packages, each containing a set of services with overrides.

**Deps.** P02.

**Checklist.**

- [ ] REST: package CRUD endpoints
- [ ] Package editor UI: name, tier label (free text but defaults to Bronze/Silver/Gold), position
- [ ] `package_services` editor: add/remove services to a package with optional `override_price_cents` and `included bool` (included vs add-on within a tier)
- [ ] Side-by-side 3-column preview showing pricing & inclusions across tiers
- [ ] Duplicate-package action
- [ ] Vitest: package math (sum of overrides, totals)
- [ ] Playwright: build 3-tier package, preview, edit, save

**Acceptance.** A firm builds a 3-tier "Small Business Tax" package showing $1,200 Bronze, $2,400 Silver, $4,800 Gold with itemized inclusions per tier.

---

### P04 — Visual block editor foundation **[XL]**

**Goal.** A working drag-drop proposal authoring canvas with a block-registry architecture so new block types are pluggable.

**Deps.** P02, P03.

**Checklist.**

- [ ] Choose drag-drop lib: **dnd-kit** (recommended) over react-dnd
- [ ] Block schema: `{ id, type, position, props: jsonb, visibility: { roles: [] } }`
- [ ] Block registry pattern: `registerBlock(type, { Editor, Renderer, defaultProps, validate })`
- [ ] Canvas component with vertical drop zones between blocks
- [ ] Block palette (right-rail) with drag sources
- [ ] Block inspector (left-rail) for editing selected block's props
- [ ] Block reorder, duplicate, delete
- [ ] Undo/redo (use `zundo` or hand-rolled with Zustand)
- [ ] Autosave to draft every 2s (debounced)
- [ ] Block-validation pipeline (every block validates its own props)
- [ ] Server endpoint to persist block tree to `proposals.brochure_jsonb` and `proposal_line_items` (services blocks materialize line items)
- [ ] Vitest: block registry, validation, reordering math
- [ ] Playwright: drag a block, edit props, reorder, save, reload, verify persistence

**Acceptance.** A firm user opens a new proposal, drags 5 blocks onto the canvas, edits each, reorders one, saves, refreshes, and sees identical state.

---

### P05 — Block types (the seven essential blocks) **[L]**

**Goal.** All seven core block types implemented end-to-end (editor + renderer + props schema).

**Deps.** P04.

**Checklist.**

- [ ] **Cover/Intro block**: title, subtitle, hero image upload, firm logo
- [ ] **Markdown text block**: rich text with `{{ client.name }}` style merge tokens (mustache syntax, evaluated server-side at send time)
- [ ] **Video embed block**: YouTube/Vimeo/Loom URL parser, responsive iframe
- [ ] **Services list block**: pick services from catalog, configure qty/override price, optional/required toggle
- [ ] **Package selector block**: pick a package, render 3 tiers side-by-side, client picks one
- [ ] **Terms block**: bound to a `terms_template_id`, rendered as Markdown→HTML with merge tokens
- [ ] **Signature block**: typed-name pad + acceptance checkbox + payment-method trigger
- [ ] Per-block render mode: editor (firm view), preview (firm view of client perspective), portal (client view)
- [ ] Merge-token resolver utility (recursive on `props`)
- [ ] Vitest per block: validation, merge-token resolution, edge cases (empty package, no services, etc.)
- [ ] Playwright: build a proposal using all 7 blocks, preview, send (mocked email)

**Acceptance.** A complete proposal with all 7 block types renders identically in editor preview and the client portal.

---

### P06 — Proposal versioning & immutable snapshots **[M]**

**Goal.** Every "send" or "accept" event creates an immutable version with a content hash. Versions can be diffed.

**Deps.** P04.

**Checklist.**

- [ ] Canonical JSON serializer (sorted keys, no whitespace, deterministic)
- [ ] SHA-256 hashing of canonical JSON → `content_hash`
- [ ] `POST /v1/proposals/:id/versions` creates an immutable snapshot row
- [ ] On `send`: snapshot v1 if none exists; on subsequent edits, draft mutates but version remains frozen
- [ ] On `accept`: snapshot final version, terms version, mandate text — all hashes persisted to `signatures`
- [ ] Diff UI: side-by-side block comparison between two versions
- [ ] Versions list (firm-only)
- [ ] Vitest: canonical hashing determinism, edge cases (Unicode, nested objects)

**Acceptance.** Editing a sent proposal does not retroactively change what the client originally saw — the v1 hash matches the served snapshot byte-for-byte.

---

### P07 — Terms template library **[M]**

**Goal.** Firms manage reusable engagement-letter terms templates with versioning and merge tokens.

**Deps.** P01.

**Checklist.**

- [ ] REST CRUD for `terms_templates`
- [ ] Markdown editor with merge-token autocomplete: `{{ client.* }}`, `{{ firm.* }}`, `{{ engagement.* }}`, `{{ today }}`
- [ ] Per-template `version` increments on every save
- [ ] Default-template assignment per service category (6 categories → 6 default templates)
- [ ] Seed templates: 6 starter templates (Tax, Bookkeeping, Audit, Advisory, Payroll, CFO) using widely-accepted CPA engagement-letter language
- [ ] Disclaimer banner: "These templates are starting points — review with your professional liability carrier before use"
- [ ] Vitest: merge-token resolution, version increments
- [ ] Playwright: create template, use in proposal, render

**Acceptance.** A firm creates a custom "Quarterly Bookkeeping" template, uses it in a proposal, sees client-portal render with merged client/firm data.

---

### P08 — Stripe Connect Standard OAuth **[L]**

**Goal.** Firm onboards its Stripe account via OAuth; appliance stores the connected `stripe_account_id`; account status is monitored.

**Deps.** P01.

**Checklist.**

- [ ] Register OAuth client in Stripe dashboard (test + live)
- [ ] `GET /v1/stripe/connect/authorize` → redirects to Stripe OAuth with CSRF state
- [ ] `GET /v1/stripe/connect/callback` → exchanges code, stores `stripe_account_id` and `stripe_publishable_key` (Standard exposes both)
- [ ] Account status check: `GET /v1/accounts/:id` on Stripe → display capabilities (card, ach_debit, link)
- [ ] `account.updated` webhook → refresh capabilities cache
- [ ] Disconnect flow with confirmation (does NOT delete subscriptions; just severs OAuth)
- [ ] Firm-settings UI showing: connected account, capabilities, business profile, payouts schedule
- [ ] Vitest: OAuth state CSRF
- [ ] Playwright: full connect → disconnect → reconnect happy path (Stripe test mode)

**Acceptance.** A firm clicks "Connect Stripe," completes OAuth in Stripe test mode, and sees their account email + capabilities displayed in Vibe.

---

### P09 — Stripe Payment Element integration **[L]**

**Goal.** Embed Stripe Payment Element in the client acceptance portal, supporting Card + ACH + Link + Apple/Google Pay.

**Deps.** P08.

**Checklist.**

- [ ] `POST /v1/portal/p/:token/setup-payment` returns `SetupIntent.client_secret` scoped to firm's connected account
- [ ] React `@stripe/react-stripe-js` integration with `Elements` provider keyed to firm's publishable key
- [ ] `PaymentElement` mounted with `payment_method_types: ['card', 'us_bank_account', 'link']`, `appearance` theme matching firm branding
- [ ] Apple Pay / Google Pay domain verification setup script (`stripe.com/.well-known/apple-developer-merchantid-domain-association`)
- [ ] Mobile-first responsive layout (test on iOS Safari, Android Chrome)
- [ ] Error handling: declined card, insufficient permissions, blocked country
- [ ] 3DS challenge handling
- [ ] Vitest: SetupIntent creation
- [ ] Playwright: card success (Stripe test card 4242 4242 4242 4242), card decline (4000 0000 0000 0002)

**Acceptance.** Test card submission succeeds; PaymentMethod is attached to a Customer on the firm's connected account; mandate state stored.

---

### P10 — ACH Direct Debit + Financial Connections **[L]**

**Goal.** ACH bank-account payments verified instantly via Financial Connections, with microdeposit fallback. Nacha-compliant mandate text captured.

**Deps.** P09.

**Checklist.**

- [ ] Enable `us_bank_account` in `PaymentElement`
- [ ] Configure Financial Connections session with `permissions: ['payment_method']`
- [ ] Display Stripe's default mandate text before submit; capture verbatim text + version into `payment_mandates.mandate_text_rendered`
- [ ] Hash mandate text (SHA-256) → `payment_mandates.mandate_text_hash`
- [ ] Manual entry fallback → microdeposit verification webhook handler
- [ ] State machine for mandate: `pending_verification → active → invalid → revoked`
- [ ] `mandate.updated` webhook handler updates DB
- [ ] `payment_method.automatically_updated` handler for bank-account rotation
- [ ] Email/SMS notification to firm + client when mandate becomes invalid
- [ ] Vitest: mandate hash determinism, state-machine transitions
- [ ] Playwright with Stripe FC test mode: connect bank → verify → mandate active

**Acceptance.** Test ACH flow: client connects bank via FC test institution, mandate moves to `active`, mandate text and hash persist, webhook updates trigger DB state changes.

---

### P11 — Stripe Billing: subscriptions, invoices, deposits **[L]**

**Goal.** On proposal acceptance, Stripe Customer + initial Invoice (deposit) + Subscription (recurring) all created atomically.

**Deps.** P09, P10.

**Checklist.**

- [ ] On-acceptance handler: idempotent Stripe API sequence
- [ ] Step 1: get-or-create `Customer` (key on email + firm-internal client ID)
- [ ] Step 2: attach `PaymentMethod` from acceptance, set as default
- [ ] Step 3: create `Price` objects from `engagement_scope` line items (one Price per recurring line)
- [ ] Step 4: create one-time `Invoice` for deposit line(s), finalize, pay
- [ ] Step 5: create `Subscription` with `billing_cycle_anchor` set to next month-start, `default_payment_method` attached, `proration_behavior: 'none'`
- [ ] Persist `stripe_customer_id`, `stripe_subscription_id`, `stripe_invoice_ids[]` → engagement mapping
- [ ] Handle Stripe rate-limit (429) with exponential backoff
- [ ] Idempotency key: `engagement-{ulid}-accept-v1` so retries are safe
- [ ] Vitest: full sequence with Stripe mock
- [ ] Playwright (Stripe test mode): full flow card + ACH

**Acceptance.** Test acceptance with deposit + monthly recurring produces: 1 paid Invoice (deposit), 1 active Subscription, 0 duplicate Customers on retry.

---

### P12 — Stripe webhook receiver (BullMQ) **[L]**

**Goal.** All payment events processed idempotently via BullMQ worker; failed handlers retry with backoff; dead-letter queue exists.

**Deps.** P08.

**Checklist.**

- [ ] `POST /v1/stripe/webhook` endpoint with raw-body parsing
- [ ] Signature validation using `stripe.webhooks.constructEvent` (NEVER trust unsigned)
- [ ] Idempotency: insert event ID into `webhook_events`, skip if duplicate
- [ ] Enqueue to BullMQ `stripe-webhooks` queue with event payload
- [ ] Worker handlers for: `invoice.paid`, `invoice.payment_failed`, `invoice.finalized`, `customer.subscription.created/updated/deleted`, `payment_method.attached/detached/automatically_updated`, `mandate.updated`, `payout.paid`, `payout.failed`, `charge.dispute.created`, `account.updated`, `setup_intent.succeeded`
- [ ] Failed handler retries: 3 attempts with exponential backoff (1s/10s/60s)
- [ ] Dead-letter queue with alert to firm on persistent failures
- [ ] Vitest: signature validation, idempotency, handler routing
- [ ] Playwright (Stripe CLI): trigger each event type, assert DB mutation

**Acceptance.** Replaying the same webhook 10× causes exactly one DB mutation; webhook outage queue drains cleanly on recovery.

---

### P13 — MinIO sidecar (document storage) **[M]**

**Goal.** MinIO runs as a sidecar; signed proposals/PDFs/invoices stored with 7-year retention; firm can export bucket.

**Deps.** P01.

**Checklist.**

- [ ] Add MinIO to `docker-compose.yml` with persistent volume
- [ ] Bucket-per-firm structure: `vibetb-{firm_slug}/{year}/{engagement_id}/`
- [ ] Bucket lifecycle policy: 7-year retention, then archive flag (don't auto-delete — CPA compliance varies)
- [ ] Object-lock on signed PDFs (`COMPLIANCE` mode, retention 7y)
- [ ] Server-side encryption (SSE-S3 with appliance-managed key)
- [ ] Pre-signed URL generation for client/firm downloads (15-minute TTL)
- [ ] S3 client wrapper in `@vibe/storage` package (also usable by other Vibe apps)
- [ ] Backup hook: nightly mc-mirror to external S3 if configured
- [ ] Health check endpoint
- [ ] Vitest: upload, retention enforcement, pre-signed URL expiry
- [ ] Docs: how to rotate the master key, how to migrate to external S3

**Acceptance.** Uploaded signed PDF cannot be deleted before 7-year retention; pre-signed URL expires correctly; backup to external S3 verified.

---

### P14 — Puppeteer PDF sidecar **[M]**

**Goal.** HTML→PDF rendering service running as a sidecar; proposals, signed engagement letters, and invoices render to PDF.

**Deps.** None (can run in parallel with P02-P11).

**Checklist.**

- [ ] Puppeteer sidecar (Alpine + Chromium) with concurrency limit (4 workers default)
- [ ] Internal HTTP API: `POST /render { html, options }` → returns PDF bytes
- [ ] Watermarking: "DRAFT" diagonal on unsigned proposals, "SIGNED ON YYYY-MM-DD HH:MM UTC" footer on signed
- [ ] Custom fonts mounted from volume (firm-supplied brand font optional)
- [ ] Page size, margins, headers/footers configurable
- [ ] Print CSS in proposal renderer
- [ ] Render queue with timeout (30s) → fall back to error PDF
- [ ] Vitest: render service health
- [ ] Playwright: render a proposal, validate PDF bytes are well-formed

**Acceptance.** A signed proposal renders to a clean PDF with watermark, footer, and consistent typography on multiple devices' previews.

---

### P15 — OpenSign sidecar integration **[L]**

**Goal.** OpenSign runs in the appliance; Vibe creates documents, requests signatures, retrieves completion certificates.

**Deps.** P13, P14.

**Checklist.**

- [ ] OpenSign added to `docker-compose.yml` (matches OpenSign's official compose with internal-only ports)
- [ ] OpenSign points at the appliance's Postgres (separate `opensign` schema) and MinIO (separate `opensign-docs` bucket)
- [ ] Server-to-server auth between Vibe backend and OpenSign API (shared secret, never exposed to clients)
- [ ] `ESignProvider` interface in `@vibe/esign` package with `createEnvelope`, `embedSign`, `getStatus`, `downloadSigned`, `getCertificate`
- [ ] Implementation: `OpenSignProvider` wrapping internal HTTP API
- [ ] Implementation stub: `NativeProvider` (typed-name only, fallback for low-stakes use)
- [ ] Firm-settings toggle: "E-Signature provider: OpenSign (recommended) / Native"
- [ ] Webhook from OpenSign → BullMQ → updates `signatures` table
- [ ] Completion certificate stored to MinIO with object-lock
- [ ] AGPL note in `LICENSING.md`: OpenSign is a separate sidecar reachable over the network; AGPL applies to OpenSign binary only
- [ ] Vitest: provider interface compliance
- [ ] Playwright: send proposal → client signs in OpenSign → certificate retrieved

**Acceptance.** A client signs a proposal via the embedded OpenSign flow, the completion certificate appears in MinIO with object-lock, and the `signatures` row links to it.

---

### P16 — Signature audit trail & HMAC tamper-evidence **[M]**

**Goal.** Each signature event is tamper-evident via per-firm HMAC; full chain-of-evidence stored.

**Deps.** P15.

**Checklist.**

- [ ] Generate per-firm HMAC key on first proposal send (stored in firm-secrets vault, never logged)
- [ ] On signature event: compute HMAC over canonical signature record JSON (including all hashes, timestamps, IPs)
- [ ] Persist `hmac_signature` on `signatures` row
- [ ] Verification endpoint: `GET /v1/signatures/:id/verify` → recomputes HMAC, returns ok/tampered
- [ ] Audit-trail export endpoint: signed JSON + PDF certificate + proposal version snapshot, all in one zip
- [ ] Court-ready evidence package generator (firm-side, one-click)
- [ ] Vitest: HMAC determinism, tamper-detection
- [ ] Docs: legal evidence guide for firms (ESIGN/UETA four-element walkthrough)

**Acceptance.** A signature record can be exported as a tamper-evident evidence package; manual modification of any field invalidates the HMAC on re-verification.

---

### P17 — Magic-link auth for client portal **[M]**

**Goal.** Single-use, short-lived magic-link tokens that grant access to a specific proposal or engagement.

**Deps.** P01.

**Checklist.**

- [ ] `magic_links` table: token (UUID), proposal_id or engagement_id, expires_at, used_at, ip_used, ua_used
- [ ] Token generation: 256-bit random, base64url
- [ ] Token validation middleware on `/v1/portal/*` routes
- [ ] Single-use enforcement (one click = consumed; subsequent clicks require fresh link or login)
- [ ] Default expiry: 30 days for proposals, 90 days for engagements
- [ ] Rate limit: 10 link requests per IP per hour
- [ ] Resend-link flow (firm UI button to mint a new one)
- [ ] Mobile-friendly portal landing page
- [ ] Vitest: token entropy, expiry, single-use
- [ ] Playwright: link issued, clicked, consumed, second click fails

**Acceptance.** A magic link works exactly once, expires correctly, and a resent link supersedes the prior one.

---

### P18 — Optional client account (password) **[M]**

**Goal.** Clients can convert a magic-link session into a persistent account with email + password, retaining access to all their proposals/engagements/invoices.

**Deps.** P17.

**Checklist.**

- [ ] `client_accounts` table: email, password_hash (Argon2id, matches existing Vibe Connect pattern), created_at, last_login_at, mfa_secret null
- [ ] "Create account" prompt in portal after successful proposal action
- [ ] Standard login flow at `/portal/login`
- [ ] Password reset via email link (reuse magic-link infra)
- [ ] Account merges with magic-link history (email match)
- [ ] Optional TOTP MFA (defer to v1.5 if needed; schema present in v1)
- [ ] Logout, session refresh
- [ ] Rate-limited login attempts (5/15 min per IP+email)
- [ ] Vitest: Argon2 verification, login/logout, password reset
- [ ] Playwright: magic-link → create account → logout → login → access prior proposal

**Acceptance.** A client who created an account can log in 60 days later and see every prior proposal/engagement without needing a new magic link.

---

### P19 — Custom domain CNAME + Caddy on-demand TLS **[L]**

**Goal.** Each firm points `portal.firmdomain.com` at the appliance via CNAME; Caddy on-demand provisions a Let's Encrypt cert automatically; portal renders branded per firm.

**Deps.** Vibe T&B core must use Caddy as ingress (per existing Vibe appliance pattern).

**Checklist.**

- [ ] Caddy on-demand TLS configured with `ask` endpoint pointing to Vibe backend
- [ ] `GET /v1/internal/caddy-ask?domain=...` → returns 200 if domain is configured for a firm, 403 otherwise
- [ ] Firm-settings UI: "Custom portal domain" → input + DNS verification instructions
- [ ] DNS verification: TXT record check + CNAME check before activating
- [ ] Per-firm branding (logo, primary color, accent color) keyed off `Host` header
- [ ] Fallback: appliance default domain `portal-default.{appliance_domain}` for firms that don't set CNAME
- [ ] Cert renewal monitoring (alert if cert <14 days from expiry and renewal failing)
- [ ] Rate-limit on `caddy-ask` to prevent abuse
- [ ] Vitest: ask-endpoint authorization
- [ ] Manual test (cannot fully automate without DNS): document the setup runbook

**Acceptance.** A firm CNAMEs `portal.acmecpa.com` to the appliance, Caddy provisions cert within 2 minutes, portal loads with firm branding.

---

### P20 — Client portal: proposal viewing + section tracking **[L]**

**Goal.** Clients open a magic-linked proposal, view it section-by-section, and every section view + interaction is tracked.

**Deps.** P05, P17, P19.

**Checklist.**

- [ ] `GET /v1/portal/p/:token` returns rendered proposal (HTML, mobile-first)
- [ ] Sectioned rendering matching the block tree
- [ ] IntersectionObserver-based view tracking — fire `POST /v1/portal/p/:token/view` with `section_block_id` and `dwell_ms` when section enters viewport ≥50% for ≥1s
- [ ] First-open event fires `proposal_activity.opened`
- [ ] Per-section view records persist to `proposal_section_views`
- [ ] Idle timeout (5 min) ends a view session
- [ ] Privacy: only IP, UA, timestamps tracked (no fingerprinting beyond Stripe's needs)
- [ ] Mobile responsive
- [ ] Print-friendly stylesheet
- [ ] Vitest: view aggregation queries
- [ ] Playwright: open proposal, scroll through 5 sections, assert 5 view records

**Acceptance.** Firm dashboard can show "Client viewed sections 1, 2, 4, then bailed" with dwell time per section.

---

### P21 — Client portal: acceptance flow **[L]**

**Goal.** Client selects package (if any), signs, attaches payment method, all atomically.

**Deps.** P09, P10, P11, P15, P20.

**Checklist.**

- [ ] Package selector UI when `proposal_packages` rows exist
- [ ] Terms scroll-to-bottom + checkbox gate
- [ ] Signature pad (typed name) + acknowledgment checkbox
- [ ] Stripe Payment Element below signature
- [ ] On submit: server transaction creates signature row, mandate row, Stripe customer/PM/invoice/subscription, engagement, freezes proposal version
- [ ] Rollback on any failure (Stripe creates are partial-rollback compatible via idempotency)
- [ ] Success page: receipt + downloadable signed PDF + "what happens next"
- [ ] Email + SMS confirmation to both firm and client
- [ ] Vitest: transaction integrity
- [ ] Playwright: full happy-path acceptance with Stripe test mode

**Acceptance.** A client clicks accept → all 6 server-side records created, all confirmations sent, signed PDF in MinIO.

---

### P22 — Engagement lifecycle & scope freezing **[M]**

**Goal.** On acceptance, an engagement is born with a frozen scope copy; engagement has its own state machine independent of the proposal.

**Deps.** P21.

**Checklist.**

- [ ] On acceptance handler: copy `proposal_line_items` → `engagement_scope` with all relevant fields (immutable)
- [ ] `engagements.status` state machine: `active → paused → churned | completed | renewed`
- [ ] State transitions require reason codes (logged)
- [ ] Pause: Stripe subscription paused
- [ ] Resume: Stripe subscription resumed with prorated catch-up option
- [ ] Cancel: Stripe subscription canceled, engagement → `churned`
- [ ] Complete (for on-completion engagements): final invoice fired, engagement → `completed`
- [ ] Engagement detail UI showing scope, signatures, invoices, payments, time entries
- [ ] Vitest: state-machine transitions
- [ ] Playwright: pause + resume cycle

**Acceptance.** An engagement can be paused, resumed, and the Stripe subscription state matches at each step.

---

### P23 — Time-tracking → engagement WIP **[M]**

**Goal.** Time entries from T&B core link to an engagement and roll up as WIP (no auto-bill).

**Deps.** P22, T&B core time-tracking module.

**Checklist.**

- [ ] Add `engagement_id` FK on `time_entries` (P01 already did this)
- [ ] Time-entry editor in T&B core: engagement picker (dropdown filtered to active engagements for the selected client)
- [ ] WIP rollup view: per engagement, total hours × rate, broken down by user and service
- [ ] Realization view: WIP $ vs billed $ (fixed-fee engagements show realization %; T&M engagements show 100% by definition)
- [ ] Export to CSV
- [ ] Vitest: rollup math, realization calc
- [ ] Playwright: log time, view WIP, see realization update

**Acceptance.** A firm logs 10 hours on a fixed-fee engagement; WIP view shows the dollar amount and realization % against the fixed fee.

---

### P24 — Quick-bill (ad-hoc invoice) **[M]**

**Goal.** Firm creates a one-off invoice for a client without going through a proposal.

**Deps.** P11.

**Checklist.**

- [ ] `POST /v1/quick-bills` endpoint
- [ ] Quick-bill UI: pick client, add line items (description, amount, qty), optionally select existing PaymentMethod or send to client for new one
- [ ] Two modes: (a) charge existing PaymentMethod immediately, (b) send invoice link to client
- [ ] Renders to PDF via Puppeteer sidecar
- [ ] Tracks in `quick_bills` table
- [ ] Counts in MRR/cash flow dashboards
- [ ] Vitest: invoice creation, charge flow
- [ ] Playwright: quick-bill against existing PaymentMethod, then via link

**Acceptance.** A firm can create and collect on a $250 quick-bill in under 60 seconds against an existing client with a stored ACH mandate.

---

### P25 — Renewal engine (3 uplift modes) **[L]**

**Goal.** Annual engagements surface for renewal 30/60/90 days out; firm picks uplift mode per engagement; bulk-send supported.

**Deps.** P22.

**Checklist.**

- [ ] Renewal candidate detector (nightly BullMQ job): engagements with `ends_on` within 90 days and `status = active`
- [ ] Three uplift calculators:
  - [ ] **Manual %**: firm enters a per-engagement percentage
  - [ ] **Realization-based**: pulls prior-period realization, suggests uplift to bring realization to firm's target (e.g., target 100% if last year was 80% → +25%)
  - [ ] **CPI-indexed**: fetches latest BLS CPI-U (cached, refreshed monthly) and applies year-over-year delta
- [ ] Renewal UI: list of candidates, suggested uplifts, per-engagement override, bulk preview
- [ ] Bulk send: generates new proposal for each, sends magic links
- [ ] New proposals reference the prior engagement (`renewed_from_engagement_id`)
- [ ] Auto-renewal toggle per engagement (skips proposal, just rolls subscription with uplift on anniversary) — gated behind client's prior consent in original engagement letter
- [ ] Vitest: each uplift calculator
- [ ] Playwright: full renewal cycle

**Acceptance.** 30 engagements ending in next 60 days are renewed in 3 minutes via bulk-send with CPI uplift.

---

### P26 — Email delivery: multi-provider **[M]**

**Goal.** Firm picks SMTP, Postmark, or EmailIt; same templates work across providers.

**Deps.** P01.

**Checklist.**

- [ ] `EmailProvider` interface: `send(to, subject, html, text, headers, attachments)`
- [ ] Implementations: `SmtpProvider` (nodemailer), `PostmarkProvider`, `EmailItProvider`
- [ ] Firm-settings UI: provider picker, credentials capture, "send test email" button
- [ ] Encrypted credential storage (AES-256-GCM with appliance master key)
- [ ] Templates: proposal sent, viewed reminder, expiring soon, accepted (firm + client), declined, payment received, payment failed, mandate invalid, renewal upcoming
- [ ] All templates Markdown source + variable merge tokens
- [ ] Per-firm template overrides
- [ ] Bounce/complaint webhook handlers (Postmark/EmailIt)
- [ ] Vitest: provider interface, template rendering
- [ ] Manual: send test email to each provider

**Acceptance.** A firm configures EmailIt, sends a proposal, the client receives the email with merged data and a working link.

---

### P27 — SMS delivery: Twilio + TextLink **[M]**

**Goal.** Firm picks Twilio or TextLink for SMS reminders; opt-in/opt-out tracked.

**Deps.** P26.

**Checklist.**

- [ ] `SmsProvider` interface: `send(toPhone, body)`
- [ ] Implementations: `TwilioProvider`, `TextLinkProvider`
- [ ] Firm-settings UI: provider picker, credentials, sender number/sender ID
- [ ] Per-client opt-in: capture at first acceptance ("Send me SMS reminders for invoices and renewals" toggle)
- [ ] Per-client opt-out via STOP keyword reply (Twilio handles natively; TextLink requires manual handler)
- [ ] SMS templates (short, ≤160 chars): proposal reminder, payment failed, mandate invalid, signed receipt
- [ ] Suppress sending to opted-out numbers (DB check before send)
- [ ] Vitest: provider interface
- [ ] Manual: send test SMS via each provider

**Acceptance.** SMS reminders go out to opted-in clients only; STOP reply is honored on next send attempt.

---

### P28 — Dashboard: pipeline + conversion funnel **[M]**

**Goal.** Firm dashboard shows proposal lifecycle KPIs at a glance.

**Deps.** P20, P21, P22.

**Checklist.**

- [ ] Pipeline view: kanban-style columns (Draft, Sent, Viewed, Pending Signature, Pending Payment, Accepted, Declined, Expired)
- [ ] Drag between status columns (where state-machine permits)
- [ ] Filters: date range, service category, value range, owner
- [ ] Conversion funnel chart: sent → viewed → started signing → accepted, with drop-off %
- [ ] Time-to-sign median + p90
- [ ] Top abandoners (proposals viewed but never signed, sorted by $ value)
- [ ] Stale alert: proposals "Viewed" >7 days with no action
- [ ] Vitest: aggregation queries
- [ ] Playwright: kanban drag, filter apply

**Acceptance.** A firm sees "23 sent this month, 18 viewed (78%), 12 signed (52% of sent, 67% of viewed), median 2.3 days to sign."

---

### P29 — Dashboard: MRR + cash flow + renewals **[M]**

**Goal.** Recurring revenue, cash flow, and renewal pipeline visible.

**Deps.** P11, P22, P25.

**Checklist.**

- [ ] MRR widget: current MRR, MoM delta, new MRR, churned MRR, net MRR, broken down by service category
- [ ] Cash flow widget: next 30/60/90 day projected collections, scheduled Stripe payouts, recent payouts
- [ ] Failed payment widget: list of invoices in `payment_failed` with retry status
- [ ] Mandate health widget: count of `invalid` mandates needing re-collection
- [ ] Renewal widget: engagements ending 30/60/90, suggested uplift, "send renewal" CTA per row
- [ ] Annual revenue forecast (current MRR × 12 + on-completion pipeline)
- [ ] Drill-down from each widget to underlying records
- [ ] Vitest: rollup math, edge cases (pro-rated months, mid-month starts)
- [ ] Playwright: dashboard load, drill-down

**Acceptance.** A firm running 60 engagements sees an accurate MRR figure and a forecast within 1% of actual the following month.

---

### P30 — Hardening, packaging, release **[L]**

**Goal.** Production-ready: security, observability, Docker compose, GHCR, docs.

**Deps.** All prior phases.

**Checklist.**

- [ ] Rate limits on all public portal endpoints (per-IP and per-token)
- [ ] CSRF protection on all firm-side state-changing endpoints
- [ ] Content Security Policy headers on portal
- [ ] No-PII-in-logs audit (search codebase for `console.log` containing user fields)
- [ ] Structured logging via Pino with redaction of sensitive fields
- [ ] OpenTelemetry traces on critical paths (proposal-send, acceptance, webhook handler)
- [ ] Health/readiness endpoints for all sidecars
- [ ] Migrations-on-boot guard (refuse to start if pending migrations exist)
- [ ] Backup runbook: Postgres + MinIO + OpenSign data
- [ ] Disaster-recovery test: nuke appliance, restore from backup, verify proposal/signature integrity
- [ ] Docker compose `vibe-tb` stack with all sidecars, Caddy, healthchecks
- [ ] Distroless multi-stage Docker images for vibe-tb backend + frontend
- [ ] Cosign image signatures
- [ ] GHCR publishing pipeline (semver tags)
- [ ] README: 10-minute install guide
- [ ] LICENSING.md updates (T&B core license + OpenSign AGPL boundary note)
- [ ] SECURITY.md: PCI SAQ A posture, ESIGN/UETA compliance, 7-year retention guarantee
- [ ] CHANGELOG.md
- [ ] Vitest + Playwright full suite green
- [ ] Coverage ≥80% on new code
- [ ] Manual smoke test: create firm, connect Stripe, send proposal, client accepts, engagement runs, invoice paid, dashboards reflect — all in <30 minutes from fresh appliance

**Acceptance.** A user can clone the repo, run `docker compose up`, complete the OAuth + DNS setup, and process a real proposal through to paid engagement.

---

## §2. Exit criteria (v1.0 release)

The Proposal Module is **v1.0-ready** when all of the following are true:

1. All 30 phases pass acceptance criteria.
2. End-to-end smoke test: fresh appliance → firm onboards → creates services + package → sends proposal → client receives email → opens magic link → views all sections → selects tier → signs via OpenSign → attaches ACH via Financial Connections → engagement spawns → first invoice paid → dashboard reflects MRR.
3. Coverage ≥80% on all new code.
4. No P0/P1 bugs in the test suite for 7 days running.
5. Documentation complete: README, SECURITY, LICENSING, CHANGELOG, 10-min install guide, firm onboarding runbook, ESIGN/UETA evidence-package guide.
6. Three friendly-fire CPA firms have run live proposals through the appliance for ≥30 days each with zero data-integrity escapes.
7. Disaster-recovery test passes: nuke + restore preserves all signature audit trails, mandate hashes, and Stripe ID mappings.

---

## §3. Appendices

### §3.1 Environment variables (proposal module additions)

```
# Stripe (Standard Connect)
VIBETB_STRIPE_PUBLISHABLE_KEY=
VIBETB_STRIPE_SECRET_KEY=
VIBETB_STRIPE_WEBHOOK_SECRET=
VIBETB_STRIPE_CONNECT_CLIENT_ID=
VIBETB_STRIPE_API_VERSION=2025-04-30

# OpenSign sidecar
VIBETB_OPENSIGN_URL=http://opensign:3000
VIBETB_OPENSIGN_API_KEY=
VIBETB_OPENSIGN_WEBHOOK_SECRET=

# MinIO sidecar
VIBETB_S3_ENDPOINT=http://minio:9000
VIBETB_S3_ACCESS_KEY=
VIBETB_S3_SECRET_KEY=
VIBETB_S3_REGION=us-east-1
VIBETB_S3_BUCKET_PREFIX=vibetb-
VIBETB_S3_BACKUP_EXTERNAL_ENDPOINT=  # optional
VIBETB_S3_RETENTION_YEARS=7

# Puppeteer sidecar
VIBETB_PDF_URL=http://pdf:8080
VIBETB_PDF_CONCURRENCY=4

# Email
VIBETB_EMAIL_PROVIDER=postmark   # smtp | postmark | emailit
VIBETB_EMAIL_SMTP_HOST=
VIBETB_EMAIL_SMTP_PORT=587
VIBETB_EMAIL_SMTP_USER=
VIBETB_EMAIL_SMTP_PASS=
VIBETB_EMAIL_POSTMARK_TOKEN=
VIBETB_EMAIL_EMAILIT_TOKEN=
VIBETB_EMAIL_FROM=
VIBETB_EMAIL_REPLY_TO=

# SMS
VIBETB_SMS_PROVIDER=twilio   # twilio | textlink
VIBETB_SMS_TWILIO_SID=
VIBETB_SMS_TWILIO_TOKEN=
VIBETB_SMS_TWILIO_FROM=
VIBETB_SMS_TEXTLINK_TOKEN=
VIBETB_SMS_TEXTLINK_FROM=

# Portal
VIBETB_PORTAL_DEFAULT_DOMAIN=portal.example.com
VIBETB_PORTAL_MAGIC_LINK_TTL_DAYS=30
VIBETB_PORTAL_ENGAGEMENT_LINK_TTL_DAYS=90

# Master encryption key (for credentials at rest)
VIBETB_MASTER_KEY=  # 32-byte base64, generated on first boot if absent

# Renewal engine
VIBETB_RENEWAL_LOOKAHEAD_DAYS=90
VIBETB_RENEWAL_NIGHTLY_CRON=0 3 * * *
VIBETB_CPI_FETCH_CRON=0 4 1 * *
```

### §3.2 Sidecar topology (docker-compose excerpt)

```
services:
  vibe-tb-api:        # main Node.js Express app
  vibe-tb-web:        # React Vite static, served via Caddy
  vibe-tb-worker:     # BullMQ workers (webhooks, renewals, email, sms)
  postgres:           # PostgreSQL 16, shared with T&B core
  redis:              # Redis 7, shared with T&B core
  caddy:              # Ingress, on-demand TLS, custom-domain support
  minio:              # S3-compatible storage with object-lock
  pdf:                # Puppeteer/Chromium PDF renderer
  opensign:           # OpenSign sidecar (AGPL)
  opensign-db:        # Optional separate Postgres if isolation preferred
```

### §3.3 Stripe events to subscribe to (P12)

```
invoice.paid
invoice.payment_failed
invoice.finalized
invoice.voided
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
customer.subscription.paused
customer.subscription.resumed
payment_method.attached
payment_method.detached
payment_method.automatically_updated
mandate.updated
setup_intent.succeeded
setup_intent.setup_failed
payout.paid
payout.failed
charge.dispute.created
charge.dispute.closed
charge.refunded
account.updated
```

### §3.4 Service category COA placeholder seed values

```
TAX        4100  Tax Service Revenue
BOOKKEEPING 4200 Bookkeeping Service Revenue
AUDIT      4300  Audit & Assurance Revenue
ADVISORY   4400  Advisory Service Revenue
PAYROLL    4500  Payroll Service Revenue
CFO        4600  CFO/Controller Service Revenue
```

Firms can override per service; these are scaffolding only.

### §3.5 Initial scope deltas vs Ignition/Anchor

Quick reference for marketing positioning once v1.0 ships:

| Capability                  | Ignition                                     | Anchor                      | Vibe T&B (v1.0)                                     |
| --------------------------- | -------------------------------------------- | --------------------------- | --------------------------------------------------- |
| Pricing                     | $39–$399/mo SaaS + 1%+ transaction fees      | $5/payment, no subscription | One-time appliance license, $0 transaction overhead |
| Stripe relationship         | Stripe Custom Connect (Ignition is platform) | Closed proprietary rail     | Stripe Standard Connect (firm owns account)         |
| Self-hosted                 | No                                           | No                          | **Yes**                                             |
| Visual block editor         | Liquid templates (developer-leaning)         | Limited customization       | **Drag-drop visual editor**                         |
| 3-tier packages             | Yes                                          | Limited                     | **Yes**                                             |
| Renewal uplift methods      | AutoPricing (% bulk)                         | Manual                      | **3 methods (manual / realization / CPI)**          |
| Quick-bill                  | Limited                                      | **No**                      | **Yes**                                             |
| Custom domain               | Limited                                      | No                          | **Yes from day one**                                |
| Section-level view tracking | Pro+ only                                    | No                          | **Yes, included**                                   |
| E-signature legal trail     | Native click-accept                          | Native click-accept         | **OpenSign + HMAC tamper-evidence**                 |
| 7-year document retention   | Cloud only                                   | Cloud only                  | **In-appliance MinIO with object-lock**             |
| Multi-signer                | Pro+ (paid tier)                             | Yes                         | Schema ready, UI deferred to v1.5                   |
| PBC / Request list          | No                                           | No                          | **Planned v1.5 (clear moat)**                       |
| QBO/Xero sync               | Yes                                          | Yes                         | Deferred to v1.5                                    |
| AI features                 | AutoPricing + Price Insights (Oct 2025)      | None                        | Deferred to v1.5                                    |

### §3.6 Estimated effort

| Bucket               | Phases                  | Complexity sum | Est. dev-weeks (solo) |
| -------------------- | ----------------------- | -------------- | --------------------- |
| Foundation & catalog | P01, P02, P03, P07      | L+M+M+M        | 4                     |
| Authoring            | P04, P05, P06           | XL+L+M         | 5                     |
| Payments             | P08, P09, P10, P11, P12 | L+L+L+L+L      | 7                     |
| Storage & PDF        | P13, P14                | M+M            | 2                     |
| E-signature          | P15, P16                | L+M            | 3                     |
| Portal               | P17, P18, P19, P20, P21 | M+M+L+L+L      | 6                     |
| Engagement lifecycle | P22, P23, P24, P25      | M+M+M+L        | 4                     |
| Notifications        | P26, P27                | M+M            | 2                     |
| Dashboards           | P28, P29                | M+M            | 2                     |
| Hardening & release  | P30                     | L              | 2                     |
| **Total**            | **30**                  |                | **~37 dev-weeks**     |

With Claude Code autonomous execution and the KICKOFF_PROMPT.md / QUESTIONS.md protocol, expect **9–14 calendar weeks** with active review.

### §3.7 QUESTIONS.md protocol (reminder)

Per Kurt's standard workflow, Claude Code will surface ambiguities in `QUESTIONS.md` rather than guessing. Maintain that protocol throughout this build. Topics likely to surface:

1. Exact T&B core license string (BSL 1.1? PolyForm Internal Use?)
2. T&B core's existing `clients` schema — does the proposal module reuse it as-is or extend?
3. Caddy ingress version in T&B core (for on-demand TLS configuration)
4. Whether MyBooks integration is GL-export-via-shared-DB or via API
5. Brand identity (logo placement, color tokens) consistent with other Vibe apps
6. Whether the marketing site should ship alongside (probably no)

---

**END OF ADDENDUM BUILD PLAN**
