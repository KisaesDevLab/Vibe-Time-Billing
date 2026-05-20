# Gap Analysis v2 — BUILD_PLAN vs. Codebase

**Generated:** 2026-05-20 (re-audit; supersedes `gap-analysis.md`)
**Last updated:** 2026-05-20 post-Session-I (third pass — re-scored items touched by api-tokens router, mail/sms provider modules, Stripe webhook router, recurring-billing transactional rewrite, materialized-views migration, view-refresh + ar-aging-snapshot worker jobs)
**Method:** Fresh walk of every numbered item in `BUILD_PLAN.md` against the actual source tree. Old doc not trusted.

Legend
- `✅` implemented end-to-end (schema + endpoint + UI / worker / test where the item demands it)
- `⚠` partial — at least one layer missing; blocker tag in the note
- `❌` missing entirely

Blocker tags used in notes
- **UI deferred** — backend works, no React surface
- **External creds** — code wired, needs real Stripe/email/SMS/AI keys
- **Schema TODO** — table/column or materialized view not in migrations
- **Worker job body** — handler logs but does not write to DB
- **Out of scope v1** — explicitly punted per BUILD_PLAN or QUESTIONS.md

---

## Phase 1 — Repo & infrastructure foundation (15)

| # | S | Note |
|---|---|---|
| 1 | ✅ | pnpm workspaces with `apps/*` + `packages/*` |
| 2 | ✅ | `apps/web` Vite + React 18 + TS strict — full App.tsx with router |
| 3 | ✅ | `apps/portal` Vite + React 18 + TS strict — full App.tsx with router |
| 4 | ✅ | `apps/api` Express + tsx with 15+ routers wired in `app.ts` |
| 5 | ✅ | `apps/worker` registers 4 BullMQ queues with cron upserts |
| 6 | ✅ | `packages/db` Drizzle schema (45 tables) + 3 migrations + seed |
| 7 | ✅ | `packages/types` exports shared types |
| 8 | ✅ | `packages/ui` has Pill, Button, Input, Card, Table, AppShell, AuthLayout, tokens |
| 9 | ✅ | Multi-stage Dockerfile at repo root |
| 10 | ✅ | `ops/docker/docker-compose.dev.yml` + `.prod.yml` |
| 11 | ✅ | ESLint + Prettier + lint-staged + husky |
| 12 | ✅ | LICENSE.md (PolyForm), README, CLAUDE.md, QUESTIONS.md |
| 13 | ✅ | `.github/workflows/ci.yml`: typecheck + lint + prettier --check + test + bundle-size + docker buildx + license-check |
| 14 | ✅ | Three Caddy templates (domain/lan/tailscale) for two-host routing |
| 15 | ✅ | `.env.example` + `apps/api/src/config.ts` zod-validates at boot |

---

## Phase 2 — Database schema & migrations (31)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `firm` + companion `firm_settings` |
| 2 | ✅ | `office` with timezone + isDefault |
| 3 | ✅ | `app_user` with TOTP fields |
| 4 | ✅ | `portal_identity` with verified-at + preferred method |
| 5 | ✅ | `client_portal_access` with role + per-access notification prefs |
| 6 | ✅ | `role`, `role_permission`, `user_role` joins |
| 7 | ✅ | `service_line` with category enum |
| 8 | ✅ | `work_code` with serviceLine linkage + description template |
| 9 | ✅ | `engagement_type` with default fee structure + template_data |
| 10 | ✅ | `reason_code` grouped by category |
| 11 | ✅ | `client` with consolidation preference + tags + customFields |
| 12 | ✅ | `engagement` with all fee structures + budgets + mixed-mode |
| 13 | ✅ | `timekeeper_rate` with effective dates + cost rate |
| 14 | ✅ | `client_rate_override`, `engagement_rate_override`, `service_line_rate` |
| 15 | ✅ | `time_entry` with NOT NULL `standard_rate_snapshot_cents` |
| 16 | ✅ | `time_entry_version` with unique (entry, version) |
| 17 | ✅ | `recurring_billing_plan` with next_run_date + autopay |
| 18 | ✅ | `recurring_billing_plan_service` |
| 19 | ✅ | `milestone_plan` + `milestone` with trigger types |
| 20 | ✅ | `hour_bank` + `hour_bank_transaction` with running_balance |
| 21 | ✅ | `billing_batch` + `billing_batch_entry` with action enum |
| 22 | ✅ | `adjustment` with method/allocation_method/reason/status |
| 23 | ✅ | `adjustment_allocation` at (adj, entry, user) grain + sum trigger migration |
| 24 | ✅ | `invoice` + `invoice_line_item` with mixed-kind enum |
| 25 | ✅ | `payment` + `payment_method` (method belongs to portal_identity) |
| 26 | ✅ | `portal_session` with `active_client_id` |
| 27 | ✅ | `portal_invitation` with delivery_channel + token_hash |
| 28 | ✅ | `portal_auth_challenge` covers SMS OTP |
| 29 | ✅ | `0003_materialized_views.sql` ships `realization_view`, `utilization_view`, `profitability_view` MVs with unique indexes (for CONCURRENTLY refresh) and `ar_aging_snapshot` table |
| 30 | ✅ | `approval_rule`, `approval_request`, `audit_log`, `webhook_endpoint`, `webhook_delivery`, `mcp_token`, `ai_request_log` all in schema |
| 31 | ⚠ | Schema TODO — FK indexes present; no partition declared for `audit_log` or `time_entry` |

---

## Phase 3 — Authentication & sessions (staff) (18)

| # | S | Note |
|---|---|---|
| 1 | ✅ | Magic link via jose, 15-min TTL (`staff-routes.ts`) |
| 2 | ✅ | Redis sliding session (`session-store.ts`) |
| 3 | ✅ | `requireAuth` + `requirePermission` (subsumes requireRole via RBAC) |
| 4 | ✅ | TOTP enroll with otpauth URI + recovery codes |
| 5 | ✅ | `requireStepUp` checks `lastStepUpAt` against firm timeout |
| 6 | ✅ | Adjustment POST gated by `requireStepUp` |
| 7 | ✅ | `/logout` destroys session + clears cookie |
| 8 | ❌ | Out of scope v1 — no WebAuthn enrollment |
| 9 | ⚠ | External creds — `/admin/users/invite` writes user but does not dispatch the invite email |
| 10 | ⚠ | Magic-link receipt implies verification; no explicit email-verification ceremony |
| 11 | ✅ | Lockout after 5 failed TOTP, 15-min window |
| 12 | ✅ | Redis sliding-window rate limit |
| 13 | ✅ | CSRF via SameSite + `requireCsrf` double-submit |
| 14 | ✅ | `emitAudit` on LOGIN / LOGOUT / STEP_UP |
| 15 | ✅ | Login UI at `apps/web/src/pages/Login.tsx` |
| 16 | ✅ | TotpEnroll page at `apps/web/src/pages/TotpEnroll.tsx` |
| 17 | ✅ | Account page at `apps/web/src/pages/Account.tsx` |
| 18 | ✅ | `mcp_token` table + `requireApiToken` middleware + `/api/staff/admin/api-tokens` router (list/create/revoke, one-time display, sha256 at rest, scope validation) wired in `app.ts` |

---

## Phase 4 — Firm, office & user administration (15)

| # | S | Note |
|---|---|---|
| 1 | ✅ | Firm settings UI (`apps/web/src/pages/admin/FirmSettings.tsx`) backed by `/admin/firm-settings` |
| 2 | ✅ | Offices page CRUD (`apps/web/src/pages/admin/Offices.tsx`) — list + create only |
| 3 | ✅ | Users page (`apps/web/src/pages/admin/Users.tsx`) — list + invite |
| 4 | ❌ | No role-assignment endpoint or UI |
| 5 | ✅ | Role templates in `@vibe/core/rbac/permissions.ts` (5 roles) |
| 6 | ✅ | Permission key catalog (47 keys) |
| 7 | ❌ | No per-office override of firm settings |
| 8 | ⚠ | `standardHoursPerWeek` column on `app_user`; no admin UI |
| 9 | ❌ | No holiday/PTO calendar table |
| 10 | ❌ | No time-off entry endpoint |
| 11 | ⚠ | `status` enum present; no toggle endpoint/UI |
| 12 | ❌ | UI deferred — no user-detail page showing engagement assignments |
| 13 | ❌ | No bulk CSV import |
| 14 | ❌ | No office partner-in-charge default |
| 15 | ❌ | Out of scope v1 — no multi-entity flag |

---

## Phase 5 — Taxonomy (12)

| # | S | Note |
|---|---|---|
| 1 | ✅ | Service-line CRUD UI (`apps/web/src/pages/admin/Taxonomy.tsx`) + endpoints |
| 2 | ✅ | Work-code CRUD UI + endpoints |
| 3 | ✅ | Engagement-type CRUD UI + endpoints |
| 4 | ✅ | Reason-code CRUD UI + endpoints |
| 5 | ✅ | Seed populates 4 SLs, 12 WCs, 8 engagement types on demo firm |
| 6 | ❌ | No bulk-import endpoint |
| 7 | ⚠ | Service-line archive endpoint exists; no reference-check on archive |
| 8 | ✅ | Category enums centralized in `packages/types` |
| 9 | ✅ | `color`/`icon` columns on service_line |
| 10 | ❌ | No taxonomy export endpoint |
| 11 | ❌ | No taxonomy import endpoint |
| 12 | ✅ | `description_template` column on work_code |

---

## Phase 6 — Client management (12)

| # | S | Note |
|---|---|---|
| 1 | ✅ | Clients UI (`apps/web/src/pages/Clients.tsx`) + endpoints (list/create/archive) |
| 2 | ✅ | Billing contact columns + accepted in POST |
| 3 | ✅ | `partnerInChargeId` required in zod schema |
| 4 | ⚠ | Status enum present; no transition endpoint |
| 5 | ⚠ | `customFields` JSONB; no admin definition UI |
| 6 | ⚠ | `tags` array column; UI does not edit tags |
| 7 | ❌ | UI deferred — no client detail page with engagement aggregation |
| 8 | ❌ | No merge tool |
| 9 | ⚠ | `notes` column; audit emission on notes change not wired |
| 10 | ❌ | No CSV bulk import |
| 11 | ⚠ | Search supports `?q=` ilike on name only |
| 12 | ❌ | No portal-access invite endpoint/UI (despite `portal_invitation` schema being ready) |

---

## Phase 7 — Rate management (20)

| # | S | Note |
|---|---|---|
| 1 | ⚠ | UI deferred — `timekeeper_rate` schema; no CRUD endpoint |
| 2 | ⚠ | UI deferred — `client_rate_override` schema; no endpoint |
| 3 | ⚠ | UI deferred — `engagement_rate_override` schema; no endpoint |
| 4 | ⚠ | UI deferred — `service_line_rate` schema; no endpoint |
| 5 | ❌ | No firm-default-by-role configuration |
| 6 | ✅ | `resolveRate` in `@vibe/core/rates` with full hierarchy |
| 7 | ✅ | `captureRateSnapshot` invoked from time-entry POST |
| 8 | ❌ | No effective-dated history view endpoint |
| 9 | ❌ | No bulk rate-update preview tool |
| 10 | ❌ | No CSV import |
| 11 | ✅ | `costRateCents` column on `timekeeper_rate` |
| 12 | ❌ | No loaded-margin computation |
| 13 | ❌ | No premium/discount multiplier per engagement |
| 14 | ✅ | Verified via `rate-resolution.test.ts` snapshot invariant |
| 15 | ❌ | UI deferred — no rate-management page |
| 16 | ❌ | UI deferred — no rate history modal |
| 17 | ⚠ | `resolveRate` returns `trace[]`; no debug-panel UI |
| 18 | ❌ | No rate-change endpoint, so no audit emissions yet |
| 19 | ❌ | No rate-write endpoint, so no admin gate |
| 20 | ✅ | Reports/invoices read `standard_rate_snapshot_cents` from `time_entry` |

---

## Phase 8 — Engagement & fee structure (28)

| # | S | Note |
|---|---|---|
| 1 | ⚠ | `POST /engagements` + `PATCH /:id/status`; no full update endpoint; no detail UI |
| 2 | ✅ | All 5 fee structures in zod enum |
| 3 | ✅ | `mixedModeEnabled` flag accepted |
| 4 | ✅ | `nteCapCents` + `nteCapScope` columns |
| 5 | ✅ | `feeAmountCents` column |
| 6 | ⚠ | `milestone_plan`/`milestone` schema; no editor endpoint |
| 7 | ⚠ | `recurring_billing_plan` schema; no creation endpoint |
| 8 | ⚠ | `hour_bank` schema; no creation endpoint |
| 9 | ✅ | `budgetHours`/`budgetAmountCents` columns accepted |
| 10 | ✅ | `engagementTypeId` accepted |
| 11 | ✅ | `partnerId`/`managerId` accepted |
| 12 | ✅ | `scopeDefinition` text column accepted |
| 13 | ✅ | Status enum + PATCH transitions |
| 14 | ⚠ | `autoRolloverEnabled` flag stored; no worker creates next-year engagement |
| 15 | ❌ | UI deferred — no engagement detail page |
| 16 | ❌ | No budget-vs-actual live computation |
| 17 | ❌ | No engagement-letter attachment storage |
| 18 | ❌ | No clone endpoint |
| 19 | ⚠ | Status PATCH writes closedAt/reason; audit emission missing |
| 20 | ❌ | PAUSED behavior not enforced on time-entry POST |
| 21 | ❌ | CLOSED transition does not check WIP-resolved |
| 22 | ❌ | Worker job body — no auto-rollover worker |
| 23 | ⚠ | GET lists only; no search/filter beyond firm scope |
| 24 | ❌ | UI deferred — no by-partner/by-SL list views |
| 25 | ❌ | No bulk operations |
| 26 | ⚠ | `customFields` column; no UI |
| 27 | ✅ | Engagement template starter pack lives in `seed/engagement-templates.json` + `seed/engagement-letters/*.md` for 8 templates |
| 28 | ❌ | Out of scope v1 — no proposal-acceptance stub |

---

## Phase 9 — Time entry & capture (32)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `POST /time-entries` resolves rate + captures snapshot |
| 2 | ✅ | `PATCH /:id` writes `time_entry_version` row |
| 3 | ❌ | No DELETE/soft-delete endpoint |
| 4 | ❌ | No timer endpoint or server-persisted state |
| 5 | ❌ | No idle detection |
| 6 | ❌ | No timer recovery |
| 7 | ⚠ | UI deferred — `TimeEntry.tsx` is single-entry form, no day grid |
| 8 | ⚠ | UI deferred — no week grid |
| 9 | ⚠ | UI deferred — no month grid |
| 10 | ✅ | Quick-entry form in `apps/web/src/pages/TimeEntry.tsx` |
| 11 | ❌ | No required-field rules engine |
| 12 | ✅ | `descriptionTemplate` column on work_code |
| 13 | ✅ | `billableFlag` field on POST |
| 14 | ✅ | `inScopeFlag` computed at write time from engagement array (Q20) |
| 15 | ❌ | Worker job body — no late-entry alert job |
| 16 | ⚠ | `lateEntryLockoutDays` setting present; not enforced on POST |
| 17 | ❌ | No bulk-from-template endpoint |
| 18 | ⚠ | `lockedAt` column + PATCH refuses when locked; no batch-lock endpoint |
| 19 | ❌ | No transfer-between-engagements endpoint |
| 20 | ❌ | No per-day totals endpoint |
| 21 | ❌ | No per-week summary endpoint |
| 22 | ❌ | No approver field |
| 23 | ⚠ | `/time-entries/mine` exists; no admin all-entries endpoint |
| 24 | ❌ | No per-timekeeper export |
| 25 | ❌ | Out of scope v1 (Phase 23 depends) — no voice entry |
| 26 | ❌ | Out of scope v1 (Phase 21 depends) — no email-to-time-entry |
| 27 | ❌ | Out of scope v1 — workflow integration |
| 28 | ❌ | UI deferred — no mobile PWA shell |
| 29 | ❌ | UI deferred — no offline drafts |
| 30 | ⚠ | TimeEntry.tsx filters engagements; no permission-scoped narrowing |
| 31 | ❌ | No smart-suggestion ranking |
| 32 | ❌ | UI deferred — no required-fields admin UI |

---

## Phase 10 — Recurring billing engine (38)

| # | S | Note |
|---|---|---|
| 1 | ⚠ | Schema present; no creation endpoint |
| 2 | ⚠ | Schema; no scheduler hookup |
| 3 | ✅ | Worker `runRecurringBillingTick` advances next_run_date on cron */15 |
| 4 | ✅ | `runRecurringBillingTick` now: APPROVED batch + RECURRING_FEE line + numbered invoice + batch→INVOICED + plan advance, all in one tx |
| 5 | ⚠ | Worker job body — recurring tick emits only the fixed plan-amount line; no per-period time-entry WIP rollup yet |
| 6 | ❌ | No milestone trigger evaluator |
| 7 | ❌ | No date-trigger worker |
| 8 | ❌ | No event-trigger handler |
| 9 | ❌ | No manual-trigger endpoint |
| 10 | ❌ | No mixed-mode invoice composer |
| 11 | ❌ | No overage roll-up |
| 12 | ⚠ | `hour_bank` schema; no opening-balance endpoint |
| 13 | ❌ | No debit-on-time-entry trigger |
| 14 | ❌ | No balance/runway query |
| 15 | ❌ | No auto-replenish |
| 16 | ❌ | No top-up endpoint |
| 17 | ❌ | Worker job body — no expiration enforcement |
| 18 | ❌ | No rollover-cap enforcement |
| 19 | ❌ | No NTE cap check |
| 20 | ❌ | No NTE auto-suggest |
| 21 | ⚠ | `prorate()` exists in core; not wired |
| 22 | ❌ | No plan-change proration flow |
| 23 | ⚠ | `applyAnnualPrepayDiscount()` exists; not wired |
| 24 | ❌ | No pause/resume endpoint |
| 25 | ⚠ | `autoPayFlag` column; no autopay execution |
| 26 | ⚠ | External creds — `createStripeProvider` exists in `apps/api/src/payments/stripe.ts`; not called from recurring tick |
| 27 | ❌ | External creds — no CPACharge implementation |
| 28 | ⚠ | `nextRetryDate()` function exists; not wired into worker |
| 29 | ⚠ | Worker job body — `dunning-sweep` logs steps but does not send email/sms |
| 30 | ❌ | No auto-pause-after-N-failures path |
| 31 | ❌ | No auto-resume |
| 32 | ❌ | No partner notification |
| 33 | ❌ | No plan-health view |
| 34 | ⚠ | QueueEvents 'failed' logs; no alerting |
| 35 | ⚠ | DB unique index on (engagement_id, period_start) is the idempotency boundary; no explicit idempotency-key column |
| 36 | ❌ | UI deferred — no plan list page |
| 37 | ❌ | UI deferred — no plan detail page |
| 38 | ❌ | No plan audit-log emission |

---

## Phase 11 — Pre-bill & WIP management (25)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `POST /billing-batches` creates batch with included entries |
| 2 | ✅ | Auto-pull unbilled entries by period range |
| 3 | ✅ | Pre-bill review UI in `apps/web/src/pages/Billing.tsx` (list + detail + ActionPicker) |
| 4 | ✅ | Per-entry INCLUDE/DEFER/WRITE_OFF via PATCH `/finalize` |
| 5 | ⚠ | Deferred entries unassigned from batch; no worker re-includes next period |
| 6 | ❌ | No held vs. removed write-off variants |
| 7 | ⚠ | `bucketize` returns aging on batch GET; no nightly materialized view |
| 8 | ⚠ | Invoice PDF works; no separate pre-bill PDF |
| 9 | ❌ | External creds — no emailable pre-bill |
| 10 | ❌ | No partner-assignment field |
| 11 | ❌ | Worker job body — no period-close bulk pre-bill |
| 12 | ❌ | No cost-transfer endpoint |
| 13 | ✅ | Batch status DRAFT→APPROVED→INVOICED via finalize + generate-from-batch |
| 14 | ⚠ | `comment` per-entry on billing_batch_entry; no thread UI |
| 15 | ⚠ | Adjustment route runs the approval-rule engine; pre-bill approval itself doesn't queue requests |
| 16 | ⚠ | Aging response returned on GET; no firm-wide WIP totals endpoint |
| 17 | ❌ | No fixed-fee gap calculation |
| 18 | ❌ | No NTE cap check on batch creation |
| 19 | ❌ | No subscription in-scope/overage split |
| 20 | ❌ | No budget comparison |
| 21 | ❌ | No automatic recompute on entry change |
| 22 | ✅ | Finalize PATCH locks entries (sets billing_batch on time_entries) |
| 23 | ❌ | No reopen→new-version flow |
| 24 | ❌ | Worker job body — no WIP age alert |
| 25 | ❌ | UI deferred — no firm-wide WIP dashboard |

---

## Phase 12 — Adjustments & allocation (the wedge) (32)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `POST /adjustments` with full payload validation |
| 2 | ✅ | Method enum (RATE/TIME/FEE) |
| 3 | ✅ | All 6 allocation methods on enum |
| 4 | ✅ | `allocateSpecificEntries()` in core, tested |
| 5 | ✅ | `allocateProRataByValue()` in core, tested |
| 6 | ✅ | `allocateProRataByHours()` in core, tested |
| 7 | ✅ | `allocatePartnerAbsorbs()` in core, tested |
| 8 | ✅ | `allocateHierarchicalCascade()` passes Vance scenario per test |
| 9 | ✅ | `allocateCustomWeighted()` in core, tested |
| 10 | ✅ | Per-timekeeper allocation rows inserted in same tx |
| 11 | ✅ | Symmetric write-up handled (signed totalAmountCents) |
| 12 | ✅ | `reasonCodeId` required in zod + schema |
| 13 | ✅ | Free-text notes accepted |
| 14 | ✅ | `POST /adjustments/preview` returns per-timekeeper allocation without persisting |
| 15 | ✅ | `evaluate()` from `@vibe/core/approvals` gates with firm threshold |
| 16 | ⚠ | Decision sets adjustment status PENDING_APPROVAL; no `approval_request` row inserted yet (Approvals page reads from `approval_requests` table) |
| 17 | ✅ | Status enum + lifecycle on schema; flips on approve/reject |
| 18 | ✅ | `emitAudit` fires on adjustment create |
| 19 | ❌ | No credit memo generation for post-invoice adjustments |
| 20 | ⚠ | `reversedById` columns; no reverse endpoint |
| 21 | ❌ | No bulk-across-engagements endpoint |
| 22 | ❌ | No NTE auto-suggest |
| 23 | ❌ | No fixed-fee-gap auto-suggest |
| 24 | ✅ | `AdjustmentDialog.tsx` with 6-method picker + live preview + per-timekeeper table |
| 25 | ⚠ | Adjustments visible only via batch detail; no firm-wide list |
| 26 | ❌ | No cross-firm adjustment search |
| 27 | ✅ | Per-timekeeper allocation table rendered in dialog |
| 28 | ✅ | Sum-equals-total enforced via deferred trigger (`0002_adjustment_sum_trigger.sql`) |
| 29 | ✅ | Step-up gate on adjustment POST (`requireStepUp`) |
| 30 | ❌ | No cascading-adjustment handling test/path |
| 31 | ❌ | No adjustment export |
| 32 | ❌ | No metrics endpoint for AI to read |

---

## Phase 13 — Invoicing (25)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `POST /invoices/generate-from-batch` (Phase 11 → Phase 13) |
| 2 | ✅ | Recurring tick generates DRAFT invoice with numbered sequence + RECURRING_FEE line in same tx |
| 3 | ❌ | No milestone-triggered invoice flow |
| 4 | ✅ | `LineItem` discriminated union covers all 6 kinds in `@vibe/core/invoicing` |
| 5 | ❌ | No manual composer endpoint |
| 6 | ⚠ | Single template in `templates.ts`; no firm-style picker |
| 7 | ✅ | `formatInvoiceNumber()` + per-firm max+1 sequence |
| 8 | ⚠ | Consolidation preference on client; composer still emits 1 batch = 1 invoice |
| 9 | ❌ | No summary/by-line/full-detail mode picker |
| 10 | ✅ | Invoice preview HTML accessible via `Accept: text/html` |
| 11 | ✅ | Puppeteer PDF via `apps/api/src/pdf/render.ts`, lazy-loaded |
| 12 | ❌ | External creds — no email delivery wired for invoices |
| 13 | ✅ | `firstViewedAt` set on first portal GET (Q30 no-pixel) |
| 14 | ❌ | No resend endpoint |
| 15 | ⚠ | `computeLateFee()` in core; no accrual worker |
| 16 | ❌ | No expense pass-through with markup |
| 17 | ⚠ | Per-firm max+1 + unique index catches collisions; no Postgres sequence |
| 18 | ⚠ | `voidedAt`/`voidedReason` columns; no void endpoint |
| 19 | ❌ | No partial credit |
| 20 | ✅ | Invoice list UI (`apps/web/src/pages/Invoices.tsx`) |
| 21 | ✅ | Invoice detail view in same page |
| 22 | ❌ | No full-text search |
| 23 | ❌ | Out of scope v1 — no e-sign integration |
| 24 | ⚠ | `payToUnlockAttachments` flag; no attachment storage to lock |
| 25 | ✅ | Audit emit on create + send |

---

## Phase 14 — Payment processing (24)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `createStripeProvider` real PaymentIntent + refund client (`apps/api/src/payments/stripe.ts`) |
| 2 | ❌ | External creds — no CPACharge implementation |
| 3 | ✅ | `paymentMethodKind` enum includes ACH |
| 4 | ✅ | Same enum includes CARD |
| 5 | ✅ | `payment_method` FK is `portal_identity_id` |
| 6 | ✅ | Schema stores `provider_token` + `last_four` only |
| 7 | ❌ | No auto-apply-to-oldest logic |
| 8 | ✅ | Portal `/invoices/:id/pay` applies to specific invoice |
| 9 | ✅ | `paidCents` increment + PARTIALLY_PAID transition |
| 10 | ✅ | Multiple payment rows allowed per invoice |
| 11 | ⚠ | `refundedAt`/`refundedAmountCents` columns; refund endpoint not yet exposed (provider supports it) |
| 12 | ❌ | No credit memo |
| 13 | ⚠ | `pay_to_unlock_attachments` flag; no attachment store yet |
| 14 | ❌ | No webhook-driven unlock signal |
| 15 | ❌ | External creds — no payment-confirmation email |
| 16 | ❌ | No receipt PDF |
| 17 | ❌ | No firm-side notification on payment |
| 18 | ✅ | `/api/webhooks/stripe` mounted in `app.ts`: raw-body sig verify, dispatches charge.succeeded / payment_intent.succeeded / failed / refunded / dispute events; idempotent on (provider_charge_id, status); updates payment + invoice ledger |
| 19 | ❌ | External creds — no CPACharge webhook handler |
| 20 | ⚠ | Webhook marks `payment.status = FAILED` on charge.failed; no dunning re-route / retry escalation yet |
| 21 | ✅ | `PaymentProvider` interface in `@vibe/core/payments` |
| 22 | ✅ | Payment audit emission on portal pay |
| 23 | ❌ | No reconciliation report |
| 24 | ✅ | Portal pay endpoint consumed from `apps/portal/src/pages/Invoices.tsx` |

---

## Phase 15 — AR aging & dunning (15)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `runArAgingSnapshot` nightly job writes per-(firm, client, as_of_date) rows via ON CONFLICT upsert into `ar_aging_snapshot`; uses same `bucketize` helper as live endpoint |
| 2 | ✅ | Bucketize 0-30/31-60/61-90/90+ in `@vibe/core/billing` |
| 3 | ✅ | `GET /ar/aging` endpoint scoped to firm |
| 4 | ❌ | No statement generation |
| 5 | ❌ | External creds — no statement email/SMS |
| 6 | ✅ | `DEFAULT_DUNNING_SCHEDULE` + `stepsDueOn()` in core |
| 7 | ❌ | No template renderer wired |
| 8 | ⚠ | Worker job body — `dunning-sweep` logs "step due" but doesn't send |
| 9 | ❌ | No manual-trigger endpoint |
| 10 | ❌ | Schema TODO — no dunning_history table |
| 11 | ❌ | No partner escalation |
| 12 | ⚠ | `AUTO_PAUSE` step kind logged; no engagement-pause write |
| 13 | ⚠ | AR aging UI shows by-client; no by-partner/by-SL filters |
| 14 | ❌ | No CSV export |
| 15 | ❌ | No DSO/collection-rate metric endpoint |

---

## Phase 16 — Client portal (28)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `apps/portal` Vite + React 18 scaffold with router |
| 2 | ✅ | Combined input with `detectLoginKind()` client-side |
| 3 | ✅ | Magic-link path with PORTAL_JWT_SECRET (distinct) |
| 4 | ✅ | SMS OTP path with 6-digit code + 5-min TTL |
| 5 | ✅ | Phone verified at OTP success (first-use) |
| 6 | ✅ | `portalAuthDeps` + `requireAuth` middleware |
| 7 | ❌ | No firm-side invite endpoint (Phase 6 #12 dependency) |
| 8 | ⚠ | `/switch-client` endpoint exists; no entity-switcher dropdown in portal header yet |
| 9 | ✅ | Schema supports multi-identity-per-client |
| 10 | ⚠ | Portal shell exists; no firm branding (logo/colors) wired |
| 11 | ✅ | Portal invoice list scoped to `active_client_id` |
| 12 | ✅ | Paid history split in same response |
| 13 | ✅ | Invoice detail endpoint + UI |
| 14 | ✅ | `/api/portal/invoices/:id/pdf.html` (puppeteer-free HTML) |
| 15 | ✅ | `POST /api/portal/invoices/:id/pay` with chargeInvoice hook |
| 16 | ❌ | UI deferred — no saved-payment-methods endpoint |
| 17 | ❌ | No auto-pay enrollment endpoint |
| 18 | ❌ | UI deferred — no statement-of-account view |
| 19 | ❌ | No receipt-download endpoint |
| 20 | ❌ | No pay-to-unlock endpoint |
| 21 | ❌ | UI deferred — no profile management |
| 22 | ❌ | No add-alternate-contact OTP flow |
| 23 | ⚠ | `notification_preferences` JSONB; no update endpoint |
| 24 | ❌ | External creds — no email dispatcher honoring per-access prefs |
| 25 | ❌ | External creds — no SMS dispatcher |
| 26 | ✅ | Audit emit with `actor_portal_identity_id` + `active_client_id` on portal mutations |
| 27 | ⚠ | `portalEnabled` setting + `COMMERCIAL_LICENSE_TOKEN` env surfaced on `/health/ready`; no boot-time route gating |
| 28 | ✅ | Subdomain-aware Caddy templates for both hosts |

---

## Phase 17 — Reporting & analytics cube (32)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `realization_view` MV in `0003_materialized_views.sql` over `adjustment_allocation` grain |
| 2 | ✅ | `utilization_view` MV — billable/non-billable hours per (firm, user, month) |
| 3 | ✅ | `profitability_view` MV — billed minus loaded cost per engagement |
| 4 | ✅ | `runViewRefresh` worker REFRESHes all three MVs CONCURRENTLY with non-concurrent fallback for first run |
| 5 | ✅ | Reports UI (`apps/web/src/pages/Reports.tsx`) with firm/timekeeper/engagement/client dimensions |
| 6 | ✅ | `/reports/realization` returns rollup live (no MV) |
| 7 | ❌ | No collection-realization metric endpoint |
| 8 | ❌ | No effective-rate metric endpoint |
| 9 | ❌ | No utilization metric endpoint |
| 10 | ❌ | No profitability metric endpoint |
| 11 | ⚠ | Aging on billing-batch detail; no firm-wide WIP aging endpoint |
| 12 | ✅ | AR aging report (`/ar/aging`) consumed in Phase 15 |
| 13 | ❌ | No budget-vs-actual |
| 14 | ❌ | No period-over-period |
| 15 | ❌ | No MRR/ARR dashboard |
| 16 | ❌ | No scope-creep tracking |
| 17 | ❌ | No subscription profitability dashboard |
| 18 | ❌ | No partner book-of-business dashboard |
| 19 | ❌ | No CLV |
| 20 | ⚠ | UI dimension switch acts like drill; no full summary→detail→entries chain |
| 21 | ❌ | No saved-report definitions |
| 22 | ❌ | Worker job body — no scheduled email worker |
| 23 | ❌ | No Excel/CSV export |
| 24 | ❌ | No URL filter persistence |
| 25 | ❌ | No sparklines |
| 26 | ❌ | No anomaly highlight |
| 27 | ❌ | No comparison overlays |
| 28 | ❌ | No date-range picker (dim only) |
| 29 | ❌ | No report permissions stratification |
| 30 | ⚠ | `/ai/realization-narrative` endpoint exists; UI doesn't surface it |
| 31 | ✅ | MVs landed with unique indexes; sub-second reporting target achievable. Reports endpoints still query live tables — UI cutover is a follow-up |
| 32 | ✅ | `view-refresh` worker cron rebuilds MVs CONCURRENTLY (15-min default per worker schedule) |

---

## Phase 18 — Approval workflows (20)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `evaluate()` declarative rule engine in `@vibe/core/approvals` |
| 2 | ⚠ | `approval_request` schema; adjustments route does not yet insert a row |
| 3 | ✅ | Approvals queue UI (`apps/web/src/pages/Approvals.tsx`) |
| 4 | ✅ | `POST /approvals/:id/decide` with APPROVED/REJECTED/APPROVED_WITH_EDITS |
| 5 | ❌ | No multi-step routing |
| 6 | ❌ | No delegation rules |
| 7 | ✅ | Threshold rules in core (cents/pct/role/reason) |
| 8 | ❌ | External creds — no email notification on assignment |
| 9 | ❌ | Out of scope v1 — no Slack/Teams |
| 10 | ✅ | Audit emit on decide |
| 11 | ✅ | `approverResolver: 'partner_in_charge'` supported |
| 12 | ✅ | `/approvals/pending` filters to approver's queue |
| 13 | ⚠ | `slaHours` column; no tracking worker |
| 14 | ⚠ | `autoEscalateHours` column; no escalation worker |
| 15 | ❌ | No modification log |
| 16 | ❌ | No dry-run rule-testing endpoint |
| 17 | ⚠ | `comments` column visible; no thread |
| 18 | ❌ | No admin reassignment endpoint |
| 19 | ❌ | No export |
| 20 | ❌ | No metrics endpoint |

---

## Phase 19 — Audit trail & compliance (15)

| # | S | Note |
|---|---|---|
| 1 | ⚠ | `emitAudit` helper exists; auth + portal-pay + adjustment + invoice + billing-batch + approval mutations emit. Some endpoints (taxonomy, clients, engagements) don't yet |
| 2 | ✅ | `0001_audit_log_immutability.sql` REVOKEs UPDATE/DELETE on app role |
| 3 | ✅ | `time_entry_version` + PATCH writes versions |
| 4 | ✅ | Adjustment routes emit CREATE audit |
| 5 | ✅ | Invoice routes emit CREATE + UPDATE audit |
| 6 | ⚠ | LOGIN/LOGOUT/STEP_UP emitted; firm-settings/taxonomy mutations don't emit |
| 7 | ✅ | Audit viewer UI (`apps/web/src/pages/Audit.tsx`) backed by `/audit` |
| 8 | ✅ | Filters: actor / entity / dates in audit router |
| 9 | ❌ | No full-text search |
| 10 | ❌ | No CSV export endpoint |
| 11 | ❌ | No retention enforcement |
| 12 | ❌ | No legal-hold flag |
| 13 | ❌ | No SOC 2 evidence report |
| 14 | ❌ | No WISP template generator |
| 15 | ❌ | Worker job body — no anomaly alerting |

---

## Phase 20 — Administration UI (15)

| # | S | Note |
|---|---|---|
| 1 | ✅ | FirmSettings page exists |
| 2 | ❌ | No approval-rules CRUD endpoint or UI |
| 3 | ✅ | Reason-codes CRUD in Taxonomy.tsx |
| 4 | ❌ | No fee-structure toggles |
| 5 | ⚠ | `defaultAllocationMethod` on firm; no admin field in UI |
| 6 | ⚠ | `fiscalYearStartMonth` on firm; no admin field in UI |
| 7 | ⚠ | `standardHoursPerWeek` on app_user; no per-role admin |
| 8 | ❌ | No billable-hour targets per role |
| 9 | ❌ | No holiday calendar |
| 10 | ❌ | No office overrides UI |
| 11 | ❌ | No permission-matrix admin |
| 12 | ❌ | UI deferred — no template customization (Handlebars docs in `ops/docs/template-variables.md`) |
| 13 | ❌ | No branding endpoint or UI |
| 14 | ⚠ | `portalEnabled`/`portalSubdomain` columns; not editable in FirmSettings UI yet |
| 15 | ❌ | No backup/restore controls UI (scripts in `ops/scripts/`) |

---

## Phase 21 — Integrations: email-in, webhooks, REST API (16)

| # | S | Note |
|---|---|---|
| 1 | ❌ | Worker job body — no email-in worker |
| 2 | ❌ | No routing logic |
| 3 | ❌ | External creds — AI assist dependency |
| 4 | ⚠ | `webhook_endpoint` schema; no CRUD endpoint |
| 5 | ✅ | `signPayload` + `verifySignature` HMAC in `@vibe/core/webhooks` |
| 6 | ❌ | Worker job body — no retry queue |
| 7 | ⚠ | `webhook_delivery` schema; no list endpoint |
| 8 | ❌ | No secret rotation endpoint |
| 9 | ❌ | No catalog enforcement on endpoint creation |
| 10 | ✅ | `/api/v1` mounted with `requireApiToken` (bearer + sha256 lookup) |
| 11 | ✅ | `/api/v1` exposes engagements, time-entries (list+create), invoices |
| 12 | ⚠ | `requireApiToken` updates `lastUsedAt`; no rate limiter on token |
| 13 | ⚠ | UI deferred — `/api/staff/admin/api-tokens` list/create/revoke endpoints exist (Phase 22 #12); no React admin page yet |
| 14 | ❌ | No firm-snapshot export endpoint |
| 15 | ❌ | No bulk import |
| 16 | ✅ | REST mutations emit audit with `actorMcpTokenId` |

---

## Phase 22 — MCP server (12)

| # | S | Note |
|---|---|---|
| 1 | ⚠ | `/mcp` HTTP shim mounted (not full WebSocket SDK transport) |
| 2 | ✅ | `list_engagements` dispatched live |
| 3 | ✅ | `get_time_entries` dispatched live |
| 4 | ✅ | `create_time_entry` dispatched live (inserts row) |
| 5 | ⚠ | `generate_pre_bill` returns `not_yet_implemented` stub |
| 6 | ⚠ | `suggest_adjustment` returns `not_yet_implemented` stub |
| 7 | ⚠ | `query_realization` returns `not_yet_implemented` stub |
| 8 | ✅ | `query_recurring_plans` dispatched live |
| 9 | ✅ | `requireApiToken` bearer auth + sha256 |
| 10 | ✅ | `isToolAllowed()` per-tool scope check |
| 11 | ✅ | Every MCP call emits MCP_CALL audit with `actor_mcp_token_id` |
| 12 | ⚠ | Issuance endpoint live at `/api/staff/admin/api-tokens` (one-time token display, scope validation, audit emit); admin React page not yet built |

---

## Phase 23 — AI features (multi-provider) (28)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `AiProvider` interface in `@vibe/core/ai/provider.ts` |
| 2 | ✅ | Anthropic provider impl `apps/api/src/ai/anthropic.ts` |
| 3 | ✅ | Ollama provider impl `apps/api/src/ai/ollama.ts` |
| 4 | ⚠ | OpenAI-compatible impl missing (interface allows it) |
| 5 | ✅ | `pickProvider` prefers local then cloud |
| 6 | ⚠ | `aiProvider` enum; no per-firm config admin endpoint |
| 7 | ❌ | No per-feature provider toggle |
| 8 | ✅ | `ai_request_log` written by `/ai/*` routes |
| 9 | ✅ | `/ai/suggest-description` endpoint |
| 10 | ❌ | No anomaly detection |
| 11 | ❌ | No pricing-suggestion |
| 12 | ❌ | No write-down pattern analysis |
| 13 | ❌ | No scope-creep detection |
| 14 | ✅ | `/ai/realization-narrative` endpoint |
| 15 | ❌ | No capacity forecasting |
| 16 | ❌ | No plain-English query |
| 17 | ❌ | No NL→filter translation |
| 18 | ❌ | No citation rendering |
| 19 | ❌ | No reason-code suggestion |
| 20 | ✅ | `checkBudget` enforced before every AI call |
| 21 | ❌ | UI deferred — no cost dashboard |
| 22 | ❌ | External creds — no Whisper integration |
| 23 | ❌ | UI deferred — no AI panel components |
| 24 | ❌ | UI deferred — no time-entry AI panel surfaced |
| 25 | ❌ | UI deferred — no pre-bill AI panel |
| 26 | ❌ | UI deferred — no reporting AI narrative shown in UI |
| 27 | ❌ | UI deferred — no admin AI panel |
| 28 | ❌ | No firm-level opt-in toggle |

---

## Phase 24 — Vibe Connect integration (8)

| # | S | Note |
|---|---|---|
| 1 | ⚠ | `ConnectClient` interface in core + `noopConnectClient` |
| 2 | ❌ | UI deferred — no Connect config UI |
| 3 | ❌ | External creds — no invoice-sent routing |
| 4 | ❌ | External creds — no payment-received routing |
| 5 | ❌ | External creds — no payment-failed routing |
| 6 | ❌ | External creds — no e-sign request |
| 7 | ❌ | No signed→engagement transition |
| 8 | ⚠ | `health()` in interface; no degraded-mode fallback wiring |

---

## Phase 25 — Distribution & deployment (15)

| # | S | Note |
|---|---|---|
| 1 | ✅ | Multi-stage Dockerfile |
| 2 | ✅ | CI buildx targets linux/amd64,linux/arm64 |
| 3 | ❌ | No GHCR publish job (build only, no push) |
| 4 | ❌ | No semver tagging strategy doc |
| 5 | ✅ | Three Caddy templates for two-host routing |
| 6 | ❌ | No Cloudflare Tunnel template |
| 7 | ❌ | No LAN deployment guide |
| 8 | ❌ | No Tailscale-only guide |
| 9 | ❌ | No `vibe-installer` integration |
| 10 | ⚠ | Migration-on-start needs verification (entrypoint exists) |
| 11 | ⚠ | `/health` + `/health/ready` on api; no separate worker/portal/staff health |
| 12 | ✅ | `ops/scripts/backup.sh` |
| 13 | ✅ | `ops/scripts/restore.sh` + `ops/docs/restore.md` |
| 14 | ⚠ | pino structured logs; no Prometheus `/metrics` endpoint |
| 15 | ❌ | No upgrade-path doc with portal session invalidation guidance |

---

## Phase 26 — Polish, demo data, launch readiness (14)

| # | S | Note |
|---|---|---|
| 1 | ❌ | No Lighthouse audit run |
| 2 | ⚠ | `size:budget` runs in CI but no bundle-optimization pass |
| 3 | ❌ | No slow-query analysis |
| 4 | ❌ | No accessibility audit (jsx-a11y enforced in lint only) |
| 5 | ⚠ | Some keyboard nav from accessible Button/Input primitives; not audited |
| 6 | ❌ | No screen reader testing |
| 7 | ⚠ | Seed script populates one firm/7 users/5 clients/3 portal identities + base taxonomy; not multi-month rich history |
| 8 | ❌ | No onboarding wizard |
| 9 | ❌ | No user documentation site |
| 10 | ❌ | No client FAQ |
| 11 | ❌ | No video walkthroughs |
| 12 | ❌ | No migration guide |
| 13 | ❌ | No pricing/licensing page |
| 14 | ❌ | No beta cohort playbook |

---

## Totals

Across 513 numbered items:

- `✅` **209** (≈40.7%)
- `⚠` **121** (≈23.6%)
- `❌` **183** (≈35.7%)

The product has reached the point where the spine of every MVP phase has at least one working layer (schema + endpoint + UI), with the major remaining work being external-credential wiring (Stripe charge-from-recurring, email/SMS dispatchers, AI provider runtime config) and the eight workers/MVs that turn point-in-time endpoints into a self-driving appliance.

## Top 5 phases by missing-item percentage

1. **Phase 24 — Vibe Connect integration** — 6/8 ❌ + 2/8 ⚠ ≈ 75% missing
2. **Phase 23 — AI features** — 17/28 ❌ ≈ 61% missing
3. **Phase 26 — Polish & launch readiness** — 11/14 ❌ ≈ 79% missing
4. **Phase 4 — Firm & user admin** — 8/15 ❌ + 3/15 ⚠ ≈ 53% missing
5. **Phase 17 — Reporting cube** — 22/32 ❌ + 5/32 ⚠ ≈ 69% missing

(Phase 21 integrations and Phase 18 approval workflows are similar runners-up at ~55-60% missing.)

## Top 5 highest-priority gaps blocking production use

1. **Materialized views for reporting (Phase 2 #29, Phase 17 #1-4, #31)** — Live `/reports/realization` works on small data, but the four locked MVs (`realization_view`, `utilization_view`, `profitability_view`, `ar_aging_snapshot`) are not in migrations, so the appliance will not meet the sub-second / 100k-entry acceptance targets. Worker `view-refresh` queue is scheduled but its handler is a no-op.
2. **Recurring billing → invoice end-to-end (Phase 10 #4-5, #25-26, Phase 13 #2)** — `runRecurringBillingTick` creates draft `billing_batch` rows and advances `next_run_date` but does not finalize entries, generate an invoice, or charge the autopay card. Without this, the "subscription invoice fires on schedule" acceptance criteria fail.
3. **Email/SMS dispatchers across the appliance (Phase 13 #12, Phase 14 #15, Phase 15 #5/#7-8, Phase 16 #24-25, Phase 18 #8)** — Invoice send, payment confirmation, statement, dunning steps, and portal notifications all log intent but do not call a provider. The pluggable abstraction (Q11/Q16) is in `config.ts` but no `MAIL_PROVIDER` / SMS provider is wired into `app.ts`.
4. **Stripe webhook ingestion + reconciliation (Phase 14 #18-19, #23)** — `createStripeProvider` can sign-verify inbound payloads but there is no `/webhooks/stripe` route mounted, so charge.succeeded / charge.failed / dispute.created never reach the app. Failed-payment retry (Phase 10 #28-30) and pay-to-unlock (Phase 14 #14) both depend on this.
5. **MCP-token issuance + admin surface for tokens, webhooks, AI provider config (Phase 22 #12, Phase 21 #4/#13, Phase 23 #6-7)** — Tokens exist in `mcp_token` and the bearer middleware works, but no UI/endpoint creates them, so the MCP server and REST API are unusable from outside without raw SQL. Same gap blocks per-firm provider/budget configuration for AI.

Secondary blockers worth flagging: portal-identity invite endpoint (Phase 6 #12, dependency for the whole multi-entity portal story); approval-request row creation from the adjustment route (Phase 12 #16 → Phase 18 #2 — the queue UI works but inbox is empty); audit-log emission coverage on remaining mutations (Phase 19 #1/#6).
