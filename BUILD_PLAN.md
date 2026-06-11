# Vibe Time & Billing — Build Plan

**Repository (planned):** `KisaesDevLab/Vibe-Time-Billing`
**Brand:** Vibe Time & Billing
**License:** Elastic License 2.0 (commercial license required for client-portal access)
**Created:** May 19, 2026
**Total phases:** 26
**Total items:** ~513
**Estimated autonomous build time (Claude Code, CLAUDE.md-driven):** 13–17 weeks

---

## Product overview

Self-hosted Docker appliance for CPA practice time tracking, recurring billing, write-up/write-down adjustments with per-timekeeper realization attribution, dimensional reporting, and a branded client portal for invoice viewing and payment. Targets mid-market CPA firms (5–50 timekeepers) underserved by Karbon's shallow billing, TaxDome's surface invoicing, and Canopy's modular pricing.

## Differentiators

- **Seven fee structures native** — hourly, hourly-NTE, fixed-fee, fixed-fee with milestones, recurring subscription, mixed-mode (retainer + overage), hour bank with rollover
- **Six adjustment allocation methods** — specific entries, pro-rata by value, pro-rata by hours, partner absorbs, hierarchical cascade, custom weighted
- **Per-timekeeper allocation grain** — individual realization survives partner write-downs correctly
- **Identity-based client portal** — one person, multiple client entities, email or SMS login (rare among CPA tools — most are per-client logins)
- **Local-first AI** — description suggestion, pricing, scope creep, write-down patterns, realization narrative, plain-English query
- **MCP server** — exposes domain data to AI agents (Claude Code, Cowork, third-party MCP clients)
- **Self-hosted** — firm owns the data, no cloud dependency for core function

## Stack

- React 18 + Vite + TypeScript strict
- Node.js 24 + Express + tsx
- BullMQ workers + Redis 7
- PostgreSQL 16 + Drizzle ORM
- pnpm workspaces (monorepo)
- Caddy ingress
- Multi-provider AI: Anthropic Claude API, local Ollama / llama.cpp, OpenAI-compatible endpoints
- TextLink for SMS (already in Vibe stack via Vibe Connect)
- Docker appliance, GHCR distribution
- Three deployment modes: domain (with Cloudflare Tunnel), LAN, Tailscale

## Architecture principles

1. **Customer-owned Cloudflare resources** — never Kisaes-owned tunnels or accounts
2. **Local-first AI** — Tier 1 is local model; cloud LLM is optional Tier 2
3. **Per-app data isolation** — Time & Billing data lives in its own database, not shared with MyBooks or other Vibe apps
4. **Standard rate snapshot at time entry** — historical reports never shift when rates change
5. **`adjustment_allocation` at per-timekeeper grain** — the realization attribution wedge
6. **Immutable audit log** — edits create versioned records, never overwrite
7. **Local AI sees firm data; cloud AI sees nothing without explicit toggle**
8. **Elastic License 2.0** licensing, commercial license for client-portal features
9. **Separate auth realms** — staff and client portal users have distinct session stores and trust models
10. **Identity-based portal model** — `portal_identity` is the person; `client_portal_access` is the join to clients. Email and phone are contact methods on the identity, not the identity itself. One person who is responsible for three entities at the same firm gets one login and switches entities via the UI.

## CLAUDE.md autonomous workflow

Build follows the established Vibe pattern:
- Each phase is a self-contained unit with clear acceptance criteria
- `QUESTIONS.md` accumulates open decisions during autonomous work — Kurt reviews and answers
- `CLAUDE.md` at repo root encodes the standing instructions and architectural constraints
- Phase completion requires: items checked, acceptance criteria validated, tests passing, no open QUESTIONS that block the next phase

---

## Phase index

| Phase | Name | Items | MVP | Differentiator |
|---|---|---:|:---:|:---:|
| 1 | Repo & infrastructure foundation | 15 | ✓ | |
| 2 | Database schema & migrations | 31 | ✓ | ◆ |
| 3 | Authentication & sessions (staff) | 18 | ✓ | |
| 4 | Firm, office & user administration | 15 | ✓ | |
| 5 | Taxonomy: service lines, work codes, engagement types, reason codes | 12 | ✓ | |
| 6 | Client management | 12 | ✓ | |
| 7 | Rate management | 20 | ✓ | ◆ |
| 8 | Engagement & fee structure | 28 | ✓ | ◆ |
| 9 | Time entry & capture | 32 | ✓ | ◆ |
| 10 | Recurring billing engine | 38 | ✓ | ◆ |
| 11 | Pre-bill & WIP management | 25 | ✓ | |
| 12 | Adjustments & allocation (the wedge) | 32 | ✓ | ◆ |
| 13 | Invoicing | 25 | ✓ | |
| 14 | Payment processing | 24 | ✓ | |
| 15 | AR aging & dunning | 15 | ✓ | |
| 16 | Client portal | 28 | ✓ | ◆ |
| 17 | Reporting & analytics cube | 32 | ✓ | ◆ |
| 18 | Approval workflows | 20 | | |
| 19 | Audit trail & compliance | 15 | ✓ | |
| 20 | Administration UI | 15 | ✓ | |
| 21 | Integrations: email-in, webhooks, REST API | 16 | | |
| 22 | MCP server | 12 | | ◆ |
| 23 | AI features (multi-provider) | 28 | | ◆ |
| 24 | Vibe Connect integration | 8 | | |
| 25 | Distribution & deployment | 15 | ✓ | |
| 26 | Polish, demo data, launch readiness | 14 | ✓ | |
| | **Total** | **513** | | |

**Phases 1–17, 19, 20, 25, 26** = MVP. Phases 18, 21, 22, 23, 24 layer on after first release.

---

## Phase 1 — Repo & infrastructure foundation

**Goal:** Establish the monorepo, dev environment, CI, and Docker scaffold so subsequent phases can be implemented and tested independently.

**Items: 15**

### Items
1. pnpm workspace monorepo at root with `apps/*` and `packages/*`
2. `apps/web` — React 18 + Vite + TypeScript strict mode (staff UI)
3. `apps/portal` — React 18 + Vite + TypeScript strict mode (client portal — scaffolded here, built in Phase 16)
4. `apps/api` — Express + TypeScript + tsx for dev hot-reload
5. `apps/worker` — BullMQ worker process for scheduled jobs
6. `packages/db` — Drizzle schema, migrations, query helpers
7. `packages/types` — shared TypeScript types between apps
8. `packages/ui` — React component library (cards, tables, pills, forms)
9. Dockerfile (multi-stage: build → runtime)
10. `docker-compose.dev.yml` — postgres 16, redis 7, web, portal, api, worker
11. ESLint + Prettier + lint-staged + husky pre-commit hooks
12. `LICENSE.md` (Elastic License 2.0), `README.md`, `CLAUDE.md`, `QUESTIONS.md`
13. GitHub Actions workflow: lint, typecheck, test, docker build on PR
14. Caddy config templates for two-host routing (staff + portal)
15. Environment configuration pattern (`.env.example`, validated at startup)

### Acceptance
- `pnpm install && pnpm dev` brings up web, portal, api, worker, postgres, redis
- `pnpm typecheck` passes across all packages
- `pnpm lint` passes
- CI workflow runs on PR and reports status
- Docker image builds and runs via `docker compose up`
- Caddy correctly routes `app.*` to staff app and `portal.*` to client portal

### QUESTIONS
- Default appliance port assignments — 80/443 via Caddy with internal API not exposed?
- Database backup strategy at appliance level — pg_dump cron, WAL archiving, or live replication?
- Subdomain split (`app.firm.com` + `portal.firm.com`) vs. path split (`firm.com/app` + `firm.com/portal`) — affects DNS and SSL flow.

---

## Phase 2 — Database schema & migrations

**Goal:** Define the complete relational model with Drizzle ORM. Special attention to the `adjustment_allocation` grain that powers per-timekeeper realization, and the `portal_identity` + `client_portal_access` model that powers multi-entity portal access.

**Items: 31**

### Items
1. `firm` — id, name, fiscal_year_start_month, default_allocation_method, settings_json
2. `office` — id, firm_id, name, address, timezone
3. `app_user` — id, firm_id, email, name, default_office_id, status, mfa_enabled (staff)
4. `portal_identity` — id, firm_id, full_name, status, primary_email, primary_email_verified_at, primary_phone, primary_phone_verified_at, preferred_method (EMAIL | SMS), last_login_at (the person — separate auth realm from staff)
5. `client_portal_access` — id, portal_identity_id, client_id, role (FULL | VIEW_ONLY | PAY_ONLY), notification_preferences_json (per-client notification channel + events), invited_by, invited_at, accepted_at, status (the many-to-many between identity and clients)
6. `role` — id, firm_id, name, system_flag, with `role_permission` and `user_role` joins (staff RBAC)
7. `service_line` — id, firm_id, name, category (tax/audit/advisory/bookkeeping/payroll)
8. `work_code` — id, firm_id, service_line_id, name, billable_default
9. `engagement_type` — id, firm_id, service_line_id, name (1040, 1120-S, audit, monthly_bk, etc.)
10. `reason_code` — id, firm_id, category (write_down/write_up/transfer), label
11. `client` — id, firm_id, name, status, partner_in_charge_id, billing_contact_email, terms_days
12. `engagement` — id, client_id, name, engagement_type_id, fee_structure, budget_hours, budget_amount, partner_id, manager_id, status, start_date, end_date, scope_definition
13. `timekeeper_rate` — id, app_user_id, bill_rate, cost_rate, effective_start, effective_end
14. `client_rate_override`, `engagement_rate_override`, `service_line_rate` — full hierarchy
15. `time_entry` — id, engagement_id, app_user_id, date, hours, work_code_id, billable_flag, in_scope_flag, description, standard_rate_snapshot, standard_amount, status, created_at, locked_at
16. `time_entry_version` — id, time_entry_id, version, fields_json, edited_by, edited_at
17. `recurring_billing_plan` — id, engagement_id, frequency, amount, next_run_date, billing_day, auto_pay_flag, payment_method_id, proration_rule, status
18. `recurring_billing_plan_service` — plan_id, service_line_id, included_hours
19. `milestone_billing_plan` and `milestone` — full milestone schema
20. `hour_bank` and `hour_bank_transaction` — ledger model with running balance
21. `billing_batch` and `billing_batch_entry` — pre-bill structure
22. `adjustment` — id, billing_batch_id, method, allocation_method, total_amount, reason_code_id, notes, status, approver_id, approved_at
23. `adjustment_allocation` — id, adjustment_id, time_entry_id, app_user_id, original_value, adjusted_value, adjustment_amount
24. `invoice` and `invoice_line_item` — mixed line item schema
25. `payment` and `payment_method` — provider-abstracted (payment_method belongs to portal_identity, shared across all clients the identity manages)
26. `portal_session` — id, portal_identity_id, active_client_id (session scoped to one client at a time; switcher updates this), token_hash, expires_at, ip, user_agent
27. `portal_invitation` — id, client_id, portal_identity_id (nullable until accepted), invited_email, invited_phone, token_hash, delivery_method (EMAIL | SMS), expires_at, used_at, invited_by
28. `sms_otp` — id, contact_phone, code_hash, expires_at, used_at, attempt_count (for SMS login flow)
29. `ar_aging_snapshot` and `realization_view`, `utilization_view`, `profitability_view` — materialized views
30. `approval_rule`, `approval_request`, `audit_log`, `webhook_endpoint`, `webhook_delivery`, `mcp_token`, `ai_request_log`
31. Indexes on all foreign keys and high-cardinality query columns; partition strategy for `audit_log` and `time_entry`

### Acceptance
- `pnpm db:migrate` applies all migrations clean on empty DB
- `pnpm db:seed` loads firm + office + 7 staff users + 5 sample clients + base taxonomy + 3 portal identities (one with access to 3 clients)
- All foreign keys constrained; cascade rules documented
- `standard_rate_snapshot` is a NOT NULL column on `time_entry`
- `adjustment_allocation` constraint: sum of `adjustment_amount` equals parent `adjustment.total_amount`
- `portal_identity` and `app_user` are in distinct tables with no shared identity
- Same `portal_identity` can have multiple `client_portal_access` rows (verified via seed data)
- Drizzle types exported and consumed by `packages/types`

### QUESTIONS
- Soft-delete vs. hard-delete policy on client / engagement / time_entry — audit retention requirements?
- Whether to use Postgres `tstzrange` for effective-dating or paired timestamps — Drizzle's tstzrange support is partial?
- Cross-firm portal identities: explicitly out of scope per architecture principle 10 (each firm's appliance has its own identity pool). Confirm.
- Phone number recycling: annual re-verification, or only on explicit profile update?

---

## Phase 3 — Authentication & sessions (staff)

**Goal:** Magic-link primary auth with TOTP step-up for sensitive actions. Staff realm only; client portal auth handled in Phase 16.

**Items: 18**

### Items
1. Magic link via email (signed JWT, 15-minute expiry)
2. Session storage in Redis with sliding expiration (7 days)
3. Express middleware: `requireAuth`, `requireRole`, `requirePermission`
4. TOTP enrollment flow (QR code + recovery codes)
5. TOTP verification middleware: `requireStepUp`
6. Step-up tagging on sensitive endpoints
7. Logout + session revocation
8. Password-less but optional WebAuthn enrollment
9. User invitation flow (admin sends invite → user sets up)
10. Email verification on signup
11. Account lockout after N failed step-up attempts
12. Failed-login rate limiting (Redis sliding window)
13. CSRF protection via SameSite cookies + double-submit token
14. Audit log emission on all auth events
15. Login UI (`apps/web`)
16. TOTP enrollment UI
17. Account settings page (change email, manage TOTP, revoke sessions)
18. API key generation (for REST and MCP) — Phases 21/22 will consume these

### Acceptance
- New staff user can sign up via invitation, enable TOTP, log out, and log back in
- Step-up challenges fire on protected endpoints when last step-up was over X minutes ago
- All auth events recorded to `audit_log`
- Rate limits engage at expected thresholds

### QUESTIONS
- Step-up timeout duration default — 15 minutes? Per-firm configurable?
- Allow magic-link-only firms or always require TOTP for admins?

---

## Phase 4 — Firm, office & user administration

**Goal:** Multi-office firm structure with role-based access. Sets up the org foundation that everything else depends on.

**Items: 15**

### Items
1. Firm settings UI (name, fiscal year, default office)
2. Office CRUD UI
3. User list + invite UI
4. Role assignment per user
5. Role templates: partner, manager, senior, staff, admin
6. Permission key catalog and seed
7. Per-office override of firm settings (where applicable)
8. Standard hours per role (utilization denominator)
9. Holiday and PTO calendar (firm-level)
10. Time-off entry per user (affects utilization)
11. Active/inactive user toggle
12. User detail page showing engagement assignments
13. Bulk user import (CSV)
14. Office-level partner-in-charge defaults
15. Multi-entity flag (firm has multiple legal entities) — schema present, UI deferred

### Acceptance
- New firm can be set up with 2 offices, 8 users, 5 role assignments in under 10 minutes
- Permissions enforce correctly: staff cannot adjust over manager's threshold; manager cannot edit firm settings
- Utilization queries respect time-off entries

### QUESTIONS
- Should we support multiple firms in a single appliance instance (multi-tenant), or stick to single-firm per appliance?

---

## Phase 5 — Taxonomy: service lines, work codes, engagement types, reason codes

**Goal:** Configurable taxonomies that drive every report dimension and engagement classification.

**Items: 12**

### Items
1. Service line CRUD UI
2. Work code CRUD UI with service line linkage
3. Engagement type CRUD UI
4. Reason code CRUD UI grouped by category (write-down, write-up, transfer)
5. Seed defaults on firm creation
6. Bulk import for migration scenarios
7. Soft-delete with archival (can't delete if referenced)
8. Category enums centralized in `packages/types`
9. Service line color/icon for reports
10. Taxonomy export to JSON
11. Taxonomy import from JSON (for new firms or template share)
12. Description templates per work code (consumed by time entry Phase 9)

### Acceptance
- Firm can edit all four taxonomies through admin UI
- Time entry form populates work codes filtered by selected engagement's service line
- Reports group by service line / engagement type correctly

### QUESTIONS
- Should engagement type include default fee structure suggestion (e.g., 1040 → fixed fee)?

---

## Phase 6 — Client management

**Goal:** Client records with billing contact, partner-in-charge, engagement aggregation, and portal access management. The firm-side UI to invite people to the client portal lives here.

**Items: 12**

### Items
1. Client CRUD UI
2. Billing contact (name, email, phone, address)
3. Partner-in-charge assignment (required)
4. Client status (prospect/active/inactive/closed)
5. Custom field support (firm-defined)
6. Tags
7. Client detail page with engagement list
8. Client merge tool (deduplication)
9. Client notes (audit-logged)
10. Bulk import (CSV with column mapping)
11. Client search across name, email, custom fields
12. Portal access panel: invite people to this client (creates `portal_identity` if new, adds `client_portal_access` if existing); view and manage who has access; revoke access; resend invitation

### Acceptance
- Adding a client creates record with required partner-in-charge
- Client detail shows all engagements with status and current period WIP
- Search returns results in <200ms for firms up to 5,000 clients
- Inviting an email that already has a `portal_identity` in the firm creates only an access row (no duplicate identity), with notification to the person that they've been granted access to a new client

### QUESTIONS
- Auto-create a default engagement on client creation, or require explicit engagement creation?

---

## Phase 7 — Rate management

**Goal:** Rate cards with effective-dated history. Rate resolution function with hierarchical fallback. Standard rate snapshot logic.

**Items: 20**

### Items
1. Timekeeper rate CRUD with effective dates
2. Client rate override CRUD
3. Engagement rate override CRUD
4. Service line role-based rate fallback
5. Firm default rate by role
6. Rate resolution function (engagement → client → service line → timekeeper → firm)
7. Rate snapshot capture function (called at time entry creation)
8. Effective-dated history view per timekeeper
9. Bulk rate update tool with preview impact (shows projected revenue change)
10. Rate card import (CSV)
11. Cost rate per timekeeper (for profitability)
12. Loaded margin display (bill ÷ (cost × overhead factor))
13. Premium/discount multipliers per engagement
14. Mid-year rate change does not retroactively change historical realization (verify via test)
15. Rate management UI (timekeeper list with current rates)
16. Rate history modal per timekeeper
17. Rate resolution debug panel (for partner asking "why is this rate $X")
18. Rate change audit log entries
19. Rate change requires admin permission
20. Rates exported in reports show snapshot version, not current

### Acceptance
- Time entry created on Jan 5, 2026 with rate $420 retains $420 even after rate changes to $450 on Jul 1
- Rate resolution debug panel correctly identifies which level resolved
- Bulk rate update of all partners shows projected $X impact before apply
- All rate changes logged to `audit_log`

### QUESTIONS
- Should we allow negative rates (write-down at rate stage)? Probably not — handle via adjustment.

---

## Phase 8 — Engagement & fee structure

**Goal:** Engagement records supporting all five fee structures plus mixed-mode. Budget tracking, lifecycle states, auto-rollover.

**Items: 28**

### Items
1. Engagement CRUD UI
2. Fee structure picker: hourly, hourly-NTE, fixed-fee, fixed-fee-with-milestones, recurring-subscription
3. Mixed-mode flag (overlay on subscription)
4. Hourly NTE cap configuration (per-engagement-lifetime or per-period)
5. Fixed-fee total amount
6. Milestone list editor for fixed-fee-with-milestones
7. Recurring subscription configuration (amount, frequency, included scope)
8. Hour bank configuration (opening hours, rollover rule, expiration)
9. Budget hours and budget dollars
10. Engagement type taxonomy linkage
11. Partner-in-charge and manager-in-charge assignment
12. Scope definition (in-scope / out-of-scope rich text)
13. Engagement status lifecycle (proposed/active/paused/closed)
14. Auto-rollover toggle (2026 1040 → 2027) with optional price increase
15. Engagement detail page with tabs (overview, time, invoices, scope, documents)
16. Budget vs. actual live tracking
17. Engagement letter attachment (Phase 1 of doc storage; full DMS later)
18. Engagement clone (copy structure to new year)
19. Engagement status transitions audited
20. Engagement pause behavior (no new time entries, no new invoices)
21. Engagement close requires all WIP resolved
22. Recurring engagement schedule entry creates next-year engagement automatically
23. Engagement search and filter
24. Engagement list views: by partner, by service line, by status
25. Engagement bulk operations (close inactive, archive)
26. Engagement custom fields
27. Engagement template library (firm-defined)
28. Engagement creation from proposal acceptance (stub — full integration in Phase 24)

### Acceptance
- Each fee structure can be configured end-to-end and time entries route correctly
- Mixed-mode engagement shows in-scope vs. out-of-scope splits live
- Auto-rollover creates next-year engagement on schedule
- Cloning an engagement preserves structure, clears actuals

### QUESTIONS
- Engagement template library — firm-defined or include national templates by default?
- Multi-year fixed-fee engagements (3-year audit retainer paid annually) — special handling or just three engagements?

---

## Phase 9 — Time entry & capture

**Goal:** The daily-use surface. Timer, post-hoc grid, required fields, in-scope tagging, late entry alerts, snapshot capture.

**Items: 32**

### Items
1. Time entry create endpoint (calls rate resolution + snapshot capture)
2. Time entry update endpoint (creates `time_entry_version` row)
3. Time entry delete endpoint (soft delete, audit-logged)
4. Timer with start/stop/pause, server-persisted state
5. Idle detection (15-minute default, configurable)
6. Timer auto-recovery on browser refresh
7. Post-hoc timesheet grid: day view
8. Post-hoc timesheet grid: week view
9. Post-hoc timesheet grid: month view
10. Quick entry form (engagement, work code, hours, description)
11. Required field rules engine (per firm)
12. Description template picker per work code
13. Billable / non-billable toggle
14. In-scope / out-of-scope toggle (only shown for retainer-eligible engagements)
15. Late entry alerts (un-entered time from N days ago)
16. Lockout threshold (no entries older than N days without override)
17. Bulk entry from template ("standard 1040 day")
18. Time entry locking (once on a finalized billing batch, locked)
19. Time entry transfer between engagements (audit-logged cost transfer)
20. Per-day total displayed
21. Per-week summary with billable/non-billable split
22. Approver field if engagement requires per-entry approval
23. Time entry search across all engagements (admin only)
24. Time entry export per timekeeper
25. Voice entry stub (LLM transcription — full impl in Phase 23)
26. Email-to-time-entry stub (BCC parsing — full impl in Phase 21)
27. Time entry from workflow task completion (deferred until workflow exists)
28. Mobile PWA shell for time entry
29. Offline draft support (PWA queue)
30. Engagement filter on entry form (limits to active engagements user has access to)
31. Smart engagement suggestions (most-recent first)
32. Required-fields admin UI

### Acceptance
- A staff member can enter a full week of time in under 10 minutes via the grid
- Timer survives browser refresh
- Late entry alert fires after configurable threshold
- Standard rate snapshot is verifiably captured on every entry
- In-scope/out-of-scope toggle only appears on retainer-eligible engagements
- Lockout prevents back-dating beyond admin-allowed window

### QUESTIONS
- Should timer auto-pause on screen lock / inactivity threshold, or rely on idle detection prompt?
- Should we round hours to 0.1 or 0.25 by default? Firm-configurable?

---

## Phase 10 — Recurring billing engine

**Goal:** All recurring patterns running on schedule via BullMQ. Auto-pay, proration, failed payment retry, hour bank ledger.

**Items: 38**

### Items
1. Recurring plan creation tied to engagement
2. Subscription plan: flat fee, frequency, next-run computation
3. BullMQ scheduled job: roll forward `next_run_date` on each run
4. Subscription invoice generation on schedule
5. Time-based recurring plan: roll up WIP for period, generate billing batch
6. Milestone plan: milestone-trigger evaluation
7. Date-triggered milestone fires on date
8. Event-triggered milestone fires on event key (event source defined in Phase 18/23)
9. Manual milestone trigger
10. Mixed-mode billing: combine retainer + overage hours on one invoice
11. Out-of-scope hour roll-up into overage line items
12. Hour bank: opening transaction creates balance
13. Hour bank: time entry debits balance
14. Hour bank: balance display with projected runway
15. Hour bank: auto-replenish threshold (optional)
16. Hour bank: top-up purchase (manual or auto)
17. Hour bank: expiration rule enforcement
18. Hour bank: rollover cap enforcement
19. Hourly NTE: cap check at billing batch creation
20. Hourly NTE: auto-suggest adjustment to cap
21. Mid-cycle start proration
22. Mid-cycle plan change proration (upgrade/downgrade)
23. Annual prepay discount handling
24. Pause/resume subscription (skips runs, no proration)
25. Auto-pay configuration per plan
26. Stripe payment intent for auto-pay
27. CPACharge payment intent (alternate provider)
28. Failed payment retry schedule (3/7/14 days configurable)
29. Failed payment dunning email sequence
30. Auto-pause work after N consecutive failures
31. Auto-resume on successful payment
32. Partner notification on failed payment
33. Plan-health computed view (healthy/scope-creep/at-risk)
34. Worker monitoring & alerting on failed runs
35. Idempotency keys on invoice generation (re-runs don't duplicate)
36. Recurring plan list page
37. Recurring plan detail page
38. Recurring plan audit log

### Acceptance
- Subscription invoice fires on schedule with correct proration on mid-cycle changes
- Mixed-mode engagement bills $2K retainer + $1,001 overage when 2.6 OOS hours present
- Hour bank balance correctly decrements as time entries are added
- Failed Stripe charge triggers retry on day 3, day 7, day 14; engagement auto-pauses after 3 failures
- BullMQ worker survives restart without losing scheduled jobs

### QUESTIONS
- Stripe Connect or direct charge model — does the firm own the Stripe account, or do we route through Kisaes?
- Refund handling on cancelled hour banks — to original payment method or as firm credit?

---

## Phase 11 — Pre-bill & WIP management

**Goal:** Partner review surface for unbilled WIP. Include / defer / write-off per entry. WIP aging, carry-forward, cost transfer.

**Items: 25**

### Items
1. Billing batch creation per engagement per period
2. Time entries auto-pulled into billing batch based on period
3. Pre-bill review UI
4. Per-entry actions: Include / Defer / Write off
5. WIP carry-forward (deferred entries reappear next period)
6. Write-off types: held (counts toward utilization) vs. removed
7. WIP aging buckets (0–30, 31–60, 61–90, 90+) computed in materialized view
8. Pre-bill PDF generation
9. Pre-bill emailable for partner review
10. Pre-bill assignment to billing partner (notification)
11. Bulk pre-bill generation at period close (worker job)
12. Cost transfer between engagements (audit-logged)
13. Pre-bill status lifecycle: draft → in-review → approved → invoiced
14. Pre-bill comments per entry (visible to other reviewers)
15. Pre-bill approval routes to Phase 18 approval workflow
16. Standard WIP totals
17. Fixed-fee engagement: gap calculation (WIP vs. fee)
18. Hourly NTE engagement: cap check
19. Subscription engagement: in-scope vs. overage split
20. Pre-bill compare against budget
21. Pre-bill recompute on time entry change
22. Pre-bill freeze on approval (no further entry edits)
23. Pre-bill versioning (reopen creates new version)
24. WIP age alert on engagements with entries >90 days
25. WIP dashboard for managing partners

### Acceptance
- Pre-bill generation creates billing batch with correct entries
- Deferring an entry returns it to WIP, re-appears next period
- WIP aging buckets recompute nightly
- Approved pre-bill freezes underlying entries
- Cost transfer creates audit log entries on both source and target engagements

### QUESTIONS
- Can a single time entry appear in two pre-bills (split billing)? Probably no — but worth confirming.

---

## Phase 12 — Adjustments & allocation (the wedge)

**Goal:** The differentiator. Three methods × six allocation methods. Per-timekeeper allocation grain. Symmetric write-up. Approval thresholds.

**Items: 32**

### Items
1. Adjustment create endpoint
2. Method selector: rate, time, fee
3. Allocation method selector: specific, pro-rata value, pro-rata hours, partner absorbs, hierarchical cascade, custom weighted
4. Allocation function: specific entries
5. Allocation function: pro-rata by value
6. Allocation function: pro-rata by hours
7. Allocation function: partner absorbs
8. Allocation function: hierarchical cascade
9. Allocation function: custom weighted
10. `adjustment_allocation` row generation per allocation
11. Symmetric write-up support (positive total_amount)
12. Reason code attachment (required)
13. Free-text notes
14. Adjustment impact preview (shows per-timekeeper realization change before commit)
15. Adjustment approval threshold rules engine (dollar, percent, role, reason code)
16. Approval routing to Phase 18 workflow
17. Approval status tracking on adjustment
18. Adjustment audit log entries (every transition)
19. Credit memo generation for post-invoice adjustments
20. Adjustment void / reverse
21. Bulk adjustment across engagements (one reason, distributed)
22. Auto-suggest adjustment when WIP exceeds NTE cap
23. Auto-suggest adjustment when fixed-fee engagement WIP exceeds fee
24. Adjustment dialog UI
25. Adjustment list view (per engagement, per billing batch)
26. Adjustment search (across firm)
27. Per-timekeeper allocation table on dialog
28. Constraint validation: sum of allocations equals total
29. Sensitive action requires step-up auth (over firm-defined threshold)
30. Cascading adjustments (subsequent adjustment to already-adjusted batch handled correctly)
31. Adjustment export
32. Adjustment metrics (count, average, reason-code breakdown) for AI Phase 23 to analyze

### Acceptance
- Hierarchical cascade with $1,200 adjustment on the Vance scenario produces exactly the per-timekeeper numbers shown in the mockup (Sarah Chen 0%, Mike Davis 97%, others 100%)
- Pro-rata by value produces identical percentages across all timekeepers (mathematical property)
- Adjustment over $1,000 requires partner-in-charge approval
- Reversing an adjustment correctly restores per-timekeeper realization
- Symmetric write-up math: $500 write-up allocates positively, raises realization above 100%

### QUESTIONS
- Should "specific entries" allocation allow zero adjustment on some entries while non-zero on others? Yes, but UI design TBD.
- Custom weighted: weights enter as percentages (must sum to 100%) or as dollar amounts (must sum to total)?

---

## Phase 13 — Invoicing

**Goal:** Invoice composer with mixed line items, templates, custom numbering, email delivery, pay-to-unlock.

**Items: 25**

### Items
1. Invoice creation from approved pre-bill
2. Invoice creation from recurring billing run
3. Invoice creation from milestone trigger
4. Mixed line items: time aggregate, fixed fee, milestone, recurring fee, expense, custom
5. Manual invoice composer
6. Invoice templates per service line / firm style
7. Custom numbering scheme (per office, per year, per partner)
8. Multi-engagement consolidated invoice for same client
9. Detail level options: summary / by-line / full time entry detail
10. Invoice preview UI
11. Invoice PDF generation
12. Email delivery (firm SMTP or transactional provider)
13. Read receipts (tracking pixel + open API)
14. Resend with one click
15. Late fee accrual rules
16. Expense pass-through with markup rules
17. Invoice number assignment (atomic, no gaps)
18. Invoice void with credit memo
19. Invoice partial credit
20. Invoice list view (sortable, filterable)
21. Invoice detail page
22. Invoice search
23. E-signed engagement letter integration (stub for Phase 24)
24. Pay-to-unlock attachment (locks doc until paid — consumed by Phase 16 portal)
25. Invoice audit log

### Acceptance
- Invoice generated from pre-bill carries all line items correctly
- Multi-engagement consolidated invoice for one client sums correctly across engagements
- Email delivery with read receipt fires and records
- Voiding an invoice generates a credit memo and adjusts AR aging

### QUESTIONS
- Invoice templates: HTML + PDF rendering library — Puppeteer/Playwright or React-PDF?
- Read receipt tracking pixel — privacy concerns; opt-in per firm?

---

## Phase 14 — Payment processing

**Goal:** Stripe + CPACharge integrations. ACH and card. Auto-apply. Partial payments. Pay-to-unlock backend (UI lives in client portal Phase 16).

**Items: 24**

### Items
1. Stripe Connect / direct API integration
2. CPACharge integration as alternate provider
3. ACH payment method support
4. Card payment method support
5. Stored payment methods per `portal_identity` (shared across all clients the identity manages)
6. PCI compliance: never store card data, use provider tokens
7. Auto-apply payment to oldest invoice (configurable)
8. Auto-apply to specific invoice (manual)
9. Partial payment tracking
10. Multiple payments per invoice
11. Refund processing (full and partial)
12. Credit memo issuance
13. Pay-to-unlock backend: lock invoice attachments behind payment state
14. Pay-to-unlock: unlock signal flows to portal within 5 seconds of payment confirmation
15. Payment confirmation email
16. Payment receipt PDF
17. Firm payment notifications (configurable)
18. Webhook handlers for Stripe events (charge.succeeded, charge.failed, dispute.created)
19. Webhook handlers for CPACharge events
20. Failed payment handling routes back to dunning sequence
21. Provider abstraction layer (don't lock to one)
22. Payment audit log
23. Reconciliation report (firm-side cash deposits vs. system records)
24. Payment method endpoint surface (consumed by portal Phase 16)

### Acceptance
- Card payment via Stripe credits the correct invoice and updates AR aging
- Refund issued correctly reverses invoice payment state
- ACH payment with day-3 settlement reflects pending vs. settled correctly
- Pay-to-unlock unlock signal fires within 5 seconds of webhook receipt
- Saved card on one client entity is selectable when paying invoices on another client entity (same identity)

### QUESTIONS
- Pricing of payment processor fees — pass through to client, absorb, or both options configurable?
- Trust account / IOLTA support — explicitly out of scope for v1?

---

## Phase 15 — AR aging & dunning

**Goal:** AR aging snapshots, statements, automated dunning sequence with auto-pause on chronic failures. Dunning emails and texts contain magic links into the client portal (Phase 16).

**Items: 15**

### Items
1. AR aging snapshot job (nightly)
2. Aging buckets (0–30 / 31–60 / 61–90 / 90+)
3. AR aging report
4. Statement generation per client
5. Statement email/SMS with portal magic link
6. Dunning sequence rules (e.g., friendly reminder day 7, firm day 21, escalated day 45)
7. Dunning email/SMS templates with portal pay link (channel per identity preference)
8. Auto-send dunning at thresholds
9. Manual dunning trigger
10. Dunning history per invoice
11. Escalation to partner notification at threshold
12. Auto-pause engagement after N consecutive failed payments or N days overdue
13. AR aging filters: by client, by partner, by service line
14. AR aging export
15. AR collection metrics (DSO, collection rate, avg days to pay)

### Acceptance
- Aging buckets recompute correctly at midnight firm-time
- Dunning sequence fires on schedule and contains portal pay link
- Channel selection (email vs. SMS) respects the recipient identity's preferred method
- Engagement auto-pauses after configurable threshold
- DSO metric matches manual calculation

### QUESTIONS
- Dunning tone — defaults conservative, but expose customization? How aggressive can/should auto-pause be?

---

## Phase 16 — Client portal

**Goal:** Branded client-facing portal for invoice viewing and payment. Identity-based authentication: one `portal_identity` can have `client_portal_access` to multiple clients at the same firm and switches via an entity switcher. Login by email (magic link) or mobile phone (SMS OTP) — single login input field with format detection. Mobile-responsive. Pay-to-unlock document download. Distinct app (`apps/portal`) from staff app (`apps/web`) with its own auth realm.

**Items: 28**

### Items
1. `apps/portal` React 18 + Vite scaffold (created in Phase 1, populated here)
2. Combined email/phone login input with client-side format detection (routes to email or SMS path)
3. Magic-link auth flow (email path) — signed JWT, 15-minute expiry
4. SMS OTP auth flow (phone path) — 6-digit code via TextLink, 5-minute expiry, rate-limited
5. Phone number verification on first use (mitigates recycled-number account takeover)
6. Portal session middleware (Redis-backed, scoped to `portal_identity_id` + `active_client_id`)
7. Firm-side UI integration: invite person to a client (creates `portal_identity` if new, adds `client_portal_access` if existing) — lives in Phase 6 client management
8. Entity switcher in portal header (shown when identity has access to multiple clients; dropdown with active indicator)
9. Multi-contact support per client (firm-side admin creates multiple identities each with their own access; each has their own audit trail)
10. Portal layout/shell with firm branding (logo, colors, configurable domain)
11. Open invoices list scoped to `active_client_id`
12. Paid invoices history view with date range filter
13. Invoice detail view (line items, totals, due date, status)
14. Invoice PDF download
15. Payment flow: Stripe/CPACharge integration on client side (consumes Phase 14 endpoints)
16. Saved payment methods management — per `portal_identity`, shared across all clients they manage
17. Auto-pay enrollment per engagement
18. Statement of account view scoped to `active_client_id` (running balance, full activity)
19. Payment receipt download per payment
20. Pay-to-unlock document download (consumes Phase 14 unlock signal)
21. Profile management: full name, primary email, primary phone, preferred login method
22. Add and verify alternate contact method (e.g., add phone after first email login; OTP-verify before activation)
23. Notification preferences per `client_portal_access` (channel: email/SMS; events: new invoice, payment confirmation, payment failed, document ready)
24. Email notification dispatcher honoring per-access preferences (new invoice, payment confirmation, payment failed)
25. SMS notification dispatcher honoring per-access preferences (same events, shortened body, portal magic link)
26. Portal access audit log entries flow into Phase 19 audit log (with `actor_identity_id` and `active_client_id`)
27. Portal enabled/disabled toggle per firm (some firms may not want to expose a portal)
28. Subdomain or path-based routing (firm-configurable via Phase 20 admin) and graceful degradation when payment provider is down

### Acceptance
- Client receives invitation at email OR phone, completes first login, lands in the portal within 60 seconds
- Identity with access to 3 clients sees the entity switcher in the header; switching updates `active_client_id` on the session, audited
- Inviting an existing identity to a new client at the same firm dedupes correctly (no new identity created, only a new access row)
- Identity can change preferred login method from email to SMS in profile; future logins via either method continue to work
- Saved payment method added on one client entity is selectable when paying invoices on another client entity for the same identity
- Per-access notification preferences correctly route email vs. SMS for each event type
- Pay-to-unlock attachment becomes downloadable within 5 seconds of payment confirmation
- Portal renders correctly on mobile (iPhone SE → iPad Pro range)
- Disabling the portal hides all routes; firm can still operate fully through staff-side AR

### QUESTIONS
- Subdomain (`portal.firm.com`) or path (`firm.com/portal`) routing — affects Caddy config, SSL, and DNS guidance for customers
- Should portal show non-billing documents (engagement letters, signed returns) or strictly invoices/payments? Doc viewing expands scope significantly and overlaps with Vibe Connect.
- Should portal include a simple secure messaging feature, or always route messaging through Vibe Connect when configured?
- SMS cost cap per firm — hard limit, soft warning at threshold, or visibility only?
- Phone number recycling re-verification: annual? On every login from a new device? Only on profile update?

---

## Phase 17 — Reporting & analytics cube

**Goal:** Dimensional reporting cube. Every metric sliceable by timekeeper, client, engagement, service line, partner, office, fee structure, period.

**Items: 32**

### Items
1. Materialized view: `realization_view` rolling up `adjustment_allocation`
2. Materialized view: `utilization_view` (billable hours / available hours)
3. Materialized view: `profitability_view` (billed - loaded cost)
4. View refresh job (every 15 minutes via worker)
5. Realization report UI
6. Billing realization metric (billed / standard WIP)
7. Collection realization metric (cash / billed)
8. Effective rate metric (billed / hours)
9. Utilization metric
10. Profitability metric
11. WIP aging report
12. AR aging report (consumed from Phase 15)
13. Budget vs. actual on fixed-fee engagements
14. Period-over-period comparison
15. Recurring revenue dashboard (MRR, ARR, retention, expansion, churn)
16. Scope creep tracking (OOS hours trending up on retainer engagements)
17. Subscription engagement profitability dashboard
18. Partner book-of-business dashboard
19. Client lifetime value
20. Drill-through: summary → detail → time entries
21. Saved report definitions per user
22. Scheduled email delivery of saved reports
23. Excel / CSV export with formatting
24. Filter persistence in URL (shareable views)
25. Trend sparklines on each metric row
26. Anomaly highlighting (auto-flag deviations beyond N standard deviations)
27. Comparison overlays
28. Date range presets and custom range
29. Report permissions (some firms restrict partner-level data)
30. Realization narrative (AI-generated, consumed from Phase 23)
31. Sub-second query performance on materialized views via indexing
32. Background materialized view rebuild without blocking queries

### Acceptance
- Switch dimension filter from timekeeper to client and metric recomputes correctly
- Drill from firm realization 89% → David Park 81% → Holland audit engagement → individual time entries
- Saved report emails partner every Monday 8am with prior-week metrics
- Materialized view refresh completes in under 30 seconds on 100k time entries

### QUESTIONS
- Should we ship a BI tool API (e.g., for Tableau/Power BI) or stay closed for v1?
- Realization benchmark display (vs. industry — firm size, region) — interesting but data sourcing problem?

---

## Phase 18 — Approval workflows

**Goal:** Approval queue and routing engine. Used by adjustments, pre-bills, invoices, engagement letters.

**Items: 20**

### Items
1. Approval rule engine (declarative rules per entity type)
2. Approval request creation
3. Approval queue UI
4. Approve / approve-with-edits / reject actions
5. Multi-step approvals (manager → partner)
6. Delegation rules (out-of-office → backup)
7. Threshold rules (dollar / percent / role-based / reason-code-based)
8. Approval notifications via email
9. Approval notifications via Slack/MS Teams (Phase 24+ if integrated; deferrable)
10. Approval audit trail
11. Approver-by-name routing for specific engagements
12. Pending approvals dashboard per approver
13. SLA tracking (approval response time)
14. Auto-escalation after N hours pending
15. Approval modification log (who changed what, when)
16. Rule testing UI (dry-run a hypothetical adjustment)
17. Approval comments visible to requester
18. Approval reassignment by admin
19. Approval export
20. Approval metrics (avg time to approve, rejection rate per approver)

### Acceptance
- Adjustment >$1,000 routes to partner-in-charge automatically
- Out-of-office delegation correctly routes to backup
- Approve-with-edits modifies the adjustment and creates new audit entries
- Approval queue shows pending items only for current user

### QUESTIONS
- Slack/MS Teams notifications: which firms actually want this vs. email-only?
- Mobile approval flow: dedicated app screen or email magic-link?

---

## Phase 19 — Audit trail & compliance

**Goal:** Immutable audit log emitted on every state change. Filterable viewer. Retention policies. SOC 2-aligned controls. Includes portal access events with identity + active client context.

**Items: 15**

### Items
1. Audit log writer (middleware on all mutations across staff + portal)
2. Immutability via append-only table design
3. Time entry versioning (separate `time_entry_version` table)
4. Adjustment audit (already covered in Phase 12)
5. Invoice change log
6. User action log (auth, settings changes, exports — both staff and portal identity actors with active client context)
7. Audit log viewer UI
8. Filter by actor, entity type, action, date range
9. Full-text search on audit log
10. Audit log export
11. Retention policies per record type
12. Legal hold flag overrides retention
13. SOC 2 evidence reports (access reviews, change logs)
14. WISP template generator (firm-specific PDF)
15. Anomaly alerting (e.g., bulk delete, unusual access patterns from portal, entity-switch spikes)

### Acceptance
- Every mutation in the system produces an audit log row
- Audit log immutable in storage (no UPDATE/DELETE permissions for app role)
- Viewer filters correctly across 100k+ events
- Portal identity actions are distinguishable from staff actions and include `active_client_id` at time of action
- WISP generator produces a usable IRS Pub 4557 deliverable

### QUESTIONS
- Retention defaults — 7 years for tax-related, 5 years for general? Configurable but defaults matter.
- Audit log storage growth — partition by month, archive to cold storage after N years?

---

## Phase 20 — Administration UI

**Goal:** Firm settings, approval rules, reason codes, fee structures enabled, fiscal year, utilization config, portal configuration.

**Items: 15**

### Items
1. Firm settings page
2. Approval rules CRUD with threshold editor
3. Reason codes CRUD
4. Enabled fee structures toggles
5. Default adjustment allocation method picker
6. Fiscal year configuration
7. Standard hours per role
8. Billable hour targets per role
9. Holiday calendar
10. Office overrides
11. Permission matrix admin
12. Email and SMS template customization (staff and portal communications)
13. Branding (logo, colors) — applied across staff app, portal, invoice PDFs, emails
14. Portal configuration (subdomain/path, enable/disable, included features, SMS budget cap)
15. Backup/restore controls

### Acceptance
- Firm admin can change all settings without dev access
- Permission changes take effect within session refresh
- Branding changes propagate to email templates, invoice PDFs, and portal within 60 seconds

### QUESTIONS
- Email and SMS template customization scope — full WYSIWYG, or variable insertion only?

---

## Phase 21 — Integrations: email-in, webhooks, REST API

**Goal:** Lean integration surface. Email-to-time-entry, outbound webhooks, REST API, bulk export. No QBO/Xero sync in v1.

**Items: 16**

### Items
1. Email-in worker (parse BCC'd emails into draft time entries)
2. Email-in routing: extract client/engagement from From, Cc, subject
3. Email-in AI assist (Phase 23 dependency; degrade gracefully if AI unavailable)
4. Webhook endpoint CRUD
5. Webhook delivery (signed payloads)
6. Webhook retry on failure (exponential backoff)
7. Webhook delivery log
8. Webhook secret rotation
9. Webhook event catalog: invoice.sent, payment.received, payment.failed, adjustment.approved, timeentry.created, engagement.paused, portal_identity.created, client_portal_access.granted
10. REST API with API key auth
11. REST endpoints: list_engagements, get_time_entries, create_time_entry, list_invoices, get_realization
12. API rate limiting per key
13. API key management UI
14. Bulk export (full firm data, JSON or CSV)
15. Bulk import (for migration from prior systems)
16. Integration audit log

### Acceptance
- Email BCC'd to firm address creates draft time entry within 60 seconds
- Webhook delivery retries 3 times on 500 error, marks failed after
- REST API returns paginated time entries for an engagement
- Bulk export produces a complete firm snapshot

### QUESTIONS
- Bulk import format — define our own schema or support competitor exports (Karbon, Canopy, TaxDome)?

---

## Phase 22 — MCP server

**Goal:** Expose Time & Billing data and operations to AI agents (Claude Code, Cowork, external) via Model Context Protocol.

**Items: 12**

### Items
1. MCP server implementation (TypeScript SDK)
2. Tool: list_engagements (with filters)
3. Tool: get_time_entries (engagement, period, timekeeper)
4. Tool: create_time_entry (with validation)
5. Tool: generate_pre_bill (engagement, period)
6. Tool: suggest_adjustment (analyzes WIP, returns recommendation)
7. Tool: query_realization (dimensions and filters)
8. Tool: query_recurring_plans (status filter)
9. Token-based auth (per-user or per-agent tokens)
10. Per-tool permission scoping
11. MCP access audit log
12. MCP server config UI

### Acceptance
- Claude Code can connect to the MCP server with a token, list engagements, and create a time entry
- Permission scoping blocks an agent from calling tools it lacks access to
- All MCP calls audit-logged
- Token revocation immediate

### QUESTIONS
- Allow MCP tools that mutate (create_time_entry, suggest_adjustment as advisory only?) — security stance?

---

## Phase 23 — AI features (multi-provider)

**Goal:** Multi-provider AI abstraction (Claude API / Ollama / OpenAI-compatible). Embedded AI panels throughout the product.

**Items: 28**

### Items
1. Provider abstraction interface
2. Anthropic Claude provider
3. Ollama / llama.cpp local provider
4. OpenAI-compatible provider (for other local engines)
5. Provider routing: prefer local, fallback to cloud per feature config
6. Per-firm AI provider configuration
7. Per-feature provider toggle
8. AI request logging (`ai_request_log`)
9. Description suggestion from email + calendar context
10. Anomaly detection (unusual hour patterns)
11. Pricing suggestion for engagement renewal
12. Write-down pattern analysis (flag clients for repricing)
13. Scope creep detection on retainer engagements
14. Realization narrative (auto-generated period commentary)
15. Capacity forecasting from historical patterns
16. Plain-English query interface
17. Plain-English query: query → structured filter translation
18. Plain-English query: results rendering with citations
19. Reason-code suggestion from free-text adjustment notes
20. AI cost tracking per firm (token usage, dollar estimate)
21. AI cost dashboard
22. Voice transcription for time entry voice capture (Whisper or local equivalent)
23. AI panel UI components (consistent visual treatment)
24. AI panel embedded in time entry (description suggestions)
25. AI panel embedded in pre-bill review (adjustment recommendations)
26. AI panel embedded in reporting (narrative)
27. AI panel embedded in admin (pricing renewal suggestions)
28. AI feature opt-in/out per firm

### Acceptance
- Provider abstraction lets firm switch from Claude API to local Qwen without code changes
- Description suggestion proposes 3 candidate descriptions based on calendar event title and recent time entries
- Pricing suggestion correctly identifies under-priced engagements based on effective rate
- Plain-English query "show me partners below 85% realization in Q1" returns the correct dataset
- Realization narrative generated nightly for partner consumption

### QUESTIONS
- Local model recommendation defaults — Qwen3-8B Q4_K_M for general, Whisper.cpp small for voice?
- Cost cap per firm per month on cloud AI — hard cap or soft warning?

---

## Phase 24 — Vibe Connect integration

**Goal:** Route client notifications through Vibe Connect when firm has it. Engagement letter e-sign integration. Optional alternative to email/SMS-based portal notifications.

**Items: 8**

### Items
1. Vibe Connect API client
2. Connect configuration UI (server URL, API key)
3. Notification routing: invoice sent (alternative to portal email/SMS)
4. Notification routing: payment received
5. Notification routing: payment failed
6. Engagement letter e-sign request
7. Engagement letter signed → engagement state transition
8. Connect connection health check + degraded mode (falls back to email/SMS/portal)

### Acceptance
- Firm with Vibe Connect configured receives client-side invoice notifications via Connect
- Engagement letter signed via Connect auto-creates engagement record
- If Connect is down, Time & Billing degrades gracefully (falls back to portal email/SMS notifications)

### QUESTIONS
- Connect failure handling — queue and retry, or fall back to email/SMS-only?
- When Connect, portal email, and portal SMS are all configured, which takes precedence?

---

## Phase 25 — Distribution & deployment

**Goal:** Production Docker image, GHCR publishing, `vibe-installer` integration, three deployment modes (domain/LAN/Tailscale). Portal requires careful ingress configuration.

**Items: 15**

### Items
1. Production Dockerfile optimized for size
2. Multi-arch build (amd64 + arm64)
3. GitHub Actions publish to GHCR on tag
4. Semver tagging strategy
5. Caddy config templates for three deployment modes with two-host routing (staff + portal)
6. Cloudflare Tunnel configuration template (domain mode) — both hosts
7. LAN deployment guide (Tailscale serve) — portal access strategy in LAN mode
8. Tailscale-only deployment guide
9. `vibe-installer` integration (single-command deploy)
10. Database migration on container start
11. Health check endpoints (separate for staff, portal, api, worker)
12. Backup script: `pg_dump` to mounted volume
13. Restore script
14. Observability: structured JSON logging, Prometheus metrics endpoint
15. Upgrade path (running container → new version) — portal sessions invalidated on incompatible schema changes

### Acceptance
- `docker pull ghcr.io/kisaesdevlab/vibe-time-billing:0.1.0 && docker run ...` produces a working appliance with staff + portal both accessible
- `vibe-installer` from the appliance suite deploys cleanly
- Three deployment modes documented with copy-paste commands
- Portal accessible via correct route in all three modes (or explicitly disabled in LAN-only)
- Upgrade from v0.1.0 to v0.1.1 preserves data

### QUESTIONS
- Cloudflare Tunnel — single-tenant per appliance (customer-owned account, per architecture principle)?
- LAN-only deployment — does portal still make sense, or recommend domain-mode for portal customers?
- Observability: ship to firm-side Grafana or include built-in dashboard?

---

## Phase 26 — Polish, demo data, launch readiness

**Goal:** Final pass for performance, accessibility, demo experience, and onboarding.

**Items: 14**

### Items
1. Performance audit (Lighthouse on both staff and portal apps)
2. Bundle size optimization
3. Database query optimization (slow query log analysis)
4. Accessibility audit (WCAG AA target on both staff and portal)
5. Keyboard navigation throughout
6. Screen reader testing (portal especially — clients may be older, less tech-savvy)
7. Demo seed data generator (rich, multi-month firm with full history, multi-entity portal identities)
8. Onboarding wizard for new firms (includes portal setup step)
9. User documentation site
10. Client-facing portal help / FAQ
11. Video walkthroughs for key flows (firm-side and portal-side)
12. Migration guide from Karbon, TaxDome, Canopy
13. Pricing/licensing page on website
14. Beta cohort onboarding playbook

### Acceptance
- Lighthouse score >90 on performance, accessibility, best practices for both apps
- Demo data realistic enough for sales demos including multi-entity portal scenarios
- New firm completes setup including portal in under 30 minutes via wizard
- Portal passes WCAG AA audit
- All public docs published

### QUESTIONS
- Beta cohort selection — friends-of-firm or open application?
- Portal-specific marketing — separate landing page or absorbed into main product page?

---

## Cross-cutting concerns

### Testing strategy
- Unit tests: Vitest for `packages/db` query helpers, business logic
- Integration tests: spinning up test postgres + redis, exercising API endpoints
- End-to-end tests: Playwright for critical flows (time entry → pre-bill → adjustment → invoice → payment → portal view → entity switch → payment received)
- Allocation method tests: each of six methods has a dedicated test suite covering edge cases
- Portal E2E: separate Playwright project running against `apps/portal` to validate auth realm isolation and entity-switching correctness
- Snapshot tests on report queries (regression detection)

### Data migrations
- Drizzle migrations only (no manual SQL after Phase 2)
- Migration testing in CI on copy of production-shape data
- Zero-downtime deploys: additive-only migrations until v1.0

### Observability
- Structured JSON logs with request ID propagation
- Prometheus metrics: request latency, query duration, queue depth, AI provider latency, AI cost, portal sessions active, SMS send rate
- Error tracking (Sentry-compatible)
- Audit log doubles as forensic trail

### Security
- All sensitive staff endpoints require step-up auth (Phase 3)
- Portal sessions distinct from staff sessions; portal compromise cannot escalate to staff data
- Portal session scoped to `active_client_id` at all times; switching client is an audited action
- Portal cannot access engagement details outside billing scope of accessible clients
- API keys hashed at rest (bcrypt)
- Webhook signatures verified by consumers
- SMS rate limiting per identity, per phone number, and per firm
- AES-256 at rest for tokens and credentials
- TLS 1.3 only for ingress

### Performance targets
- p95 API response under 200ms (excluding AI endpoints)
- Materialized view refresh under 30s on 100k entries
- Time entry creation under 100ms end-to-end
- Report queries with full dimensional filtering under 500ms
- Portal first contentful paint under 1.5s on 4G
- Entity switch update under 200ms

---

## Out of scope for v1

These are deliberately deferred to v2 or beyond:

- QuickBooks Online / Xero sync (Vibe MyBooks is the GL, not QBO)
- Calendar sync (Outlook, Google) — cut from time entry capture
- Slack / MS Teams notifications — email-only for staff in v1; email+SMS for portal
- Bulk import adapters for Karbon, TaxDome, Canopy (CSV in v1; first-party importers later)
- Trust account / IOLTA support — legal-tech feature, not CPA-essential
- Multi-currency
- BI tool API (Tableau, Power BI direct connections)
- Multi-firm appliances (single-firm per appliance for v1)
- Cross-firm portal identities (same person at two firms gets two separate logins, one per appliance)
- Mobile native apps (PWA for v1, including portal)
- Client portal: viewing tax returns, engagement letters, secure messaging — billing only in v1, doc viewing in v2 (or via Vibe Connect)

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Adjustment allocation math edge cases produce wrong realization | Medium | High | Comprehensive test suite per method; allocation_amount sum constraint at DB level |
| Stripe / CPACharge integration breaks under failure | Medium | High | Idempotency keys, webhook signature verification, retry queue, manual reconciliation report |
| Portal auth realm leakage (staff session valid in portal or vice versa) | Low | High | Distinct session stores, distinct cookie names/paths, separate JWT signing keys; integration tests assert cross-realm rejection |
| Portal account enumeration via magic-link or SMS flow | Medium | Medium | Constant-time response regardless of email/phone existence; rate limit on send |
| Phone number recycling causes account takeover | Low | High | Phone verification on first use; periodic re-verification; step-up auth on sensitive actions |
| SMS gateway outage blocks client login | Low | Medium | Email remains an available fallback when both contact methods are on file; clear messaging when SMS unavailable |
| SMS cost overruns at large firms | Low | Medium | Per-firm SMS budget cap with visibility; default to email when both methods on file |
| Performance degrades on large firms (50+ timekeepers, 100k+ entries) | Medium | Medium | Materialized views, indexed queries, performance tests in CI with synthetic load |
| Migration from competitor tools is harder than expected | High | Medium | Start with CSV-based import; observe early customer pain; build per-competitor importers based on demand |
| Local LLM quality insufficient for production AI features | Medium | Medium | Provider abstraction lets firms switch to cloud; ship with sensible defaults; clearly mark "AI suggestion" vs. "AI decision" |
| Self-hosted appliance support burden grows | Medium | High | Strong observability, automated diagnostics, remote support tooling, documentation depth |
| Regulatory change (FTC Safeguards, IRS Pub 4557) affects compliance posture | Low | Medium | Audit log + retention controls give us flexibility; WISP template adapts |

---

## Open architectural decisions

Decisions deferred from individual phases that should be resolved before Phase 8 (or Phase 16 for portal-specific):

1. **Mixed-mode billing scope evaluation timing** — evaluate per time entry, or at billing batch creation?
2. **Hour bank refundability** — is residual balance refundable, convertible to credit, or forfeit at engagement close?
3. **Engagement auto-rollover collision** — what happens if last year's engagement is still in-progress when rollover triggers?
4. **Currency** — locked to USD for v1, or design for multi-currency from day one?
5. **Multi-firm appliance** — single firm only, or design schema for multi-tenancy now?
6. **MCP mutation scope** — agents can create time entries, or read-only with human-in-loop for writes?
7. **AI cost cap** — hard cap per month, soft warning, or just visibility?
8. **Portal subdomain vs. path routing** — affects Caddy config, customer DNS guidance, and SSL setup. Default recommendation: subdomain for domain-mode (`portal.firm.com`), path for LAN/Tailscale modes.
9. **Portal scope expansion** — billing-only in v1, or include document viewing? Affects scope creep and overlap with Vibe Connect.
10. **SMS cost cap model** — hard limit, soft warning, or visibility only? Affects firm-side admin and dunning logic when budget is exhausted.
11. **Phone re-verification cadence** — annual, on-new-device, or only on profile update? Tradeoff between security and friction.

---

## Notes for autonomous Claude Code execution

When working through phases:
- Always start by reading `CLAUDE.md` at repo root
- Open `QUESTIONS.md` and check for any unresolved items blocking the current phase
- Implement items in order within a phase
- Run `pnpm typecheck && pnpm lint && pnpm test` before marking an item complete
- For ambiguous decisions, append to `QUESTIONS.md` with phase number and continue with best-guess implementation
- Each phase ends with a smoke test against the Acceptance criteria
- Commit messages: `phase N · item description` for granular history
- Portal work (Phase 16) requires careful auth realm isolation — run cross-realm integration tests as part of acceptance
- Identity model: when working anywhere the portal touches data, remember that `portal_identity` is the actor and `active_client_id` (from session) is the scope. Both are required for audit log emission.
