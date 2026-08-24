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

### Q5 — Second-factor enrollment scope
**Decided (revised by migration 0087, extended by the passkey login work that followed):** Every staff user enrols at least one second factor — passkey (WebAuthn), TOTP, email OTP, or SMS OTP — and may pick a preferred one (passkey is auto-preferred when present).

Originally TOTP was mandatory and the only option; magic-link + TOTP was the sole sign-in path. With 0087 the system added optional username/password sign-in (argon2id) as a sibling to magic link, and broadened the second-factor catalog. The follow-up work added passkeys as both a fourth second-factor option AND a primary (passwordless) sign-in path. Sign-in paths:

- **Magic link** → second-factor challenge → session.
- **Password** → second-factor challenge (passkey / TOTP / email / SMS) → session.
- **Passkey** (passwordless / discoverable credential) → session. The WebAuthn assertion itself counts as the step-up.

**Revised again by 0151 (owner request, 2026-06-12):** the requirement is now a firm-level toggle, `firm_settings.staff_second_factor_required` (default **true**, preserving the behavior above). Fully internal deployments can switch it off in Admin → Firm settings; password sign-in then issues a session directly (no factor challenge, no enrolled-factor prerequisite) and the Q4 step-up gates pass without a fresh TOTP/passkey. Magic-link and passkey sign-in are unchanged either way.

Email OTP is opt-in with no separate verification (the user's email is already trusted via the magic-link onboarding path); SMS OTP requires a code round-trip to verify the phone number; passkey enrollment uses the existing post-login `/webauthn/registration/*` flow. Recovery codes are generated only when TOTP is enrolled.

Implementation surface:
- `app_user.password_hash`, `app_user.sms_otp_phone_e164`, `app_user.email_otp_enrolled_at`, `app_user.sms_otp_enrolled_at`, `app_user.preferred_second_factor` (TOTP/EMAIL/SMS — passkey is intentionally not persisted as a preference because it's always auto-preferred when enrolled).
- `app_user_credential` table (migration 0077) holds the WebAuthn credentials.
- Routes in `apps/api/src/auth/staff-routes.ts`:
  - `/login/password` → `/2fa/start` → `/2fa/verify` (TOTP / EMAIL / SMS / PASSKEY)
  - `/login/passkey/options` + `/login/passkey/verify` (passwordless primary)
  - Settings: `/password`, `/email-otp/*`, `/sms-otp/*`, `/preferred-factor`, plus the existing `/webauthn/*` enrollment endpoints.

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

**Revision (migration 0180) — configurable backup + app keys.** The schedule, destination, retention, and an "include app keys" toggle are now firm-managed in **Admin → Operations → Backup** and stored in `vibetb.backup_config` (appliance-global singleton, mirroring `job_schedule`); each run is recorded in `vibetb.backup_run`. `backup.sh` becomes the config-driven **executor** (the `backup` sidecar polls every `BACKUP_POLL_SECONDS`, default 300, and runs when due or on a UI-requested manual run); the schedule maths live in `packages/core/src/backup` (the API/UI source of truth) and are mirrored as a simple day-difference check in the script's SQL. Frequency options: daily / every-2-days / weekly. The destination is chosen from a **dropdown of mounted drives** discovered from `/proc/mounts` (`GET /backup/destinations`): the api binds the host's `/mnt`+`/media` read-only to enumerate them and the executor binds them read-write to write, sharing one path namespace (`rshared` propagation for hot-plugged drives). The durable `/backups` volume is always offered; a free-text "Custom path…" fallback remains.

**Restore dependency:** a DB dump is non-restorable without the appliance keys (DB columns are encrypted under `KMS_KEY`; sessions signed with the JWT secrets). When "include app keys" is on, the executor also writes an **encrypted** bundle `vibe-tb-keys-*.tar.gz.gpg` (gpg symmetric AES-256) containing `KMS_KEY`, the JWT secrets, `POSTGRES_PASSWORD`, the HMAC seed, VAPID keys, the sealed master key (if used), and mounted `/secrets/*.env`. **Decision:** the bundle passphrase (`BACKUP_KEYS_PASSPHRASE`) is operator-held and never stored on the appliance — storing it alongside the secrets it protects would be circular. If the passphrase is unset, the DB backup still runs and the key bundle is skipped (recorded in the run log). Recommended retention: daily DB dumps kept 30 days; keep the last 14 key bundles; rotate an external drive weekly (GFS) for an off-site copy. WAL archiving / streaming replication remain out-of-scope for v1.

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

**Addendum 2026-06-10 — portal sign-in auto-route (firm decision):** The portal *sign-in* screen now returns an `access` boolean from `POST /api/portal/auth/login` so it can route a visitor with no active access straight to Request access (and only send a link/code when access exists). This intentionally reveals whether a contact is a portal user — a deliberate relaxation of Q29 for the sign-in surface, chosen for client usability. The rate limits above still apply, and the self-service *access-request* endpoint (`/api/portal/access-request`) remains fully enumeration-safe (identical generic response regardless of match).

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

## Q61 — Payroll timekeeping: overtime_exempt default [payroll 0226]
Context: migration 0226 adds `app_user.overtime_exempt`. Operator-locked requirements say exempt/non-exempt is a per-employee classification but did not specify the default for un-configured users.
Assumed default: **`true` (exempt)** — no phantom OT appears on payroll reports until an admin explicitly marks staff non-exempt. Conservative for a CPA firm that is mostly salaried.
Implication if wrong: a non-exempt employee left un-configured under-reports OT until the flag is set (visible on the UserDetail → Payroll tab).

## Q62 — Payroll timekeeping: semi-monthly split [payroll 0226]
Context: SEMI_MONTHLY pay periods are hard-coded 1–15 / 16–EOM (industry standard). Firms wanting e.g. 5th/20th splits would need an extra setting. Deferred.

## Q63 — Payroll timekeeping: period unlock gating [payroll 0226]
Context: `POST /payroll/periods/:id/unlock` is gated `payroll:period:manage` (partner) with a UI confirm, not step-up TOTP. If payroll locks should be as strict as billing locks, add the step-up gate later. Every unlock is audit-logged.

## Q64 — Payroll timekeeping vs 0062's "no Benefits tab" note [payroll 0226]
Context: migration 0062 documented that a Benefits tab / SSN were intentionally NOT built ("firms use external HR"). 0226 partially revisits this: payroll **time** (hours, OT classification, PTO/Sick/Comp accrual) is now in scope; wages, SSNs, and benefits remain external per the original decision.

## Q31 — File manager rebuild path [files phase 0]
Context: `FILE_MANAGER_ADDENDUM.md` v1 specifies a B2-backed sentinel-bound file manager that fundamentally conflicts with the v1 implementation shipped under migrations 0037 + 0038 (`client_folder` hierarchical, `client_file` flat, no virtual-drive coexistence).
Assumed default: Replace the existing implementation. Drop `client_folder`, `client_folder_template`, `client_file` and their code in Phase 0. Stub `apps/api/src/clients/files.ts` with `410 Gone` until Phase 8 reintroduces uploads against the new schema.
Implication if wrong: If existing customer data lived in `client_file`, it's lost. Accepted because no real production data is at risk at this point.
**RESOLVED 2026-06-04 (operator):** Close as implemented. The rebuilt `files` schema shipped and is live; default stands.

## Q32 — B2 storage stub for development [files phase 1]
Context: Addendum requires B2 as the canonical storage. B2 credentials are not yet available.
Assumed default: Ship a `MockStorageClient` that implements the same `StorageClient` interface but writes under `STORAGE_LOCAL_PATH` (default `/data/storage-mock`). Production deploys flip `STORAGE_PROVIDER=b2` + the `B2_*` vars; tests gate the real-B2 integration suite behind `B2_INTEGRATION=1`.
Implication if wrong: B2-specific quirks (consistency semantics, multipart upload, ETag format) won't be exercised until real wiring lands. Acceptable for v1 dev; documented in the master plan as deferred work.
**RESOLVED 2026-06-04 (operator):** Production storage = **Backblaze B2**. `STORAGE_PROVIDER=b2` + `B2_*` env in production; firm supplies credentials (customer-owned, per non-negotiable #5). Mock remains the dev default. Document the wiring + exercise the B2 path.

## Q33 — Pending-upload column placement [files phase 5/8]
Context: Phase 8 needs a `pending_upload` flag on `files` rows to mark in-flight presigned uploads.
Assumed default: Add the column in the Phase 5 migration (`0046_files_storage_files.sql`) rather than a separate Phase 8 migration, since the schema for `files` is already being defined in that migration and adding the flag early is cheaper than a follow-up ALTER.
Implication if wrong: If Phase 5 ships before Phase 8 we have a useless boolean column for ~one phase of life. Acceptable.
**RESOLVED 2026-06-04 (operator):** Close as implemented. `files.pending_upload` + its partial indexes are live; default stands.

## Q34 — Multi-signer scope for Proposals v1 [proposal P01]
Context: `ADDENDUM-PROPOSAL-MODULE.md` §0.3 #1. Partnership/S-corp/audit engagements often require ≥2 signers. The addendum locks "single-signer UI" for v1 but requires schema to remain plural so v1.5 only ships UI work.
Assumed default: **Schema plural, UI single-signer.** `signatures` table from day one (no inline `signature_*` columns on `proposals`). Acceptance portal hides the "add signer" UI but the API tolerates ≥1 row. The reverted PP0 violated this by putting signature columns inline on `proposal`; the new P01 migration uses the plural design.
Implication if wrong: If we needed multi-signer UI in v1, only the acceptance flow changes — no schema migration. If we needed inline columns instead, we'd have to migrate every signed proposal to a separate row. Accepted because plural is strictly more flexible.
**RESOLVED 2026-06-03 (operator):** Build multi-signer UI now. Schema is already plural, so this is acceptance-flow + UI work only.

## Q35 — OpenSign AGPL boundary [proposal P15]
Context: `ADDENDUM-PROPOSAL-MODULE.md` §0.3 #2. OpenSign is AGPL; T&B core is PolyForm Small Business License 1.0.0. AGPL infection would force the entire appliance source code under AGPL.
Assumed default: **OpenSign runs as a separate sidecar container reached over the network.** AGPL applies to the OpenSign binary only; the network boundary keeps T&B core's PolyForm Small Business License 1.0.0 clean. One-line note to be added to `LICENSING.md` in P15. T&B does NOT statically link, NOT bundle, NOT import any OpenSign source.
Implication if wrong: If AGPL is read as infecting any system that talks to the OpenSign API, we'd have to either (a) write our own e-signature backend or (b) license T&B under AGPL. We accept the standard reading per FSF/SFLC guidance that network communication via stable API is not derivation.
**RESOLVED 2026-06-04 (operator):** Build out OpenSign now as a first-class alternative to the native HMAC backend, via the AGPL-isolated sidecar (network boundary; no static link/bundle/import). Wire real envelope creation, the sidecar signing UI handoff, signed-cert storage in object storage, and the poll/refresh hook; keep native as the default provider and the sidecar opt-in per firm. Add the AGPL note to `LICENSING.md`.

## Q36 — CSV client import in P02 [proposal P02]
Context: `ADDENDUM-PROPOSAL-MODULE.md` §0.3 #3. A firm with 200 clients cannot hand-enter all of them at onboarding. Locked decision is "no CSV in v1."
Assumed default: **Defer CSV import.** Manual entry only in v1 per the locked architectural decision in §0.1. Document the 200-client friction as a v1.5 candidate. Mitigation: P02 may include a dev-only seed script that ingests a CSV for friendly-fire firms but the production UI ships without import.
Implication if wrong: If a friendly-fire firm cannot stomach manual entry, we open a one-night CSV-import sprint inside P02. Surface this to the operator before P02 ships — easy to reverse mid-build, expensive to reverse post-release.
**RESOLVED 2026-06-03 (operator):** Build the production CSV client-import UI now. Supersedes the "defer" default.

## Q37 — QBO/MyBooks GL export [proposal P11, P22]
Context: `ADDENDUM-PROPOSAL-MODULE.md` §0.3 #4. Firms running both Vibe T&B and Vibe MyBooks may expect proposal revenue to flow into MyBooks GL. Locked decision is "no sync in v1."
Assumed default: **Defer GL export.** Confirm with operator before P11 (Stripe billing) and P22 (engagement lifecycle) whether MyBooks consumes T&B engagement data via shared-DB read or via API. Locked default is "no sync"; revisit pre-launch.
Implication if wrong: If a friendly-fire firm needs GL export day-one, we add a P22.5 mini-phase to export engagement_scope + invoice rows as a queryable view for MyBooks. Tolerable cost; defer is the safer default.
**RESOLVED 2026-06-03 (operator):** Keep deferred. No GL sync in v1; revisit pre-launch.

## Q38 — Phase 1 — Retainer addendum already implemented; re-execution would conflict
**Date:** 2026-06-02 14:35
**Context:** Kicking off `VIBE_TB_RETAINER_ADDENDUM_BUILD_PLAN.md` per `KICKOFF_PROMPT.md`. Phase 1's first step is "Create migration `NNNN_retainer_addendum.ts` under `db/migrations/`". A pre-flight audit shows the addendum is already largely built in this repo from an earlier autonomous pass labelled R1–R6.

**Ambiguity:** The kickoff document treats the build as greenfield, but the repository already contains:
- `packages/db/migrations/0065_retainer_addendum.sql` plus follow-ups 0066, 0067, 0068
- `packages/db/src/schema/retainers.ts` defining `retainerTierConfigs`, `retainerTierEligibleServices`, `firmRetainerSettings`, `retainerOffers`, `retainers`, `retainerEligibleServices`, `retainerLedger` — every table the build plan's Phase 1 enumerates
- `apps/api/src/retainers/` with activation, consumption, exports, feature-flag, notifications, offers, routes, scheduler (covering Phases 3, 6, 7, 8, 12)
- Worker jobs `retainer-expiry-sweep`, `retainer-expiry-warning`, `retainer-offer-expiry-sweep`, `retainer-offer-reminder` (Phase 7)
- Admin UI: `RetainerTierSettings`, `RetainerDashboard`, `RetainerDetail` (Phases 2, 9)
- Staff UI: `StaffRetainerDashboard` (Phase 10)
- Portal: `/portal/retainer-offers/:id`, `/portal/retainers` (Phases 5, 11)
- `bootstrap-firm.ts` already seeds 12 retainer tier configs

Running Phase 1 verbatim would (a) create a redundant migration that conflicts with 0065, (b) attempt to declare tables that already exist, and (c) probably break the live appliance running locally.

The working tree is also dirty (~30 files modified from the current session's in-flight feature work on impersonation, tax catalog, payment-method catalog, engagement bill button, email/SMS icons, billable-only filter, year filter, client messages tab, etc.) — none committed yet per the user's standing "don't commit unless asked" instruction. Running `git checkout -b retainer-addendum/phase-1-schema` per kickoff §2 would put that work on the new branch.

**Options considered:**
- A: **Run a gap audit** — for each Phase 1–14 checklist item, mark whether it exists in code, partially exists, or is missing. Produce a `RETAINER_ADDENDUM_AUDIT.md` and treat any gaps as the actual scope. Skip duplicated work entirely.
- B: **Diff existing schema vs build plan and only ship the deltas.** Probably overlaps with A but more targeted.
- C: **Treat the kickoff literally**, ignore existing code, create migration `0091_retainer_addendum.sql`. Will fail at apply time because of unique-name collisions on tier_configs etc., and even if forced through would duplicate domain tables. Catastrophic.
- D: **Stash the in-flight session work, branch off main, and run the audit there.** Cleanest history but risks losing/forgetting the in-flight unfinished features.

**Recommendation:** **Option A.** Produce the audit first, surface the deltas, then the operator decides whether (1) the kickoff was meant to validate completeness (audit IS the deliverable), (2) a specific phase needs re-work, or (3) the kickoff was issued in error from another branch / fresh checkout. Either way, no schema work happens until the operator confirms.

**Blocker:** yes
**Workaround if non-blocking:** n/a — schema-level conflict, cannot proceed without operator direction.

**RESOLVED 2026-06-03 (operator):** Do NOT re-run the kickoff verbatim. Run Option A — a gap audit mapping each build-plan phase item to existing code, producing `RETAINER_ADDENDUM_AUDIT.md`; build only genuine gaps it surfaces. No redundant migration.

## Q39 — B2 bucket version-lifecycle policy [storage / Q32 follow-up]
Context: B2 retains every file version by default; the idempotent "latest wins" `put` accumulates hidden versions (storage cost + clutter). The appliance keeps its own append-only audit log + per-file SHA-256, so prior B2 object versions are not the integrity source of truth.
**RESOLVED 2026-06-04 (operator):** **Keep-last-version only.** Document a B2 lifecycle rule that hides/deletes prior versions immediately in the storage runbook. No version-recovery cushion (acceptable given audit log + SHA-256).

## Q40 — Multipart upload [storage / Q32 follow-up]
Context: `put` + presigned PUT are single-part (B2 single-PUT S3 cap 5 GB; lower in practice through proxies). No multipart path exists.
**RESOLVED 2026-06-04 (operator):** **Defer.** CPA documents (PDFs, returns, statements) sit well under single-part limits. Logged as a known gap; build chunked multipart only if a real large-file need appears.

## Q41 — OpenSign sidecar deployment posture [proposal / Q35 follow-up]
Context: OpenSign is built but profile-gated and off by default (needs `OPENSIGN_URL` + the `opensign`/`opensign-mongo` sidecar bundle + the per-firm setting flipped). Native HMAC e-sign is the active default.
**RESOLVED 2026-06-04 (operator):** Keep it **off in default deploys**, but write an ops **deploy runbook** (`ops/docs/opensign-runbook.md`) so standing it up is turnkey when a firm wants it: bring up the sidecar + Mongo, set the shared/webhook secrets, point the firm setting at it, register the completion webhook, verify.

## Q42 — B2 integration suite in CI [storage / Q32 follow-up]
Context: the real-B2 round-trip suite (`packages/storage/src/__tests__/b2.integration.test.ts`) is gated behind `B2_INTEGRATION=1` + the five `B2_*` vars; today it only runs locally on demand.
**RESOLVED 2026-06-04 (operator):** **Wire CI secrets.** Add a manual-dispatch (`workflow_dispatch`) CI job that injects throwaway-bucket B2 credentials from GitHub Actions secrets and runs the integration suite on demand. Creds are a dedicated throwaway bucket + restricted key, never production.

## Q43–Q49 — Tax-Season Rollforward addendum [rollforward kickoff]
Context: the rollforward wizard (engagements → drop-off dates → appointments) was built on `feat/tax-season-rollforward` to the plan's recommended defaults, then these decisions were confirmed/adjusted by the operator. Five match as-built; **Q44 and Q46 changed** and require a follow-up implementation pass.

- **Q43 — Engagement creation.** **RESOLVED 2026-06-19 (operator): direct insert** mirroring the `/engagements/:id/rollover` clone (no proposal; scope copied not frozen). *As built.*
- **Q44 — What carries forward.** **RESOLVED: carry staff + type/scope + fee structure + fee amount (seeded with the engagement's autoRollover % bump, editable per row) AND the retainer/billing terms.** *Implemented:* billing-arrangement fields (feeStructure, fee, nteCap, feePassthrough, autoRollover, scopeDefinition, budget) carry on the clone. For the **retainer**: retainers are offer-at-billing + payment-gated (a draft engagement has no prep invoice to base an offer on; the hour-bank residual forfeits on close per decision #22), so a funded retainer is **not** fabricated and `retainerId` is **not** repointed. Instead, when the source carried a live (non-void) retainer, the commit leaves an **engagement note** on the rolled engagement flagging the prior tier so staff re-offer it when billing — the retainer then recurs through the normal offer flow (same returnType → same tier eligibility). Built + tested.
- **Q45 — Drop-off & appointment anchoring.** **RESOLVED: same deadline** — both anchor to the engagement's `returnType` filing deadline. *As built.*
- **Q46 — Cascade.** **RESOLVED: allow appointment-only rollforward via an explicit opt-in** (in addition to the default hard-block). *Delta from as-built:* needs an opt-in so appointments of skipped/absent engagements can roll as standalone candidates and commit with `appointment.engagement_id = null` (the column is already nullable; no migration required).
- **Q47 — Deadline on weekend/holiday.** **RESOLVED: anchor to the statutory date** (4/15 etc.); observed/next-business-day is a future option. *As built.*
- **Q48 — Inactive/lost clients.** **RESOLVED: exclude by default with an "include inactive" toggle.** *As built* in the API (`includeInactive`); the toggle still needs to be surfaced in the wizard's Step 1 UI.
- **Q49 — 3/15 vs 4/15 split source.** **RESOLVED: infer from the engagement's `returnType`** (1120S/1065 → 3/15; 1040/1120/1041 → 4/15; 990 → 5/15); ISO-week fallback when null. *As built.*

## Q50–Q60 — AI Pricing Suggestion addendum [pricing kickoff]
Context: an on-demand pricing suggestion on the engagement Activity card. The number is produced by a **deterministic engine** over structured inputs (auditable, reproducible); the LLM writes the rationale only. Decisions confirmed by the operator before build.

- **Q50 — Margin.** Target margin **0.40, a TRUE GROSS MARGIN applied by DIVISION** (`cost ÷ (1 − 0.40)`), never `× 1.40`. Asserted in code + tests.
- **Q51 — Burdened cost rates.** Derive per-tier from the cohort's captured `cost_rate_snapshot_cents` (hours-weighted); **firm per-tier settings fallback** when thin/zero.
- **Q52 — Expected hours.** **Trimmed mean** (configurable → median) across the cohort; this client's own actuals shown as a comparison line only.
- **Q53 — Complexity tiers.** Computed from the tax-return **form/section count** (SIMPLE/MODERATE/COMPLEX) + manual override; non-tax → type-only cohort.
- **Q54 — Minimum cohort.** **5**; below it the engine falls back to prior-fee × economic uplift, low confidence, wider band.
- **Q55 — Default economic source.** **MANUAL % (0%)**, no network; live CPI/ECI is opt-in + egress-gated.
- **Q56 — Egress / BLS.** Outbound BLS fetch allowed only under the firm's direct/shield egress mode; worker/admin refresh caches `economic_index`, degrading to last-cached then MANUAL. Manual path needs no network.
- **Q57 — Range width.** Scales with confidence (HIGH ±8% / MEDIUM ±15% / LOW ±25%).
- **Q58 — Override history.** **Audit-only for v1** — `pricing_decision` stores suggested vs final + inputs snapshot; no engine feedback loop yet.
- **Q59 — "Accept".** **Records the decision only** (no engagement fee written; the next-year engagement may not exist).
- **Q60 — LLM number authority.** The engine always owns the number; the `pricing_allow_llm_adjust` toggle defaults **OFF** and is reserved (the rationale prompt forbids changing figures).

Deferred follow-ups (noted, not blocking): a **periodic worker** to auto-refresh the economic index (admin/manual refresh ships now); Tier-1 rate-base is intentionally **burdened cost** while Tier-2 is **billable** — do not unify.

## Q61 — Messaging "interaction" visibility rule [engagement team threads]
Context: operator asked (2026-08-24) for per-engagement team conversations, and for engagements to stay off the Messages page (Clients and Team tabs) "unless the user has an interaction with the engagement/message."

- **Q61 — What counts as an interaction?** Options: (a) strictly per-user — the viewer personally posted/opened the thread; (b) a conversation exists — the thread has ≥1 message from anyone. **Default picked: (b).** Strict per-user hiding would make a client's first message on an unopened thread invisible to the assigned staff — a lost client message. Under (b) the auto-provisioned empty thread never clutters the list, and the moment anyone (client or staff) posts, every member sees it. Team threads additionally don't exist at all until a staff member starts the discussion from the engagement page. Revisit if the operator wants the stricter reading (would need an "unread from client" escape hatch).

---

# CHANGE LOG

- 2026-05-19 — Initial 30 decisions locked at build kickoff.
- 2026-05-22 — Q31/Q32/Q33 added for file-manager rebuild (see `FILE_MANAGER_ADDENDUM.md`).
- 2026-05-25 — Q34/Q35/Q36/Q37 added for proposal module kickoff (see `ADDENDUM-PROPOSAL-MODULE.md` §0.3). PP0 reverted; replacing with addendum's P01–P30 phasing.
- 2026-05-24 — Q34–Q40 locked under Section L for Connect Integration absorption (see `CONNECT_INTEGRATION_ADDENDUM.md` §5).
- 2026-06-02 — Q38 added: retainer addendum already implemented (migrations 0065–0068); kickoff Phase 1 blocked pending operator direction.
- 2026-06-03 — Operator Q&A resolved open items: Q38 → run gap audit (Option A); Q36 → build CSV client-import UI now; Q37 → keep GL export deferred; Q34 (proposals) → build multi-signer UI now. Q35 (OpenSign AGPL) left open — proposals ship native HMAC e-sign, so the sidecar boundary is currently moot.
- 2026-06-04 — Operator Q&A resolved the remaining open items: Q31 → close as implemented (files schema rebuilt); Q33 → close as implemented (pending_upload live); Q32 → production storage = Backblaze B2 (firm-supplied creds; mock stays dev default); Q35 → build out OpenSign now as an AGPL-isolated sidecar alternative to native e-sign. All OPEN QUESTIONS Q31–Q38 now resolved.
- 2026-06-04 — Q39–Q42 added + resolved (follow-ups surfaced by the Q32/Q35 builds): Q39 B2 lifecycle → keep-last-version; Q40 multipart → defer; Q41 OpenSign → keep off by default + write deploy runbook; Q42 B2 integration suite → wire manual-dispatch CI secrets.
- 2026-06-19 — Q43–Q49 added + resolved for the Tax-Season Rollforward addendum. Built to defaults; operator changed Q44 (carry retainer/billing terms) and Q46 (appointment-only opt-in). Q46 + Q48 (wizard inactive toggle) built. Q44 built: billing fields carry on the clone; retainer carried as an intent **note** (retainers are offer-at-billing/payment-gated, so no funded retainer is fabricated).
- 2026-06-19 — Q50–Q60 added + resolved for the AI Pricing Suggestion addendum (migration 0178). Deterministic engine (÷-margin, burdened-cost base, once-only economic factor, confidence-scaled range, thin-cohort fallback); LLM writes the rationale only with a templated fallback; decisions audit-logged (no fee write). Periodic economic-index worker deferred (manual/admin refresh ships).
