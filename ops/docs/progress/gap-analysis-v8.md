# Gap Analysis v8 — BUILD_PLAN vs. Codebase

> **⚠ Superseded by `summary.md` (2026-06-03).** ~186 commits have landed since this audit, and
> the three "Health of working tree" blockers below (WT-1/2/3) are all resolved and committed.
> This file remains accurate as the line-by-line BUILD_PLAN punch list; for current headline
> numbers and module scope read `summary.md`.

**Generated:** 2026-05-21 (re-audit; supersedes `gap-analysis-v7.md`)
**Method:** Walk of every numbered item in `BUILD_PLAN.md` against HEAD (commit `a3e3ebb`) plus the uncommitted working tree (theme system + QR TOTP + nodemailer + lockfile regen). v7's full row-by-row table remains the line-by-line baseline; this file records the delta and the remaining punch list.

**Headline numbers (HEAD + working tree):**
- v7 baseline: **433 ✅ / 65 ⚠ / 47 ❌** of 545
- v8 estimate: **~470 ✅ / 47 ⚠ / 28 ❌** of 545 (**86%** complete)
- **Δ from v7:** +37 ✅, −18 ⚠, −19 ❌

Sessions BBB → GGGG (29 sessions) + QA passes 1–5 + Node 24 bump shipped between v7 and v8.

---

## Health of working tree (BLOCKERS)

Three regressions sit in **uncommitted changes** on top of HEAD. None of them lower the build-plan completion count, but together they make the app *feel* incomplete in the way the user described. They must clear before anything else ships:

| # | Severity | Where | Symptom |
|---|---|---|---|
| WT-1 | 🔴 | `pnpm-lock.yaml` (regenerated during Node-24 bump + nodemailer/qrcode add) | Two `drizzle-orm@0.30.10` resolutions in lockfile (`_postgres_…` vs `_@types+react+postgres+react_…`). `apps/worker` typecheck dies with 5+ "Type not assignable to `SQLWrapper`" errors in `wip-age-alert.ts`. Worker won't compile. |
| WT-2 | 🟠 | `apps/web/src/pages/TotpEnroll.tsx:83` | Lint error: unescaped `'` in "Can't scan? Show setup URI". One char fix. |
| WT-3 | 🟡 | Theme system (`packages/ui/src/theme.css` + `ThemeToggle.tsx` + `tokens.ts`) | Switches color tokens to CSS vars; light theme defined; toggle landed in both apps. Functional but uncommitted. Several components still pass raw color hexes in inline styles (`TotpEnroll.tsx` background `#11151b`, `Login.tsx`, others) — light mode will show dark patches on those surfaces. |

Suggested order to clear blockers:
1. WT-1: `pnpm dedupe && pnpm install` to collapse the duplicate, or pin `drizzle-orm` to a single resolution via root `pnpm.overrides`.
2. WT-2: one-char edit (`Can&apos;t scan?`).
3. WT-3: audit ~12 components with hardcoded color hexes, replace with `tokens.color.*`. Then commit the theme system as one feature.

---

## What landed since v7 (29 sessions + 5 QA passes)

| Session | Phase / item | What |
|---|---|---|
| BBB | 14 #19, 25 #11, 25 #14 | Per-service health probes, Prometheus `/metrics`, semver doc, CPACharge webhook stub, portal pay-to-unlock action card |
| CCC | 13 #9 | Invoice render mode picker (`?mode=summary | by-line | full-detail`) + recurring-plan proration-preview endpoint |
| DDD | 9 #28, 23 #25 | AI prebill-narrative endpoint; PWA manifests + theme-color for both apps |
| EEE | 9 #5, 11 #20–#21 | Timer idle detection + heartbeat; billing-batch `/recompute` + `/budget-compare` |
| FFF | 11 #18, 17 #22 | NTE cap check on batch creation; saved-report-email worker (Mon 7am) |
| GGG | 11 #19, 13 (reopen) | Subscription overage split endpoint; invoice reopen → new DRAFT |
| HHH | 11 #9, 21 #1 | Emailable pre-bill endpoint; email-in worker stub (IMAP scaffold) |
| III | 12 #30 | Cascading-adjustment test cases (1×0.9×0.95 = 85.5%) |
| JJJ | 23 #28 | AI firm opt-in toggle (`VIBE_AI_DISABLED`) + `/ai/status` |
| KKK | 23 #17 | AI nl-to-filter endpoint |
| LLL | 19 #12 | Legal-hold flag on client; archive refuses 409 |
| MMM | 14 #14 | Pay-to-unlock signal (stripe webhook → `client.unlocked` event) |
| NNN | 23 #7 | Per-feature AI provider override (`VIBE_AI_FEATURE_<NAME>`) |
| OOO | 23 #18 | AI citations array on plain-english-query |
| PPP | 16 #22 | Alternate-contact OTP flow (`portal_alt_contact` table) |
| QQQ | 10 #31 | Auto-resume paused autopay on payment-method update |
| RRR | 23 #25 | AI pre-bill narrative panel embedded in billing batch detail |
| SSS | 10 #15, 10 #18 | Hour-bank auto-replenish + rollover-cap enforcement worker |
| TTT | 4 #7 | Per-office firm setting overrides (`office_settings` table) |
| UUU | 18 #5 | Multi-step approval routing (`current_step`/`total_steps`/`steps_json`) |
| VVV | 18 #20 | Approval-metrics report (count/avg-time/rates over window) |
| WWW | 21 #5 | Webhook delivery log export (CSV/JSON, ≤5000 rows) |
| XXX | 17 #26 | Time-entry anomaly highlighting (>2.5 σ from personal mean) |
| YYY | 16 #27 | Portal-enabled firm toggle enforced (503 portal_disabled) |
| ZZZ | 16 #22 | Portal alt-contacts UI (add/list/verify/remove) |
| AAAA | 18 #5 (UI) | Approvals UI surfaces multi-step progress (N/N pill) |
| BBBB | 10 #15 | Hour-bank `replenish-settings` PATCH endpoint |
| CCCC | 20 #10 | Per-office settings admin UI (effective + override per office) |
| DDDD | 23 #28 (UI) | AI status card on admin Usage page |
| EEEE | 10 #22 (UI) | Proration preview dialog on recurring plans admin |
| FFFF | 20 #12 | Notification template customization (migration 0018; variable picker per Q28) |
| GGGG | 20 #12 (UI) | Notification templates admin UI (`/admin/notification-templates`) |
| QA1+2 | Cleanup | Lint warning fix, prettier pass, dead-code removal, approval-export status cast widened, alt-contact verify/delete emit audit, stripe.ts cleanup |
| QA3 | UX | `OverrideRow` hoisted out of `OfficeSettingsPanel` render body — fixed input focus loss on every keystroke |
| QA4 | Cleanup | Top-level imports hoisted in portal/profile + admin/routes; OTP timing constants extracted; alt-contact dispatch failure surfaced honestly |
| QA5 | Security | Approval `/decide` endpoint firm-scoped (was cross-firm reachable via ID guess); audit emissions added on office_settings PUT, notification_template PUT/DELETE, hour-bank replenish-settings PATCH |
| Node 24 | Infra | `.nvmrc`/`package.json` engines/Dockerfile/CI all moved to Node 24.4.0; typecheck + 28-test green at commit time (the WT-1 lockfile regression happened in a later regen) |

---

## Remaining gaps (HEAD + working tree)

Marked ❌ (missing) or ⚠ (partial) only. Items that v7 marked open but a session above closed are removed.

### Phase 2 — Schema
- **#31 ⚠** No partition declared for `audit_log` or `time_entry`. Acceptable through v1 per QUESTIONS Q3; revisit at 100k+ entries.

### Phase 3 — Auth
- **#8 ❌** No WebAuthn enrollment. *Out of scope v1.*
- **#10 ⚠** Magic-link receipt implies verification; no explicit email-verification ceremony.

### Phase 4 — Firm/office/users
- **#8 ⚠** `standardHoursPerWeek` column present; no admin UI.
- **#14 ❌** No office-level partner-in-charge default.
- **#15 ❌** Multi-entity-firm flag — *out of scope v1.*

### Phase 5 — Taxonomy
- **#7 ⚠** Archive endpoint exists; no reference-check before archive.

### Phase 6 — Client management
- **#4 ⚠** Status enum; no state-machine on transitions beyond archive.
- **#5 ⚠** `customFields` JSONB column; no field-definition admin UI.
- **#6 ⚠** `tags` array column; UI doesn't edit tags.
- **#8 ❌** No client merge / deduplication tool.

### Phase 7 — Rate management
- **#5 ❌** No firm-default-rate-by-role configuration.
- **#10 ❌** No CSV rate import.
- **#13 ❌** No premium/discount multiplier per engagement.
- **#16 ⚠** History endpoint live; no history modal in UI.
- **#17 ⚠** `resolveRate` returns trace[]; no debug-panel UI.

### Phase 8 — Engagement & fee structure
- **#8 ⚠** Hour-bank schema complete; no auto-create alongside engagement.
- **#24 ⚠** List filters supported; no dedicated views per partner/SL/status.
- **#28 ❌** Proposal-acceptance stub — *out of scope v1.*

### Phase 9 — Time entry
- **#7 ⚠** `/totals/by-day` endpoint; no day-grid UI.
- **#8 ⚠** `/totals/by-week` endpoint; no week-grid UI.
- **#9 ⚠** `/totals/by-month` endpoint; no month-grid UI.
- **#16 ⚠** `lateEntryLockoutDays` setting present; not enforced on POST.
- **#22 ❌** No approver field on entry.
- **#25 ❌** Voice entry — *out of scope v1.*
- **#26 ❌** Email-to-time-entry stub only — *full impl out of scope v1.*
- **#27 ❌** Workflow integration — *out of scope v1.*
- **#29 ❌** No offline draft / PWA queue — *out of scope v1.* (manifest landed via DDD)
- **#30 ⚠** TimeEntry.tsx filters engagements; no permission-scoped narrowing.

### Phase 10 — Recurring billing
- **#5 ⚠** Worker job body — fixed plan-amount only; no per-period WIP rollup.
- **#6 ⚠** `milestone-date-trigger` flips PENDING→TRIGGERED only; no event-trigger evaluator.
- **#8 ❌** No event-trigger handler.
- **#10 ❌** No mixed-mode invoice composer (retainer + overage on one invoice).
- **#11 ❌** No overage roll-up into invoice line items.
- **#12 ⚠** `hour_bank` schema; opening-balance only via top-up endpoint.
- **#13 ⚠** `/hour-banks/:id/debit` exists; no automatic debit on time-entry write.
- **#21 ⚠** `prorate()` exists in core; not wired into create flow.
- **#22 ❌** No plan-change proration flow on PATCH amount (preview dialog exists; commit path not wired).
- **#23 ⚠** `applyAnnualPrepayDiscount()` exists; not wired.
- **#27 ⚠** CPACharge stub conforms to interface; needs creds for real charge.
- **#28 ⚠** `nextRetryDate()` exists; webhook marks FAILED; no scheduled retry job.
- **#32 ❌** No partner notification on auto-pause.
- **#34 ⚠** QueueEvents `failed` logs; no alerting on job failures.
- **#35 ⚠** Unique index on `(engagement_id, period_start)` is the idempotency boundary; no explicit key.

### Phase 11 — Pre-bill & WIP
- **#7 ⚠** `bucketize` on batch GET; no nightly materialized view for WIP aging.
- **#8 ⚠** Invoice PDF works; no separate pre-bill PDF.
- **#10 ❌** No partner-assignment field on pre-bill.
- **#14 ⚠** `comment` per entry; no thread UI.
- **#21 ❌** No automatic recompute on entry change (manual `/recompute` endpoint only).
- **#23 ❌** No reopen→new-version flow (overwrite-only).

### Phase 12 — Adjustments & allocation
- **#19 ⚠** `/invoices/:id/credit-memo` exists; not yet linked to `adjustment_id`.
- **#22 ⚠** NTE auto-suggest endpoint live; no adjustment hint in UI.
- **#23 ⚠** `fixed-fee-gap` endpoint live; no adjustment hint UI.
- **#26 ⚠** List filters batchId + status; no free-text search.

### Phase 13 — Invoicing
- **#6 ⚠** Single template; no firm-style picker.
- **#8 ⚠** Consolidation preference on client; composer still 1 batch = 1 invoice.
- **#17 ⚠** Per-firm max+1 with unique index; no Postgres SEQUENCE.
- **#22 ⚠** Search ilike on number + client name; no full-text.
- **#23 ❌** E-sign integration — *out of scope v1.*
- **#24 ⚠** Pay-to-unlock flag + lock endpoint exists; signal (MMM) live; portal-side gate (Phase 16 #20) still partial.

### Phase 14 — Payment processing
- **#2 ⚠** CPACharge provider stub conforms to interface; *external creds needed for real charges.*
- **#13 ⚠** `pay_to_unlock_attachments` flag + endpoint; full client-side enforcement still partial.
- **#15 ⚠** Invoice send dispatches; no separate payment-confirmation email flow.
- **#19 ⚠** CPACharge webhook stub (BBB); *external creds needed for real handler.*
- **#20 ⚠** Webhook marks `payment.status = FAILED`; no dunning re-route.

### Phase 15 — AR aging & dunning
- **#11 ⚠** `PARTNER_NOTIFY` step kind defined; no partner-targeted dispatch.
- **#12 ⚠** `AUTO_PAUSE` step kind logged; no engagement-pause write yet.

### Phase 16 — Client portal
- **#20 ⚠** `/pay-to-unlock` endpoint returns lock states; no client-side download gate yet.
- **#27 ⚠ → ✅** YYY landed firm-toggle middleware; remaining nit is COMMERCIAL_LICENSE_TOKEN boot-time route gating (still ⚠).

### Phase 17 — Reporting & analytics cube
- **#17 ⚠** MRR endpoint live; no dedicated subscription-profitability dashboard.
- **#20 ⚠** UI dimension switch; no full summary→detail→entries drill-through.
- **#23 ⚠** CSV exports cover most reports; no Excel.
- **#24 ❌** No URL filter persistence for shareable views.
- **#25 ❌** No sparklines on metric rows.
- **#27 ❌** No comparison overlays.
- **#28 ⚠** Period selector present; no full date-range picker.
- **#29 ❌** No report permission stratification.

### Phase 18 — Approval workflows
- **#8 ❌** No email notification on approver assignment. *External creds soft block; provider abstraction exists.*
- **#9 ❌** Slack/Teams — *out of scope v1.*
- **#13 ⚠** `slaHours` column; no SLA tracker worker.

### Phase 19 — Audit trail
*All 15 items now ✅ (LLL closed #12).*

### Phase 20 — Admin UI
- **#4 ❌** No fee-structure toggles.
- **#5 ⚠** `defaultAllocationMethod` on firm; no admin field in UI.
- **#6 ⚠** `fiscalYearStartMonth` on firm; no admin field in UI.
- **#7 ⚠** `standardHoursPerWeek` on app_user; no per-role admin.
- **#8 ⚠** `/reports/billable-targets` enforces a default; no per-role configuration UI.
- **#14 ⚠** `portalEnabled` editable; `portalSubdomain` not exposed in FirmSettings UI.

### Phase 21 — Integrations
- **#1 ⚠** Email-in IMAP scaffold (HHH); *needs MAIL_INBOUND_* env vars + parser.*
- **#2 ❌** No routing logic for inbound email.
- **#3 ❌** AI assist for inbound email — *external creds for inbound provider.*
- **#12 ⚠** `requireApiToken` updates `lastUsedAt`; no per-token rate limiter.
- **#15 ⚠** `/clients/bulk-import` + `/taxonomy/bulk-import` slices; no firm-wide bulk import.

### Phase 22 — MCP server
- **#1 ⚠** `/mcp` HTTP shim; not full WebSocket SDK transport.

### Phase 23 — AI features
- **#4 ⚠** `openai_compatible` in enum; no impl class.
- **#6 ⚠** `aiProvider` enum; no per-firm admin endpoint to switch.
- **#13 ❌** No AI scope-creep feature (`/reports/scope-creep` is rule-based).
- **#15 ❌** No AI capacity forecasting (`/capacity-forecast` is rolling average).
- **#22 ❌** No Whisper voice transcription — *external creds for ASR model.*
- **#23 ❌** No shared AI panel components in UI library.
- **#24 ❌** No time-entry AI panel.
- **#27 ⚠** Pricing-renewal endpoint exists; no admin panel surface.

### Phase 24 — Vibe Connect
- **#2 ⚠** `/connect/enroll` stub mints a placeholder; no full config UI.
- **#3 ❌** No invoice-sent routing through Connect — *external Connect ship.*
- **#4 ❌** No payment-received routing — *external Connect ship.*
- **#5 ❌** No payment-failed routing — *external Connect ship.*

### Phase 25 — Distribution
- **#4 ⚠** `release.yml` uses tag (vX.Y.Z); no formal semver doc (BBB added one, light).
- **#10 ⚠** Migration-on-start needs verification (no integration test asserts it).

### Phase 26 — Polish & launch readiness
- **#1 ❌** No Lighthouse audit results captured.
- **#2 ⚠** `size:budget` script in CI; no bundle-size dashboard.
- **#3 ❌** No slow-query analysis.
- **#4 ❌** No accessibility audit.
- **#5 ⚠** Some keyboard nav via accessible primitives + Quick-Find Ctrl+K; not exhaustive.
- **#6 ❌** No screen reader testing.
- **#7 ⚠** Seed populates one firm + Vance scenario; not rich multi-month history.
- **#9 ❌** No user documentation site.
- **#10 ❌** No client FAQ.
- **#11 ❌** No video walkthroughs.
- **#12 ❌** No migration guide from competitors.
- **#13 ❌** No pricing/licensing page.
- **#14 ❌** No beta cohort playbook.

---

## Phases now ≥95% done (HEAD)

- Phase 1 (15/15 ✅) — 100%
- Phase 2 (30/31 ✅) — partition only
- Phase 3 (16/18 ✅) — WebAuthn (OOS) + email-verify ceremony
- Phase 5 (11/12 ✅) — ref-check on archive
- Phase 8 (26/28 ✅) — hour-bank auto-create + #28 OOS
- Phase 12 (29/32 ✅) — credit-memo link + hint UIs + free-text search
- Phase 15 (13/15 ✅) — partner-notify + auto-pause action
- Phase 18 (19/20 ✅) — assignment email
- **Phase 19 (15/15 ✅)** — complete (LLL closed legal-hold)
- Phase 21 (12/16 ✅) — email-in still scaffolding only
- Phase 22 (11/12 ✅) — only WebSocket transport remains

## Phases still <70% done

- **Phase 23 — AI features** — ~17/28 ✅ ≈ 60% (anomaly-summary, NL-to-filter, citations, per-feature override, opt-in all landed; embedded panels in time-entry still absent; scope-creep & capacity AI still rule-based)
- **Phase 24 — Vibe Connect** — 4/8 ✅ + 1/8 ⚠ ≈ 50% (notification routing depends on Connect ship)
- **Phase 26 — Polish/launch** — 1/14 ✅ + 4/14 ⚠ ≈ 7% (Onboarding wizard landed; docs/audits still deferred)

---

## Prioritized punch list — what to do next

Three tiers. Tier 1 must clear before any other work resumes; Tier 2 closes the visible UX gaps the user is likely noticing; Tier 3 is launch polish.

### Tier 1 — Working-tree regressions (do first)

| # | Effort | Item | Why now |
|---|---|---|---|
| T1.1 | 15 min | WT-1: dedupe drizzle-orm — add `pnpm.overrides` for drizzle-orm in root `package.json` OR run `pnpm dedupe` and verify worker typecheck | Worker won't compile; blocks `pnpm typecheck` (and CI) |
| T1.2 | 1 min | WT-2: escape the apostrophe in `TotpEnroll.tsx:83` | Blocks `pnpm lint` (and CI) |
| T1.3 | 1 hr | WT-3: sweep ~12 inline-color hex literals across pages, swap to `tokens.color.*`; verify both light + dark renders | Light mode renders dark patches today |
| T1.4 | 30 min | Land the theme system + QR + nodemailer + ports + seed sanitization in one commit (or three coherent commits) | Working tree currently uncommitted; on a fresh checkout the app is missing this work |

### Tier 2 — High-impact user-visible gaps (CPA-firm shipping risk)

| # | Effort | Item | Phase / item | Why |
|---|---|---|---|---|
| T2.1 | ~6 hr | Mixed-mode invoice composer + overage roll-up | 10 #10–#11 | Differentiator: retainer + overage on one invoice. Subscription overage split endpoint exists (GGG); needs composer to consume it |
| T2.2 | ~4 hr | Pre-bill PDF + emailable + partner-assignment | 11 #8–#10 | Partners review pre-bills; PDF + emailable + assignment closes the daily-use loop |
| T2.3 | ~3 hr | Time-entry day/week/month grid UIs | 9 #7–#9 | Endpoints exist; daily-use surface promised in BUILD_PLAN.md acceptance ("enter full week in under 10 minutes via the grid") |
| T2.4 | ~3 hr | Client merge tool + custom-field admin UI + tag editor | 6 #5, #6, #8 | Client management is foundational; merge in particular is a migration-from-competitor must-have |
| T2.5 | ~2 hr | Hour-bank auto-create on engagement + automatic debit on time-entry write | 8 #8, 10 #12–#13 | Hour-bank feature is half-wired today: balance/top-up/forfeit work but the natural debit on each time entry doesn't fire |
| T2.6 | ~3 hr | Portal pay-to-unlock client-side gate + invoice attachment lock enforcement | 13 #24, 14 #13, 16 #20 | Signal lands (MMM), endpoint returns lock state, but the portal Invoices.tsx page doesn't actually gate the download |
| T2.7 | ~2 hr | Premium/discount multiplier per engagement + rate history modal + debug panel | 7 #13, #16, #17 | Partners ask "why is this rate $X" — debug panel directly addresses |
| T2.8 | ~2 hr | Approval assignment email + SLA tracker worker | 18 #8, #13 | Approvals queue exists; no one knows they have one pending until they check |
| T2.9 | ~2 hr | Plan-change proration commit path + auto-debit + retry job | 10 #21–#22, #28 | Preview dialog exists (EEEE); commit path doesn't write |

### Tier 3 — Polish / admin completeness / launch readiness

| # | Effort | Item | Phase |
|---|---|---|---|
| T3.1 | 4–6 hr | Reporting UX: drill-through, sparklines, date-range picker, URL filter persistence, Excel export, comparison overlays | 17 #20, #23–#25, #27–#29 |
| T3.2 | 3 hr | Admin polish: fee-structure toggles, allocation-method field, fiscal-year field, hours-per-role, billable-target editor, portal-subdomain field | 20 #4–#8, #14 |
| T3.3 | 4 hr | AI: shared AI panel components, time-entry AI panel, pricing-renewal panel, openai_compatible impl, per-firm provider switch endpoint | 23 #4, #6, #23, #24, #27 |
| T3.4 | 4 hr | Demo seed enrichment (multi-month history, multi-entity portal scenarios) + Lighthouse + a11y audit | 26 #1, #4, #6, #7 |
| T3.5 | 2 hr | Phase 21 polish: per-token rate limiter, firm-wide bulk import | 21 #12, #15 |
| T3.6 | 2 hr | Phase 4/6 polish: per-office partner-in-charge default, client status transitions, ref-check on taxonomy archive, standardHours admin UI | 4 #8, #14; 5 #7; 6 #4 |
| T3.7 | 2 hr | CPACharge real impl (needs creds) + webhook handler | 14 #2, #19; 10 #27 |
| T3.8 | OOS deferral | Document explicitly: WebAuthn (3 #8), voice entry (9 #25), workflow tasks (9 #27), offline drafts (9 #29), e-sign (13 #23), Slack/Teams (18 #9), Vibe Connect routing (24 #3–#5), multi-entity firm (4 #15), proposal acceptance (8 #28) | various |

### Tier-3 launch readiness only (deferrable to v1 ship week)

- 26 #2 bundle dashboard, #3 slow-query analysis, #5 full kbd nav, #9 docs site, #10 client FAQ, #11 video walkthroughs, #12 migration guides, #13 pricing page, #14 beta playbook

---

## Recommendation

1. **Clear Tier 1 (≈2 hours)** in a single PR — that's the source of "things feel missing on the app." The lockfile/typecheck/lint regressions plus the half-themed surfaces are the visible friction.
2. **Pick the next 2–3 Tier-2 items** the user prioritizes. T2.1, T2.2, T2.3 are the highest-leverage daily-use gaps for CPA firms.
3. **Plan Tier 3 in 2-week cuts** alongside the beta cohort.
4. **Update QUESTIONS.md** with the explicit OOS deferrals (T3.8) so the build plan and reality stay in sync.

If the user agrees, I'll start with Tier 1 in the next message.
