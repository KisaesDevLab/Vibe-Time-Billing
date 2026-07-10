# CLAUDE.md — Vibe Time & Billing

**Repository:** `KisaesDevLab/Vibe-Time-Billing`
**License:** PolyForm Small Business License 1.0.0 (commercial license required for client portal access)
**Mode:** Autonomous build via Claude Code

You (Claude Code) are building this product end-to-end. This file is your standing operating manual. Read it first, every session, before doing anything else.

---

## Mental model

You are implementing a self-hosted Docker appliance for CPA practice time tracking, recurring billing, write-up/write-down adjustments with per-timekeeper realization attribution, dimensional reporting, and a branded client portal for invoice viewing and payment.

The product competes against Canopy (SaaS), Karbon (SaaS), TaxDome (SaaS) by offering: (1) self-hosting with full data sovereignty, (2) per-timekeeper allocation grain across six adjustment methods, (3) seven fee structures natively, (4) identity-based client portal with multi-entity access and email-or-SMS login, (5) MCP server for AI agent integration, (6) local-first AI with multi-provider abstraction, (7) per-firm unlimited annual licensing that breaks the per-seat treadmill.

---

## Required reading order (every session)

1. **`CLAUDE.md`** — this file
2. **`BUILD_PLAN.md`** — 26 phases, ~513 items, acceptance criteria
3. **`QUESTIONS.md`** — locked decisions above the line; open questions below

Then resume from the current phase. Find current phase by:
- Scanning `git log --oneline` for last `phase N · ...` commit
- Or checking the in-progress section in the latest progress note

---

## Workflow loop

For each item in the current phase:

1. **Read** the item description and its acceptance criteria
2. **Plan** the smallest implementation that satisfies the criteria; if 2+ approaches are viable, pick the one most consistent with existing patterns
3. **Implement** the change
4. **Verify** with the smallest test that proves the item works
5. **Validate**: `pnpm typecheck && pnpm lint && pnpm test`
6. **Commit**: `phase N · item M · brief description` (one commit per item; squash only when items are tightly coupled)
7. **Move on**

At end of each phase:
- Run the phase's acceptance criteria as smoke tests
- Update progress notes
- Open a phase-summary commit: `phase N · complete · brief summary`

---

## Locked architectural decisions

These come from `QUESTIONS.md` and must be respected everywhere they touch.

### Appliance & data
1. **Single firm per appliance.** No multi-tenant. Schema has `firm_id` columns but no tenant resolver middleware.
2. **USD only for v1.** No currency columns on monetary tables. No FX logic.
3. **Soft delete always** for clients, engagements, time entries. `status` enum with `ARCHIVED` value; never `DELETE FROM`. Audit log records the archive event.

### Authentication & sessions
4. **Step-up TOTP timeout: 30 minutes** after last verification. Sensitive actions re-prompt only after this window.
5. **Every staff user has at least one second factor enrolled** — passkey (WebAuthn), TOTP, email OTP, or SMS OTP. (Revised by migration 0087 + the follow-up passkey login work; was "TOTP required for all staff" prior.) The factor is challenged after both magic-link verification and password sign-in. Passkeys may also act as the primary sign-in method, in which case the WebAuthn assertion itself counts as the step-up. Recovery codes are generated when TOTP is enrolled and shown once.
6. **Phone re-verification on every new device** for portal_identity. Fingerprint by IP + user-agent (best-effort); on mismatch, send SMS OTP confirming the new device before issuing session.

### Payments
7. **Firm owns the Stripe account (default).** The primary model is unchanged: the firm pastes its own Stripe API keys (Secret / Publishable / Webhook-signing) into **Admin → Billing → Stripe Connect** (encrypted at rest) or sets them as appliance env vars; Kisaes never holds the firm's keys. **Revision (P08+):** in addition, an **optional** Stripe **Connect Standard (OAuth)** path now exists for operators who configure a platform `STRIPE_CONNECT_CLIENT_ID` — the firm clicks "Connect Stripe" to link its own (Standard) account via OAuth. It is opt-in (hidden unless the operator sets the platform client id) and powers proposal-payment collection and Stripe Terminal (in-person readers provision against the connected account). This supersedes the original "no Stripe Connect" clause; firm-owned, customer-controlled credentials remain non-negotiable in both modes.
8. **No trust account / IOLTA support.** Don't add the schema, don't add the UI.
9. **Payment processor fees: per-engagement configurable.** Boolean `fee_passthrough_enabled` on engagement. When true, invoices auto-add a "processing fee" line item calculated from card vs ACH rates.

### Infrastructure
10. **Subdomain routing.** `app.firm.com` for staff, `portal.firm.com` for portal. Distinct cookies (`__vibe_app_session` vs `__vibe_portal_session`). Distinct JWT signing keys. Caddy config templates support both hosts. Cross-realm cookie reuse is impossible.
11. **Pluggable email delivery.** Provider abstraction: SMTP, Postmark, Resend, AWS SES. Env vars: `MAIL_PROVIDER`, `MAIL_FROM`, plus provider-specific keys. Default in dev is SMTP to MailHog.
12. **Backup: nightly pg_dump cron** to mounted volume `/backups`. Retention 30 days, configurable. Documented restore procedure in `ops/restore.md`.

### AI & MCP
13. **MCP server has full read+write mutation.** Per-tool permission scoping enforced via token claims. Token issuance UI in admin (Phase 22). Mutating tools (create_time_entry, generate_pre_bill, etc.) audit-log every call with the token identifier as actor.
14. **AI cost cap: hybrid (warn then cap).** Per-firm monthly budget. Default threshold: warn at 80%, hard-cap at 100%. Track in `ai_request_log`. Surface in admin dashboard.
15. **Local LLM: hardware-adaptive at install.** Detection script in `scripts/install-detect-llm.sh` runs at first boot. Picks Qwen3-8B Q4_K_M for ≥16GB RAM, Phi-3-mini Q4_K_M for ≥8GB, Mistral Small 24B Q4_K_M for ≥24GB and AVX2. Firm can override post-install.

### SMS & notifications
16. **Pluggable SMS.** Provider abstraction: TextLink (default, already in Vibe stack), Twilio, AWS SNS. Same env-var pattern as email.
17. **SMS cost: visibility only.** No hard cap. Surface monthly spend and per-event volume in admin dashboard. Document budget guidance in admin tooltips.

### PDF generation
18. **Puppeteer for all PDFs** (invoices, pre-bills, statements, engagement letters). Templates are HTML+CSS served from `apps/api/src/pdf-templates/`. Bundle Chrome in the production image. Document the ~300MB bloat in `ops/image-size.md`.

### Billing UX
19. **Time-entry rounding default: 0.25 hour** (15-minute increments). Firm-configurable in admin: 0.1, 0.25, or free decimal.
20. **Mixed-mode scope: per-entry real-time tagging.** Engagement has `in_scope_work_code_ids` array. When a time entry is created with a work code in that array, `in_scope_flag = true`; otherwise false. Computed at write time, not read time.
21. **Custom weighted allocation: user toggles between percent and dollar** per adjustment. Allocation dialog has a segmented control. Server validates whichever was submitted (percentages sum to 100, or dollars sum to total).

### Engagement lifecycle
22. **Hour bank residual: forfeit on close.** No refund, no credit. Engagement-letter template starter pack must include clear forfeit-disclosure language.
23. **Auto-rollover collision: notify partner, partner decides.** Don't auto-create the new engagement; queue a decision notification in the partner's approval dashboard. Three options exposed: create new and leave old open, defer rollover, force-close old with WIP carry-forward.
24. **Engagement template starter pack ships pre-built.** Phase 5 seed includes: Individual 1040, 1120-S, 1065, Audit, Review, Compilation, Monthly Bookkeeping, Payroll Services. Each template has default fee structure, default work codes, default in-scope codes, default budget guidance.

### Business model & invoice composition
25. **License: per-firm unlimited annual.** Single fee, no user counting, no client-entity counting. Pricing TBD pre-launch.
26. **Invoice consolidation: per-client preference.** New field on client: `invoice_consolidation_preference` enum (`CONSOLIDATED` | `SEPARATE`), default `SEPARATE`. Pre-bill UI honors this when generating invoices.
27. **Adjustment approval threshold: $1,000 default, firm-configurable.** Settings table stores `adjustment_approval_threshold_cents`. Future enhancement: percentage-based; not in v1.

### Operational
28. **Email/SMS templates: variable insertion only.** Templates are stored as text with `{{client.name}}`, `{{invoice.total}}`, `{{invoice.due_date}}` markers. No HTML editor, no Markdown rendering. Use Handlebars for substitution. Firms see a variable picker UI.
29. **Account enumeration: standard mitigation.** Same response (and HTTP status) whether contact exists or not. Generic "If your account exists, a code has been sent" message. Redis-backed sliding-window rate limit: 5 requests per contact per 15 minutes, 20 requests per IP per 15 minutes. No timing delays, no IP bans.
30. **Invoice read receipts: portal-view only, no tracking pixels.** Read receipts fire only when the client views the invoice through the portal. No tracking pixel in email. Firms see "Viewed in portal" vs "Not yet viewed".

---

## Tech stack (locked)

- **Runtime:** Node.js 24 (`.nvmrc`)
- **Language:** TypeScript 5.x, `strict: true`, no `any` without explicit `// reason` comment
- **Monorepo:** pnpm workspaces
- **Web framework (staff):** React 18 + Vite + React Router 6
- **Web framework (portal):** React 18 + Vite + React Router 6 (separate app)
- **API:** Express 4 + tsx for dev hot-reload
- **Workers:** BullMQ on Redis 7
- **Database:** PostgreSQL 16 + Drizzle ORM
- **Cache & queues:** Redis 7
- **Ingress:** Caddy v2 (templates in `ops/caddy/`)
- **PDF:** Puppeteer
- **Email:** Pluggable (SMTP / Postmark / Resend / SES)
- **SMS:** Pluggable (TextLink / Twilio / AWS SNS)
- **AI:** Multi-provider abstraction (Anthropic Claude API, Ollama, OpenAI-compatible)
- **Auth:** Magic-link + TOTP (staff); magic-link + SMS OTP (portal)
- **Containerization:** Docker, multi-stage build, multi-arch (amd64 + arm64)
- **CI:** GitHub Actions
- **Distribution:** GHCR (`ghcr.io/kisaesdevlab/vibe-time-billing`)

---

## Monorepo layout

```
/
├── apps/
│   ├── web/              # React staff app (port 5173 dev)
│   ├── portal/           # React client portal app (port 5174 dev)
│   ├── api/              # Express API (port 3001 dev)
│   └── worker/           # BullMQ workers
├── packages/
│   ├── db/               # Drizzle schema, migrations, query helpers
│   ├── types/            # Shared TS types
│   ├── ui/               # Shared React component library
│   └── core/             # Domain logic (rate resolution, allocation math, etc.)
├── ops/
│   ├── caddy/            # Caddy config templates per deployment mode
│   ├── docker/            # Dockerfile, docker-compose.dev.yml, prod compose
│   ├── scripts/          # install, backup, restore, upgrade
│   └── docs/             # ops runbooks
├── seed/                 # Phase 5 starter pack (engagement templates, etc.)
├── BUILD_PLAN.md
├── CLAUDE.md             # this file
├── QUESTIONS.md
├── README.md
├── LICENSE.md            # PolyForm Small Business License 1.0.0
└── package.json
```

---

## Coding standards

### TypeScript
- `strict: true` across all `tsconfig.json` files
- No `any`; use `unknown` + narrowing
- Prefer discriminated unions over enums for variant types
- `// reason: <reason>` comment required for any non-obvious type assertion

### Imports
- Absolute imports from monorepo packages (`@vibe/db`, `@vibe/types`)
- Relative imports within a package
- Sort: stdlib → external → workspace → relative

### Naming
- Tables: `snake_case` (Drizzle convention)
- TS variables and functions: `camelCase`
- Types and interfaces: `PascalCase`
- Constants: `SCREAMING_SNAKE_CASE`
- Files: `kebab-case.ts`, except React components which are `PascalCase.tsx`

### Error handling
- API endpoints throw typed errors caught by a single error middleware that maps to HTTP responses
- Never silently swallow errors
- Log structured JSON with request ID propagation

### React
- Function components only
- Custom hooks for data fetching (TanStack Query)
- No prop drilling beyond 2 levels — use context or composition
- Tailwind for styling (utility-first); design tokens in `packages/ui/tokens.ts`

### Database
- Drizzle migrations only; no manual SQL post-Phase-2
- Every mutation goes through a query helper in `packages/db/src/queries/`
- Every mutation emits an `audit_log` row
- Use `db.transaction()` for any multi-row operation
- Indexes on all FK columns + high-cardinality query columns

---

## Testing standards

### Unit tests (Vitest)
- Every query helper in `packages/db/` has a unit test
- Every domain function in `packages/core/` has a unit test
- Allocation methods (Phase 12) have an exhaustive test suite — every method × 5+ scenarios, including symmetric write-up

### Integration tests
- Spin up postgres + redis in `docker-compose.test.yml`
- Exercise API endpoints with `supertest`
- Test fixtures in `apps/api/src/__tests__/fixtures/`

### E2E tests (Playwright)
- Critical flows: time entry → pre-bill → adjustment → invoice → payment → portal view → payment received
- Cross-realm isolation: staff session never works in portal and vice versa
- Multi-entity portal: identity with 3 client accesses can switch and see scoped data

### Test commands
- `pnpm test` — all tests
- `pnpm test:unit` — unit only
- `pnpm test:integration` — integration only
- `pnpm test:e2e` — Playwright

---

## Security invariants

- **Passwords are stored as argon2id digests** (never plaintext). Magic-link sign-in remains available alongside password sign-in — staff may use either. See QUESTIONS.md decision #5 (revised by migration 0087).
- **Never log secrets, API keys, or tokens** — even in dev
- **Hash all tokens at rest** (bcrypt for API keys, SHA-256 for session/magic-link/OTP tokens)
- **CSRF** via SameSite=Strict cookies + double-submit token on mutating endpoints
- **TLS 1.3 only** at Caddy ingress
- **No staff session is valid in portal**, no portal session is valid in staff — distinct cookie names, paths, and signing keys
- **Audit log is append-only** at the DB role level (Postgres `REVOKE UPDATE, DELETE` on the app role)
- **Every mutation produces an audit_log row** with actor_app_user_id OR actor_portal_identity_id (mutually exclusive), entity_type, entity_id, action, before/after JSON, timestamp, IP, user-agent

---

## When you're blocked

If you encounter a decision that:
1. Is not in `QUESTIONS.md` answered section
2. Materially affects the implementation
3. Cannot be inferred from existing patterns or this file

Then:

1. **Pick the most conservative default** consistent with the architectural principles above
2. **Add an entry to the OPEN section of `QUESTIONS.md`** with:
   - Phase number
   - Item number
   - Question text
   - Options considered
   - Default you picked and why
3. **Keep going.** Don't block on the question.

The default you picked must be reversible — if it bakes into schema or core architecture, escalate harder (commit a `WIP` and stop, write up the decision, wait for explicit answer in next session).

---

## What "done" looks like for a phase

A phase is done when:
- [ ] Every item is implemented and committed
- [ ] `pnpm typecheck && pnpm lint && pnpm test` passes clean
- [ ] All acceptance criteria smoke-test successfully
- [ ] No open `QUESTIONS.md` items are blocking the next phase
- [ ] A `phase N · complete · summary` commit closes out the phase

Then move to the next phase. Don't skip phases. Don't work on multiple phases in parallel.

---

## Communication style for commits and progress notes

- Be terse. The git log is for future archaeology, not narrative.
- One commit, one logical change.
- Explain *why* in commit body when the *what* isn't obvious.
- Progress notes (if any) live in `ops/docs/progress/phase-N.md` and capture: items completed, items deferred, surprises encountered, decisions deferred to QUESTIONS.md.

---

## Non-negotiables

These cannot be relaxed regardless of expedience:

1. **Audit log immutability.** Every state change creates an audit row. The app role has no UPDATE or DELETE on `audit_log`.
2. **Cross-realm session isolation.** Staff and portal sessions are distinct in every dimension. There is no shared session table, no shared cookie, no shared signing key.
3. **Standard rate snapshot.** Time entries capture the rate at the moment of creation. Historical reports never shift when rates change.
4. **Per-timekeeper allocation grain.** `adjustment_allocation` rows are at the (adjustment_id, time_entry_id, app_user_id) grain. Aggregations roll up FROM this grain, never the other way.
5. **Customer-owned external resources.** Firm owns their Stripe account, their Cloudflare account, their domain. Kisaes never holds customer credentials.
6. **License gate on portal.** The client portal feature requires a commercial license token. The token check runs at app boot and on critical portal routes. Token absence disables the portal cleanly (clear message, no crashes).
7. **PolyForm Small Business License 1.0.0.** Every source file has the license header. No GPL or AGPL dependencies (license-check in CI).

---

## Definition of the autonomous loop

You are operating under autonomous-build constraints. The user (Kurt) is not actively watching. You:

- Read this file, BUILD_PLAN.md, QUESTIONS.md
- Execute phases in order
- Run tests after every item
- Commit small, frequently, descriptively
- Append blockers to QUESTIONS.md with sensible defaults and keep going
- Stop only when:
  - A phase's acceptance criteria fail in a way you can't fix
  - You hit a decision that bakes irreversibly into schema or architecture without an answer
  - The plan itself is internally contradictory

When you stop, write a `WIP` commit with a clear `STOPPED_BECAUSE.md` at repo root explaining what's needed. Then end the session.
