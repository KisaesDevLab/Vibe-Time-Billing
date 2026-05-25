# QUESTIONS.md — Vibe Time & Billing

This file is a structured log of architectural and policy decisions. **Locked decisions are above the line**; they were resolved before the autonomous build began and cannot be changed without the explicit consent of the maintainer. **Open questions are below the line**; they may be added during the build when Claude Code encounters a decision not covered by locked answers.

## How Claude Code uses this file

1. Read every locked decision at session start. Treat as architectural law.
2. When encountering a decision not covered: pick the most conservative default consistent with `CLAUDE.md` principles, add to the Open section below with phase + item context, keep building.
3. Never modify locked decisions. If a locked decision turns out to be wrong, write a `WIP` commit and `STOPPED_BECAUSE.md` describing the conflict.

---

# LOCKED DECISIONS

## Section A · Schema foundations

### Q1 — Appliance scope
**Decided:** Single-firm per appliance.

Every appliance instance hosts exactly one CPA firm's data. Schema includes `firm_id` columns on top-level tables but there is no tenant resolver middleware in the API. No support for hosting multiple firms on one box. This matches the rest of the Vibe product family.

### Q2 — Currency
**Decided:** USD only for v1.

No `currency` column on monetary tables. All amounts in cents (integer). No FX logic, no conversion at report time. Multi-currency may come in v2; schema migration cost is acceptable then.

### Q3 — Delete strategy
**Decided:** Soft delete always for clients, engagements, and time entries.

`status` enum on each of these tables includes an `ARCHIVED` value. Code never executes `DELETE FROM`. Archive action is itself audit-logged. Background reaper job not in v1; rows accumulate (acceptable through 100K+ entries per benchmark).

---

## Section B · Authentication & sessions

### Q4 — Step-up TOTP timeout
**Decided:** 30 minutes after last verification.

Sensitive actions (large adjustment, invoice send, payment-method change, rate change) require TOTP re-verification only after 30 minutes have elapsed since the last successful step-up. Stored as `last_step_up_at` on `app_session`. Configurable in firm settings for v1.1.

### Q5 — TOTP enrollment scope
**Decided:** Required for all staff.

Every `app_user` must enroll TOTP at first login. No magic-link-only paths. Recovery codes generated and shown once; user confirms storage before proceeding. Skipping enrollment is impossible.

### Q6 — Phone re-verification cadence (portal_identity)
**Decided:** On every new device.

Device fingerprint = SHA-256 of (normalized user-agent ‖ /24 IP prefix). On unrecognized fingerprint at SMS login attempt, send an additional confirmation SMS to the recorded phone before issuing the session. This catches recycled-number takeover where the attacker is on a different device than the legitimate user historically was.

---

## Section C · Payments

### Q7 — Stripe charge model
**Decided:** Firm owns the Stripe account (BYO API keys).

Firm creates their own Stripe account, generates restricted API keys, pastes them into appliance admin settings. Stripe pays the firm directly. No Stripe Connect, no Kisaes-owned platform account, no money-transmission compliance surface for us.

### Q8 — Trust account / IOLTA
**Decided:** Out of scope for v1.

No trust account schema, no IOLTA-specific UI or reporting. Firms doing fiduciary work need a separate tool for that.

### Q9 — Payment processor fee handling
**Decided:** Firm-configurable per engagement.

Engagement table has `fee_passthrough_enabled: boolean` (default false). When true, invoice generation auto-adds a "Payment processing fee" line item calculated from the payment method used (or from card rates as the default until paid). When false, firm absorbs.

---

## Section D · Infrastructure

### Q10 — Portal vs staff app routing
**Decided:** Subdomain split.

`app.firm.com` for staff (`apps/web`), `portal.firm.com` for portal (`apps/portal`). Caddy templates support both hosts. Cookies use `__vibe_app_session` (path=/, domain=app.firm.com) and `__vibe_portal_session` (path=/, domain=portal.firm.com). Distinct JWT signing keys: `STAFF_JWT_SECRET` and `PORTAL_JWT_SECRET`. Setup docs explain DNS requirements and Cloudflare Tunnel hostnames.

### Q11 — Email delivery
**Decided:** Pluggable provider abstraction.

Providers: SMTP, Postmark, Resend, AWS SES. Env vars:
- `MAIL_PROVIDER` = smtp | postmark | resend | ses
- `MAIL_FROM` = e.g. "Granite Peak CPAs <[email protected]>"
- Provider-specific keys (e.g. `MAIL_SMTP_HOST`, `MAIL_POSTMARK_TOKEN`, etc.)

Dev defaults to SMTP pointed at a MailHog container in `docker-compose.dev.yml`.

### Q12 — Database backup strategy
**Decided:** pg_dump nightly cron.

`ops/scripts/backup.sh` runs daily at firm-local 02:00 via container-side cron. Output to `/backups/vibe-tb-YYYY-MM-DD.sql.gz`. Default 30-day retention. Restore procedure documented in `ops/docs/restore.md`. WAL archiving and streaming replication considered out-of-scope for v1.

---

## Section E · AI & MCP

### Q13 — MCP server mutation scope
**Decided:** Read + write (full mutation) with per-tool permission scoping.

Tools include mutating operations: `create_time_entry`, `generate_pre_bill`, `suggest_adjustment` (advisory result), and write actions on engagements/invoices in v1.1+. Each MCP token has a JSON-encoded list of allowed tool names; tools not in the list reject with 403. Every mutating tool call audit-logs with the token identifier as actor. Token issuance UI is part of Phase 22.

### Q14 — AI cost cap
**Decided:** Hybrid — warn then cap.

Per-firm monthly budget in `firm_settings.ai_monthly_budget_cents`. Default warn threshold: 80%. Default hard-cap: 100%. When budget exhausted, AI features return a clear error message ("AI budget exhausted for this month, will reset on the 1st"). Tracked in `ai_request_log` with cost computed per provider's rate sheet.

### Q15 — Local LLM default model
**Decided:** Hardware-adaptive at install time.

`ops/scripts/install-detect-llm.sh` runs at first boot:
- ≥24GB RAM + AVX2 → Mistral Small 24B Q4_K_M
- ≥16GB RAM → Qwen3-8B Q4_K_M (default for the GMKtec M6 spec)
- ≥8GB RAM → Phi-3-mini Q4_K_M
- <8GB → AI features disabled, prompt firm to upgrade or enable cloud LLM

Firm can override post-install in admin settings.

---

## Section F · SMS & notifications

### Q16 — SMS provider
**Decided:** Pluggable provider abstraction.

Providers: TextLink (default — already in Vibe stack), Twilio, AWS SNS. Env vars mirror the email pattern:
- `SMS_PROVIDER` = textlink | twilio | sns
- Provider-specific keys

### Q17 — SMS cost cap
**Decided:** Visibility only.

No hard cap. Surface monthly SMS spend and per-event volume in admin dashboard. Document budget guidance and a "danger zone" threshold in admin tooltips. If a firm wants a hard cap they can add one in v1.1.

---

## Section G · PDF generation

### Q18 — PDF rendering library
**Decided:** Puppeteer (headless Chrome, HTML→PDF).

Templates are HTML+CSS served from `apps/api/src/pdf-templates/`. Chrome bundled in the production Docker image. Image bloat (~300MB) accepted for the design flexibility. Document the size in `ops/docs/image-size.md`. Concurrent PDF generation worker count = CPU cores / 2.

---

## Section H · Billing UX defaults

### Q19 — Time entry rounding increment
**Decided:** 0.25 hour (15-minute increments) by default.

Firm-configurable in admin: 0.1, 0.25, or free decimal. Time entry form's hours input snaps to the configured increment on blur.

### Q20 — Mixed-mode billing scope evaluation
**Decided:** Per-entry, real-time tagging.

`engagement.in_scope_work_code_ids: uuid[]` array. When a time entry is created and its work_code_id is in this array (or it's the engagement's default scope), `in_scope_flag = true`; otherwise false. Stored on the entry row, never recomputed. Scope definition changes mid-period only affect entries created after the change.

### Q21 — Custom-weighted allocation input type
**Decided:** Either, user picks per adjustment.

Allocation dialog has a segmented control: [Percentages] [Dollar amounts]. Server validates whichever was submitted. Percentage path requires sum to 100.00 (with 0.01 tolerance). Dollar path requires sum to equal `adjustment.total_amount`.

---

## Section I · Engagement lifecycle

### Q22 — Hour bank residual at engagement close
**Decided:** Forfeit at engagement close.

No refund, no credit. The engagement-letter template starter pack must include clear forfeit-disclosure language ("Unused hours are forfeited at engagement termination"). Admin UI shows a hard warning when closing an engagement with remaining hour bank balance.

### Q23 — Auto-rollover collision behavior
**Decided:** Notify partner, partner decides.

When the rollover scheduler is about to create next year's engagement but the prior year is still `ACTIVE`, the system queues a notification in the partner-in-charge's approval queue with three actions:
- **Create new and leave old open** (both run in parallel; manual close of old)
- **Defer rollover** (postpone to a specified date)
- **Force-close old with WIP carry-forward** (audit-log the close, carry remaining WIP to new)

### Q24 — Engagement template library
**Decided:** Ship with starter pack.

`seed/engagement-templates.json` contains pre-built templates:
1. Individual 1040
2. 1120-S Tax Return
3. 1065 Partnership Tax Return
4. Audit Engagement (GAAS)
5. Review Engagement (SSARS)
6. Compilation Engagement (SSARS)
7. Monthly Bookkeeping
8. Payroll Services

Each template defines: default fee structure, default work codes, default in-scope codes, default budget hours, default engagement-letter content with all required disclosures. Phase 5 loads these at firm initialization unless suppressed.

---

## Section J · Business model & invoice composition

### Q25 — License model
**Decided:** Per-firm unlimited annual.

One annual fee per firm. No user counting, no client-entity counting. License token is checked at boot and on critical portal routes. Token absence disables the portal cleanly with a clear admin message. Pricing TBD pre-launch (capture in `LICENSING.md` close to release).

### Q26 — Multi-engagement consolidated invoice default
**Decided:** Per-client preference.

`client.invoice_consolidation_preference: enum('CONSOLIDATED' | 'SEPARATE')`, default `SEPARATE`. Pre-bill UI honors this when generating invoices for clients with multiple active engagements. Override available per billing batch.

### Q27 — Adjustment approval threshold
**Decided:** Configurable per firm with $1,000 default.

`firm_settings.adjustment_approval_threshold_cents = 100000` at seed. Approval workflow (Phase 18) routes adjustments above this amount to partner-in-charge approval. Percentage-based thresholds (e.g., 5% of engagement total) deferred to v1.1.

---

## Section K · Operational

### Q28 — Email & SMS template customization
**Decided:** Variable insertion only.

Templates are text with Handlebars-style markers: `{{client.name}}`, `{{invoice.total}}`, `{{invoice.due_date}}`, `{{firm.name}}`, etc. Admin UI shows a variable picker. No HTML editor, no Markdown rendering. Templates rendered server-side. Predefined variable catalog documented in `ops/docs/template-variables.md`.

### Q29 — Account enumeration mitigation
**Decided:** Standard mitigation.

Same HTTP response status and body whether the contact exists or not. Generic message: "If your account exists, a sign-in code has been sent." Redis-backed sliding-window rate limits:
- 5 requests per contact per 15 minutes
- 20 requests per IP per 15 minutes
- 100 requests per firm per 15 minutes (firm-level circuit breaker)

No timing delays, no IP bans. Limits configurable but defaults shipped.

### Q30 — Invoice read receipts
**Decided:** Portal-view only, no tracking pixels.

Read-receipt fires only when the client opens the invoice within the portal (sets `invoice.first_viewed_at`). No tracking pixel in invoice emails. Firms see "Viewed in portal Mon May 18" vs "Not yet viewed" in the invoice list. Portal-view events also stream into the audit log.

---

## Section L · Connect Integration *(from CONNECT_INTEGRATION_ADDENDUM.md §5)*

These seven decisions govern the Connect-style features absorbed into TB (messaging, escrow files, client requests, unified portal, envelope encryption at rest). The original addendum's IDs Q1–Q7 are preserved in parentheses for cross-reference.

### Q34 — Appliance unlock mode *(addendum Q1)*
**Decided:** Sealed-on-disk default; admin-passphrase as per-firm opt-in.

Default mode reads the KEK from `${DATA_DIR}/.firm-key.seal` (mode `0400`) at boot — unattended restart, suitable for uptime-focused firms. Admin-passphrase opt-in derives the KEK via Argon2id from a passphrase POSTed to `/api/staff/admin/unlock`; until unlocked the appliance serves 503. **Lost passphrase = unrecoverable data.** Migration sealed-on-disk → admin-passphrase is one-way (no UI to revert).

### Q35 — Time-entry message link cap *(addendum Q2)*
**Decided:** Unlimited; paginate in pre-bill UI.

`time_entry_message_link.sequence INTEGER` enforces stable display order. Pre-bill view renders the first 5 inline; remainder behind a "Show N more" pagination control (server-side, 10/batch). No hard ceiling on the link table.

### Q36 — Client-request suggestion expiration *(addendum Q3)*
**Decided:** Configurable per firm; default 7 days.

`firm_config.suggestion_expiration_days` (default 7, range 1–365). Hourly BullMQ sweep marks `client_request_time_entry_link` rows past `expires_at` as dismissed with reason `'expired'`.

### Q37 — Escrow staff visibility *(addendum Q4)*
**Decided:** Firm-configurable; default = any staff with engagement access.

`firm_config.escrow_visibility text` with values `'engagement-access'` (default) or `'partner-and-assigned-only'`. Never visible to portal clients regardless of mode — that's the whole point of escrow.

### Q38 — Step-up rate limit *(addendum Q5)*
**Decided:** 5 attempts / 15 min → 30 min lockout.

`apps/api/src/auth/step-up-middleware.ts` records failures per `appUserId` in Redis (`step-up:failures:<id>`, TTL 900s). At 5 failures the key flips to `step-up:lockout:<id>` (TTL 1800s). 6th+ attempts return `{error: 'step_up_locked_out', retryAfter}` (HTTP 429).

### Q39 — MCP egress policy *(addendum Q6)*
**Decided:** Local-only default; per-firm API opt-in; **Vibe Shield required if API enabled.**

`firm_config.ai_egress_enabled boolean default false`. When true, all AI calls route through `firm_config.vibe_shield_endpoint`; Shield unreachable = MCP tools requiring egress deregister at startup with a clear admin banner. Vibe Shield doesn't exist yet, so egress mode currently fails closed.

### Q40 — Portal authentication source *(addendum Q7)*
**Decided:** TB's native portal-auth (NOT `@vibe/portal-auth`).

Per the TB-standalone framing, the original addendum's plan to fold portal auth into a `@vibe/portal-auth` shared package was dropped. TB's existing magic-link + SMS-OTP flow (`apps/api/src/auth/portal-routes.ts`, `apps/api/src/auth/portal-middleware.ts`) remains the sole portal auth surface.

---

# OPEN QUESTIONS

*Append questions encountered during the build here. Format: phase, item, question, options considered, default chosen, why. Decisions accumulate over time; this is the running deferral log, not a blocker.*

## Q31 — File manager rebuild path [files phase 0]
Context: `FILE_MANAGER_ADDENDUM.md` v1 specifies a B2-backed sentinel-bound file manager that fundamentally conflicts with the v1 implementation shipped under migrations 0037 + 0038 (`client_folder` hierarchical, `client_file` flat, no virtual-drive coexistence).
Assumed default: Replace the existing implementation. Drop `client_folder`, `client_folder_template`, `client_file` and their code in Phase 0. Stub `apps/api/src/clients/files.ts` with `410 Gone` until Phase 8 reintroduces uploads against the new schema.
Implication if wrong: If existing customer data lived in `client_file`, it's lost. Accepted because no real production data is at risk at this point.

## Q32 — B2 storage stub for development [files phase 1]
Context: Addendum requires B2 as the canonical storage. B2 credentials are not yet available.
Assumed default: Ship a `MockStorageClient` that implements the same `StorageClient` interface but writes under `STORAGE_LOCAL_PATH` (default `/data/storage-mock`). Production deploys flip `STORAGE_PROVIDER=b2` + the `B2_*` vars; tests gate the real-B2 integration suite behind `B2_INTEGRATION=1`.
Implication if wrong: B2-specific quirks (consistency semantics, multipart upload, ETag format) won't be exercised until real wiring lands. Acceptable for v1 dev; documented in the master plan as deferred work.

## Q33 — Pending-upload column placement [files phase 5/8]
Context: Phase 8 needs a `pending_upload` flag on `files` rows to mark in-flight presigned uploads.
Assumed default: Add the column in the Phase 5 migration (`0046_files_storage_files.sql`) rather than a separate Phase 8 migration, since the schema for `files` is already being defined in that migration and adding the flag early is cheaper than a follow-up ALTER.
Implication if wrong: If Phase 5 ships before Phase 8 we have a useless boolean column for ~one phase of life. Acceptable.

## Q34 — Multi-signer scope for Proposals v1 [proposal P01]
Context: `ADDENDUM-PROPOSAL-MODULE.md` §0.3 #1. Partnership/S-corp/audit engagements often require ≥2 signers. The addendum locks "single-signer UI" for v1 but requires schema to remain plural so v1.5 only ships UI work.
Assumed default: **Schema plural, UI single-signer.** `signatures` table from day one (no inline `signature_*` columns on `proposals`). Acceptance portal hides the "add signer" UI but the API tolerates ≥1 row. The reverted PP0 violated this by putting signature columns inline on `proposal`; the new P01 migration uses the plural design.
Implication if wrong: If we needed multi-signer UI in v1, only the acceptance flow changes — no schema migration. If we needed inline columns instead, we'd have to migrate every signed proposal to a separate row. Accepted because plural is strictly more flexible.

## Q35 — OpenSign AGPL boundary [proposal P15]
Context: `ADDENDUM-PROPOSAL-MODULE.md` §0.3 #2. OpenSign is AGPL; T&B core is PolyForm Internal Use 1.0.0. AGPL infection would force the entire appliance source code under AGPL.
Assumed default: **OpenSign runs as a separate sidecar container reached over the network.** AGPL applies to the OpenSign binary only; the network boundary keeps T&B core's PolyForm license clean. One-line note to be added to `LICENSING.md` in P15. T&B does NOT statically link, NOT bundle, NOT import any OpenSign source.
Implication if wrong: If AGPL is read as infecting any system that talks to the OpenSign API, we'd have to either (a) write our own e-signature backend or (b) license T&B under AGPL. We accept the standard reading per FSF/SFLC guidance that network communication via stable API is not derivation.

## Q36 — CSV client import in P02 [proposal P02]
Context: `ADDENDUM-PROPOSAL-MODULE.md` §0.3 #3. A firm with 200 clients cannot hand-enter all of them at onboarding. Locked decision is "no CSV in v1."
Assumed default: **Defer CSV import.** Manual entry only in v1 per the locked architectural decision in §0.1. Document the 200-client friction as a v1.5 candidate. Mitigation: P02 may include a dev-only seed script that ingests a CSV for friendly-fire firms but the production UI ships without import.
Implication if wrong: If a friendly-fire firm cannot stomach manual entry, we open a one-night CSV-import sprint inside P02. Surface this to the operator before P02 ships — easy to reverse mid-build, expensive to reverse post-release.

## Q37 — QBO/MyBooks GL export [proposal P11, P22]
Context: `ADDENDUM-PROPOSAL-MODULE.md` §0.3 #4. Firms running both Vibe T&B and Vibe MyBooks may expect proposal revenue to flow into MyBooks GL. Locked decision is "no sync in v1."
Assumed default: **Defer GL export.** Confirm with operator before P11 (Stripe billing) and P22 (engagement lifecycle) whether MyBooks consumes T&B engagement data via shared-DB read or via API. Locked default is "no sync"; revisit pre-launch.
Implication if wrong: If a friendly-fire firm needs GL export day-one, we add a P22.5 mini-phase to export engagement_scope + invoice rows as a queryable view for MyBooks. Tolerable cost; defer is the safer default.

---

# CHANGE LOG

- 2026-05-19 — Initial 30 decisions locked at build kickoff.
- 2026-05-22 — Q31/Q32/Q33 added for file-manager rebuild (see `FILE_MANAGER_ADDENDUM.md`).
- 2026-05-25 — Q34/Q35/Q36/Q37 added for proposal module kickoff (see `ADDENDUM-PROPOSAL-MODULE.md` §0.3). PP0 reverted; replacing with addendum's P01–P30 phasing.
- 2026-05-24 — Q34–Q40 locked under Section L for Connect Integration absorption (see `CONNECT_INTEGRATION_ADDENDUM.md` §5).
