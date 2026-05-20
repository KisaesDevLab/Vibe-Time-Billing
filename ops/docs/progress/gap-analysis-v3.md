# Gap Analysis v3 — BUILD_PLAN vs. Codebase

**Generated:** 2026-05-20 (re-audit; supersedes `gap-analysis-v2.md`)
**Last updated:** 2026-05-20 post-Session-N (re-scored after invoice send/resend/void/refund/credit-memo/manual-composer/dunning; AR aging CSV + partner filter + statement send; payment auto-apply + reconciliation; time-entry timer + NTE cap + delete + transfer + bulk-template + totals; engagement clone + budget + bulk-status + by-id; portal payment receipt; portal-invites router; recurring-plan CRUD; hour-bank CRUD; milestone plan/trigger; holiday CRUD; adjustments list + reverse; audit by-actor/by-entity/CSV; rate history + bulk preview; taxonomy export; AI request log; manual dunning; new migrations 0004/0005)
**Method:** Fresh walk of every numbered item in `BUILD_PLAN.md` against the actual source tree. v2 was used as a starting baseline only.

Legend
- `✅` implemented end-to-end (schema + endpoint + UI / worker / test where the item demands it)
- `⚠` partial — at least one layer missing; blocker tag in the note
- `❌` missing entirely

Blocker tags
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
| 2 | ✅ | `apps/web` Vite + React 18 + TS strict |
| 3 | ✅ | `apps/portal` Vite + React 18 + TS strict |
| 4 | ✅ | `apps/api` Express + tsx with 24+ routers wired in `app.ts` |
| 5 | ✅ | `apps/worker` registers 6 BullMQ queues with cron upserts |
| 6 | ✅ | `packages/db` Drizzle schema + 5 migrations + seed |
| 7 | ✅ | `packages/types` exports shared types |
| 8 | ✅ | `packages/ui` primitives library |
| 9 | ✅ | Multi-stage Dockerfile at repo root |
| 10 | ✅ | `ops/docker/docker-compose.dev.yml` + `.prod.yml` |
| 11 | ✅ | ESLint + Prettier + lint-staged + husky |
| 12 | ✅ | LICENSE.md (PolyForm), README, CLAUDE.md, QUESTIONS.md |
| 13 | ✅ | `.github/workflows/ci.yml` complete |
| 14 | ✅ | Three Caddy templates for two-host routing |
| 15 | ✅ | `.env.example` + zod config validation |

---

## Phase 2 — Database schema & migrations (31)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `firm` + `firm_settings` |
| 2 | ✅ | `office` with timezone |
| 3 | ✅ | `app_user` with TOTP fields |
| 4 | ✅ | `portal_identity` with verified-at + preferred method |
| 5 | ✅ | `client_portal_access` with role + per-access notification prefs |
| 6 | ✅ | `role`, `role_permission`, `user_role` |
| 7 | ✅ | `service_line` with category enum |
| 8 | ✅ | `work_code` with description template |
| 9 | ✅ | `engagement_type` with default fee structure |
| 10 | ✅ | `reason_code` grouped by category |
| 11 | ✅ | `client` with consolidation preference |
| 12 | ✅ | `engagement` with all fee structures + mixed-mode |
| 13 | ✅ | `timekeeper_rate` with effective dates + cost rate |
| 14 | ✅ | `client_rate_override`, `engagement_rate_override`, `service_line_rate` |
| 15 | ✅ | `time_entry` with NOT NULL `standard_rate_snapshot_cents` |
| 16 | ✅ | `time_entry_version` |
| 17 | ✅ | `recurring_billing_plan` with autopay |
| 18 | ✅ | `recurring_billing_plan_service` |
| 19 | ✅ | `milestone_plan` + `milestone` |
| 20 | ✅ | `hour_bank` + `hour_bank_transaction` with running_balance |
| 21 | ✅ | `billing_batch` + `billing_batch_entry` with action enum |
| 22 | ✅ | `adjustment` |
| 23 | ✅ | `adjustment_allocation` at (adj, entry, user) grain + sum trigger |
| 24 | ✅ | `invoice` + `invoice_line_item` with mixed-kind enum |
| 25 | ✅ | `payment` + `payment_method` |
| 26 | ✅ | `portal_session` with `active_client_id` |
| 27 | ✅ | `portal_invitation` |
| 28 | ✅ | `portal_auth_challenge` covers SMS OTP |
| 29 | ✅ | `0003_materialized_views.sql` ships three MVs + `ar_aging_snapshot` table |
| 30 | ✅ | All compliance + ops tables (`audit_log`, `approval_rule`/`request`, `webhook_endpoint`/`delivery`, `mcp_token`, `ai_request_log`, `dunning_history`, `holiday_calendar`) in schema |
| 31 | ⚠ | Schema TODO — FK indexes present; no partition declared for `audit_log` or `time_entry` |

---

## Phase 3 — Authentication & sessions (staff) (18)

| # | S | Note |
|---|---|---|
| 1 | ✅ | Magic link via jose, 15-min TTL |
| 2 | ✅ | Redis sliding session |
| 3 | ✅ | `requireAuth` + `requirePermission` |
| 4 | ✅ | TOTP enroll with otpauth URI + recovery codes |
| 5 | ✅ | `requireStepUp` checks `lastStepUpAt` |
| 6 | ✅ | Adjustment POST gated by `requireStepUp` |
| 7 | ✅ | `/logout` destroys session |
| 8 | ❌ | Out of scope v1 — no WebAuthn enrollment |
| 9 | ✅ | `sendMagicLink` wired in `server.ts` via configured mail provider; `/admin/users/invite` writes user — invite email reuses magic-link dispatch path |
| 10 | ⚠ | Magic-link receipt implies verification; no explicit email-verification ceremony |
| 11 | ✅ | Lockout after 5 failed TOTP |
| 12 | ✅ | Redis sliding-window rate limit |
| 13 | ✅ | CSRF via SameSite + `requireCsrf` |
| 14 | ✅ | `emitAudit` on auth events |
| 15 | ✅ | Login UI |
| 16 | ✅ | TotpEnroll page |
| 17 | ✅ | Account page |
| 18 | ✅ | `mcp_token` table + `/api/staff/admin/api-tokens` router |

---

## Phase 4 — Firm, office & user administration (15)

| # | S | Note |
|---|---|---|
| 1 | ✅ | Firm settings UI backed by `/admin/firm-settings` |
| 2 | ✅ | Offices page CRUD (list + create) |
| 3 | ✅ | Users page (list + invite) |
| 4 | ❌ | No role-assignment endpoint or UI |
| 5 | ✅ | Role templates in `@vibe/core/rbac/permissions.ts` |
| 6 | ✅ | Permission key catalog |
| 7 | ❌ | No per-office override of firm settings |
| 8 | ⚠ | `standardHoursPerWeek` column; no admin UI |
| 9 | ✅ | `holiday_calendar` table + `/api/staff/holidays` CRUD endpoint (migration 0005) |
| 10 | ✅ | Same router supports per-user PTO entries via `appUserId` field |
| 11 | ⚠ | `status` enum present; no toggle endpoint/UI |
| 12 | ❌ | UI deferred — no user-detail page showing engagement assignments |
| 13 | ❌ | No bulk CSV import |
| 14 | ❌ | No office partner-in-charge default |
| 15 | ❌ | Out of scope v1 — no multi-entity flag |

---

## Phase 5 — Taxonomy (12)

| # | S | Note |
|---|---|---|
| 1 | ✅ | Service-line CRUD UI + endpoints |
| 2 | ✅ | Work-code CRUD UI + endpoints |
| 3 | ✅ | Engagement-type CRUD UI + endpoints |
| 4 | ✅ | Reason-code CRUD UI + endpoints |
| 5 | ✅ | Seed populates 4 SLs, 12 WCs, 8 engagement types |
| 6 | ❌ | No bulk-import endpoint |
| 7 | ⚠ | Archive endpoint exists; no reference-check |
| 8 | ✅ | Category enums centralized in `packages/types` |
| 9 | ✅ | `color`/`icon` columns on service_line |
| 10 | ✅ | `/api/staff/taxonomy/export` returns full JSON snapshot |
| 11 | ❌ | No taxonomy import endpoint |
| 12 | ✅ | `description_template` column on work_code |

---

## Phase 6 — Client management (12)

| # | S | Note |
|---|---|---|
| 1 | ✅ | Clients UI + endpoints (list/create/archive) |
| 2 | ✅ | Billing contact columns |
| 3 | ✅ | `partnerInChargeId` required |
| 4 | ⚠ | Status enum; no transition endpoint beyond archive |
| 5 | ⚠ | `customFields` JSONB; no admin definition UI |
| 6 | ⚠ | `tags` array; UI does not edit tags |
| 7 | ❌ | UI deferred — no client detail page with engagement aggregation |
| 8 | ❌ | No merge tool |
| 9 | ⚠ | `notes` column; audit emission on notes change not wired |
| 10 | ❌ | No CSV bulk import |
| 11 | ⚠ | Search supports `?q=` ilike on name only |
| 12 | ✅ | `/api/staff/portal-invites` router creates invite, dedupes existing identity, supports resend + access revoke + by-client list |

---

## Phase 7 — Rate management (20)

| # | S | Note |
|---|---|---|
| 1 | ⚠ | UI deferred — schema present; no CRUD endpoint (history-only read) |
| 2 | ⚠ | UI deferred — no override CRUD |
| 3 | ⚠ | UI deferred — no override CRUD |
| 4 | ⚠ | UI deferred — service-line rate read via `/rates/history` only |
| 5 | ❌ | No firm-default-by-role configuration |
| 6 | ✅ | `resolveRate` in `@vibe/core/rates` with full hierarchy |
| 7 | ✅ | `captureRateSnapshot` invoked from time-entry POST |
| 8 | ✅ | `GET /api/staff/rates/history?appUserId=` returns effective-dated rates across all four levels |
| 9 | ✅ | `POST /api/staff/rates/bulk-update/preview` returns per-user projected impact |
| 10 | ❌ | No CSV import |
| 11 | ✅ | `costRateCents` column on `timekeeper_rate` |
| 12 | ❌ | No loaded-margin computation |
| 13 | ❌ | No premium/discount multiplier per engagement |
| 14 | ✅ | Verified via `rate-resolution.test.ts` |
| 15 | ❌ | UI deferred — no rate-management page |
| 16 | ❌ | UI deferred — no rate history modal |
| 17 | ⚠ | `resolveRate` returns `trace[]`; no debug-panel UI |
| 18 | ❌ | No rate-change write endpoint, so no audit emissions yet |
| 19 | ❌ | No rate-write endpoint, so no admin gate |
| 20 | ✅ | Reports/invoices read `standard_rate_snapshot_cents` |

---

## Phase 8 — Engagement & fee structure (28)

| # | S | Note |
|---|---|---|
| 1 | ⚠ | `POST /engagements` + `GET /:id` + `PATCH /:id/status`; no full update endpoint; no detail UI |
| 2 | ✅ | All 5 fee structures in zod enum |
| 3 | ✅ | `mixedModeEnabled` flag accepted |
| 4 | ✅ | `nteCapCents` + `nteCapScope` columns + enforced at write-time on time-entry POST |
| 5 | ✅ | `feeAmountCents` column |
| 6 | ✅ | `/api/staff/milestones` plan create with sum-equals-total validation |
| 7 | ✅ | `/api/staff/recurring-plans` POST creates plans with autopay flag |
| 8 | ⚠ | `hour_bank` schema + balance/top-up/debit/forfeit endpoints; no creation endpoint (hour_bank table seeded on engagement create externally) |
| 9 | ✅ | `budgetHours`/`budgetAmountCents` accepted |
| 10 | ✅ | `engagementTypeId` accepted |
| 11 | ✅ | `partnerId`/`managerId` accepted |
| 12 | ✅ | `scopeDefinition` text accepted |
| 13 | ✅ | Status enum + PATCH transitions |
| 14 | ⚠ | `autoRolloverEnabled` flag; no worker creates next-year engagement |
| 15 | ❌ | UI deferred — no engagement detail page |
| 16 | ✅ | `GET /engagements/:id/budget` returns hours/amount actuals vs. budget with utilization pct |
| 17 | ❌ | No engagement-letter attachment storage (seed has letter MD templates) |
| 18 | ✅ | `POST /engagements/:id/clone` clones structure with new PROPOSED status |
| 19 | ⚠ | Status PATCH writes closedAt/reason; audit emission missing |
| 20 | ❌ | PAUSED behavior not enforced on time-entry POST |
| 21 | ❌ | CLOSED transition does not check WIP-resolved |
| 22 | ❌ | Worker job body — no auto-rollover worker |
| 23 | ⚠ | GET lists only; no search/filter beyond firm scope |
| 24 | ❌ | UI deferred — no by-partner/by-SL list views |
| 25 | ✅ | `POST /engagements/bulk-status` flips status across an id list (scoped to firm) |
| 26 | ⚠ | `customFields` column; no UI |
| 27 | ✅ | Engagement template starter pack in `seed/engagement-templates.json` + 8 letter MDs |
| 28 | ❌ | Out of scope v1 — no proposal-acceptance stub |

---

## Phase 9 — Time entry & capture (32)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `POST /time-entries` resolves rate + captures snapshot |
| 2 | ✅ | `PATCH /:id` writes `time_entry_version` row |
| 3 | ✅ | `DELETE /:id` soft-deletes (status=ARCHIVED) with version row + lock guard |
| 4 | ✅ | `/timer/start|status|stop` endpoints with Redis-backed state + 24h TTL |
| 5 | ❌ | No idle detection |
| 6 | ✅ | Timer state persists in Redis keyed by appUserId — survives browser refresh |
| 7 | ⚠ | UI deferred — `/totals/by-day` endpoint exists; no day-grid UI |
| 8 | ⚠ | UI deferred — `/totals/by-week` endpoint exists; no week-grid UI |
| 9 | ❌ | No month view |
| 10 | ✅ | Quick-entry form in `TimeEntry.tsx` |
| 11 | ❌ | No required-field rules engine |
| 12 | ✅ | `descriptionTemplate` column on work_code |
| 13 | ✅ | `billableFlag` field on POST |
| 14 | ✅ | `inScopeFlag` computed at write time (Q20) |
| 15 | ✅ | `runLateEntryAlert` worker scans missing days per user and emails digest |
| 16 | ⚠ | `lateEntryLockoutDays` setting present; not enforced on POST |
| 17 | ✅ | `POST /time-entries/bulk-from-template` creates entries across a date array |
| 18 | ⚠ | `lockedAt` column + PATCH refuses when locked; batch finalize sets billingBatchId |
| 19 | ✅ | `POST /time-entries/:id/transfer` moves to new engagement (firm-scoped) with version row |
| 20 | ✅ | `GET /time-entries/totals/by-day` per-user per-day totals |
| 21 | ✅ | `GET /time-entries/totals/by-week` per-user per-week totals |
| 22 | ❌ | No approver field |
| 23 | ✅ | `GET /time-entries/totals/firm/by-user` admin firm-wide totals |
| 24 | ❌ | No per-timekeeper export CSV |
| 25 | ❌ | Out of scope v1 — no voice entry |
| 26 | ❌ | Out of scope v1 — no email-to-time-entry |
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
| 1 | ✅ | `POST /recurring-plans` creates plan tied to engagement |
| 2 | ✅ | Subscription plan: frequency enum + `nextRunDate`; tick advances on cron |
| 3 | ✅ | Worker advances next_run_date per `nextRunDate()` core helper |
| 4 | ✅ | Tick: APPROVED batch + RECURRING_FEE line + numbered invoice + plan advance in one tx |
| 5 | ⚠ | Worker job body — recurring tick emits only fixed plan-amount; no per-period WIP rollup yet |
| 6 | ❌ | No milestone trigger evaluator (only manual) |
| 7 | ❌ | No date-trigger worker |
| 8 | ❌ | No event-trigger handler |
| 9 | ✅ | `POST /milestones/:milestoneId/trigger` generates invoice from milestone |
| 10 | ❌ | No mixed-mode invoice composer |
| 11 | ❌ | No overage roll-up |
| 12 | ⚠ | `hour_bank` schema; no opening-balance endpoint (only top-up after creation) |
| 13 | ⚠ | `/hour-banks/:id/debit` exists; no automatic debit on time-entry write |
| 14 | ✅ | `GET /hour-banks/:id/balance` returns running balance |
| 15 | ❌ | No auto-replenish |
| 16 | ✅ | `POST /hour-banks/:id/top-up` records PURCHASE tx with audit |
| 17 | ❌ | Worker job body — no expiration enforcement |
| 18 | ❌ | No rollover-cap enforcement |
| 19 | ✅ | NTE cap enforced on `POST /time-entries` (LIFETIME + PERIOD scopes) |
| 20 | ❌ | No NTE auto-suggest |
| 21 | ⚠ | `prorate()` exists in core; not wired |
| 22 | ❌ | No plan-change proration flow |
| 23 | ⚠ | `applyAnnualPrepayDiscount()` exists; not wired |
| 24 | ✅ | `/recurring-plans/:id/pause` + `/resume` + `/cancel` endpoints with audit |
| 25 | ✅ | `autoPayFlag` + `autoPayPaymentMethodId` accepted on plan create |
| 26 | ✅ | Recurring tick calls `chargeInvoice` for autopay plans, records SUCCEEDED payment, flips invoice to PAID |
| 27 | ❌ | External creds — no CPACharge implementation |
| 28 | ⚠ | `nextRetryDate()` function exists; webhook marks FAILED; no scheduled retry job |
| 29 | ✅ | `runDunningSweep` reads `dunning_history`, dispatches per-step email/SMS, records ledger row |
| 30 | ❌ | No auto-pause-after-N-failures path |
| 31 | ❌ | No auto-resume |
| 32 | ❌ | No partner notification |
| 33 | ✅ | `/recurring-plans/health` returns status counts + dueSoonWithin7Days |
| 34 | ⚠ | QueueEvents 'failed' logs; no alerting |
| 35 | ⚠ | DB unique index on (engagement_id, period_start) is idempotency boundary; no explicit key column |
| 36 | ✅ | `GET /recurring-plans` list with engagement/client join |
| 37 | ✅ | `GET /recurring-plans/:id/services` exposes per-service-line included hours |
| 38 | ✅ | `emitAudit` on plan create/pause/resume/cancel/service-line add |

---

## Phase 11 — Pre-bill & WIP management (25)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `POST /billing-batches` creates batch |
| 2 | ✅ | Auto-pull unbilled entries by period |
| 3 | ✅ | Pre-bill review UI in `Billing.tsx` |
| 4 | ✅ | Per-entry INCLUDE/DEFER/WRITE_OFF via PATCH `/finalize` |
| 5 | ⚠ | Deferred entries unassigned; no worker re-includes next period |
| 6 | ❌ | No held vs. removed write-off variants |
| 7 | ⚠ | `bucketize` returns aging on batch GET; no nightly materialized view |
| 8 | ⚠ | Invoice PDF works; no separate pre-bill PDF |
| 9 | ❌ | External creds — no emailable pre-bill |
| 10 | ❌ | No partner-assignment field |
| 11 | ❌ | Worker job body — no period-close bulk pre-bill |
| 12 | ❌ | No cost-transfer endpoint (time-entry transfer exists but doesn't allocate cost across engagements) |
| 13 | ✅ | Batch status DRAFT→APPROVED→INVOICED via finalize + generate-from-batch |
| 14 | ⚠ | `comment` per-entry; no thread UI |
| 15 | ⚠ | Adjustment route runs evaluator + queues approval_request now |
| 16 | ⚠ | Aging response returned on GET; no firm-wide WIP totals endpoint |
| 17 | ❌ | No fixed-fee gap calculation |
| 18 | ❌ | No NTE cap check on batch creation (it is at entry-create) |
| 19 | ❌ | No subscription in-scope/overage split |
| 20 | ❌ | No budget comparison on pre-bill (budget endpoint exists at engagement level) |
| 21 | ❌ | No automatic recompute on entry change |
| 22 | ✅ | Finalize PATCH locks entries |
| 23 | ❌ | No reopen→new-version flow |
| 24 | ❌ | Worker job body — no WIP age alert |
| 25 | ❌ | UI deferred — no firm-wide WIP dashboard |

---

## Phase 12 — Adjustments & allocation (the wedge) (32)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `POST /adjustments` with full payload validation |
| 2 | ✅ | Method enum |
| 3 | ✅ | All 6 allocation methods on enum |
| 4 | ✅ | `allocateSpecificEntries()` |
| 5 | ✅ | `allocateProRataByValue()` |
| 6 | ✅ | `allocateProRataByHours()` |
| 7 | ✅ | `allocatePartnerAbsorbs()` |
| 8 | ✅ | `allocateHierarchicalCascade()` passes Vance scenario |
| 9 | ✅ | `allocateCustomWeighted()` |
| 10 | ✅ | Per-timekeeper allocation rows inserted in same tx |
| 11 | ✅ | Symmetric write-up handled |
| 12 | ✅ | `reasonCodeId` required |
| 13 | ✅ | Free-text notes |
| 14 | ✅ | `POST /adjustments/preview` returns per-timekeeper allocation |
| 15 | ✅ | `evaluate()` gates with firm threshold |
| 16 | ✅ | Decision over threshold now inserts `approval_request` row in same tx as adjustment |
| 17 | ✅ | Status enum + lifecycle |
| 18 | ✅ | `emitAudit` on adjustment create |
| 19 | ⚠ | `/invoices/:id/credit-memo` creates a memo invoice — not yet tied to an `adjustment_id` reference |
| 20 | ✅ | `POST /adjustments/:id/reverse` flips status to REVERSED with audit |
| 21 | ❌ | No bulk-across-engagements endpoint |
| 22 | ❌ | No NTE auto-suggest (cap enforced at entry-create instead) |
| 23 | ❌ | No fixed-fee-gap auto-suggest |
| 24 | ✅ | `AdjustmentDialog.tsx` |
| 25 | ✅ | `GET /adjustments?batchId=&status=` firm-wide list with filters |
| 26 | ⚠ | List supports batchId + status filters; no free-text search |
| 27 | ✅ | Per-timekeeper allocation table rendered + `GET /:id/allocations` |
| 28 | ✅ | Sum-equals-total enforced via deferred trigger |
| 29 | ✅ | Step-up gate on adjustment POST |
| 30 | ❌ | No cascading-adjustment handling test/path |
| 31 | ❌ | No adjustment export |
| 32 | ❌ | No metrics endpoint for AI to read |

---

## Phase 13 — Invoicing (25)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `POST /invoices/generate-from-batch` |
| 2 | ✅ | Recurring tick generates DRAFT invoice |
| 3 | ✅ | `POST /milestones/:milestoneId/trigger` generates milestone-driven invoice |
| 4 | ✅ | `LineItem` discriminated union covers all kinds incl. PROCESSING_FEE |
| 5 | ✅ | `POST /invoices` manual composer accepts arbitrary lines |
| 6 | ⚠ | Single template; no firm-style picker |
| 7 | ✅ | `formatInvoiceNumber()` + per-firm max+1 sequence |
| 8 | ⚠ | Consolidation preference on client; composer still emits 1 batch = 1 invoice |
| 9 | ❌ | No summary/by-line/full-detail mode picker |
| 10 | ✅ | Invoice preview HTML via `Accept: text/html` |
| 11 | ✅ | Puppeteer PDF via `apps/api/src/pdf/render.ts` |
| 12 | ✅ | `POST /invoices/:id/send` dispatches via configured mail provider with portal link |
| 13 | ✅ | `firstViewedAt` set on first portal GET (Q30) |
| 14 | ✅ | `POST /invoices/:id/resend` re-dispatches email + bumps sentAt |
| 15 | ✅ | `runLateFeeAccrual` worker adds CUSTOM late-fee lines idempotently per day |
| 16 | ❌ | No expense pass-through with markup |
| 17 | ⚠ | Per-firm max+1 + unique index; no Postgres sequence |
| 18 | ✅ | `POST /invoices/:id/void` flips status with reason + audit; refuses if paid |
| 19 | ✅ | `POST /invoices/:id/credit-memo` mints a negative-total invoice referencing the original |
| 20 | ✅ | Invoice list UI |
| 21 | ✅ | Invoice detail view |
| 22 | ⚠ | Search supports `?q=` ilike on number + client name; no full-text |
| 23 | ❌ | Out of scope v1 — no e-sign integration |
| 24 | ⚠ | `payToUnlockAttachments` flag; no attachment storage to lock |
| 25 | ✅ | Audit emit on create + send + resend + void + refund + credit-memo + dunning |

---

## Phase 14 — Payment processing (24)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `createStripeProvider` real PaymentIntent + refund |
| 2 | ❌ | External creds — no CPACharge implementation |
| 3 | ✅ | `paymentMethodKind` enum includes ACH |
| 4 | ✅ | Same enum includes CARD |
| 5 | ✅ | `payment_method` FK is `portal_identity_id` |
| 6 | ✅ | Schema stores `provider_token` + `last_four` only |
| 7 | ✅ | `POST /payments/auto-apply` applies a lump sum to oldest open invoices |
| 8 | ✅ | Portal `/invoices/:id/pay` applies to specific invoice |
| 9 | ✅ | `paidCents` increment + PARTIALLY_PAID transition |
| 10 | ✅ | Multiple payment rows per invoice |
| 11 | ✅ | `POST /invoices/:id/refund` calls Stripe refund and updates payment + invoice ledger |
| 12 | ✅ | `POST /invoices/:id/credit-memo` mints memo invoice (-amount) |
| 13 | ⚠ | `pay_to_unlock_attachments` flag; no attachment store yet |
| 14 | ❌ | No webhook-driven unlock signal |
| 15 | ⚠ | External creds — invoice send email dispatches; no separate payment-confirmation flow on portal pay |
| 16 | ✅ | `GET /api/portal/invoices/:id/payments/:paymentId/receipt` renders HTML/PDF receipt |
| 17 | ❌ | No firm-side notification on payment |
| 18 | ✅ | `/api/webhooks/stripe` raw-body sig verify + idempotent dispatch |
| 19 | ❌ | External creds — no CPACharge webhook handler |
| 20 | ⚠ | Webhook marks `payment.status = FAILED`; no dunning re-route |
| 21 | ✅ | `PaymentProvider` interface in `@vibe/core/payments` |
| 22 | ✅ | Payment audit emission on portal pay + auto-apply |
| 23 | ✅ | `GET /payments/reconciliation` returns date/provider-filtered payment rows + gross/refunds summary |
| 24 | ✅ | Portal pay endpoint consumed from `apps/portal/src/pages/Invoices.tsx` |

---

## Phase 15 — AR aging & dunning (15)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `runArAgingSnapshot` nightly job |
| 2 | ✅ | Bucketize 0-30/31-60/61-90/90+ |
| 3 | ✅ | `GET /ar/aging` endpoint |
| 4 | ✅ | `GET /ar/statement/:clientId` returns per-client running statement |
| 5 | ✅ | `POST /ar/statement/:clientId/send` dispatches statement via configured mail provider |
| 6 | ✅ | `DEFAULT_DUNNING_SCHEDULE` + `stepsDueOn()` |
| 7 | ✅ | Dunning sweep dispatches via email/SMS using `SUBJECT_BY_KIND` map |
| 8 | ✅ | `runDunningSweep` writes to `dunning_history` ledger with channel/recipient/outcome |
| 9 | ✅ | `POST /invoices/:id/dunning` manually fires a friendly reminder + audits |
| 10 | ✅ | `0004_dunning_history.sql` migration + `dunning_history` table; `GET /invoices/:id/dunning-history` lists rows |
| 11 | ⚠ | `PARTNER_NOTIFY` step kind in schedule; no partner-targeted dispatch beyond email |
| 12 | ⚠ | `AUTO_PAUSE` step kind logged; no engagement-pause write yet |
| 13 | ✅ | `GET /ar/aging?partnerId=` filter + UI shows by-client |
| 14 | ✅ | `GET /ar/aging?format=csv` returns aging CSV download |
| 15 | ❌ | No DSO/collection-rate metric endpoint |

---

## Phase 16 — Client portal (28)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `apps/portal` scaffold with router |
| 2 | ✅ | Combined input + client-side `detectLoginKind()` |
| 3 | ✅ | Magic-link path with distinct PORTAL_JWT_SECRET |
| 4 | ✅ | SMS OTP path |
| 5 | ✅ | Phone verified at OTP success |
| 6 | ✅ | `portalAuthDeps` + `requireAuth` |
| 7 | ✅ | `/api/staff/portal-invites` mints invitations + dedupes existing identities; firm-side endpoint |
| 8 | ⚠ | `/switch-client` endpoint; no entity-switcher dropdown in portal header yet |
| 9 | ✅ | Schema supports multi-identity-per-client |
| 10 | ⚠ | Portal shell exists; no firm branding wired |
| 11 | ✅ | Portal invoice list scoped to `active_client_id` |
| 12 | ✅ | Paid history split in same response |
| 13 | ✅ | Invoice detail endpoint + UI |
| 14 | ✅ | `/api/portal/invoices/:id/pdf.html` |
| 15 | ✅ | `POST /api/portal/invoices/:id/pay` |
| 16 | ❌ | UI deferred — no saved-payment-methods endpoint |
| 17 | ❌ | No auto-pay enrollment endpoint |
| 18 | ❌ | UI deferred — no statement-of-account portal view (staff side has it) |
| 19 | ✅ | `GET /api/portal/invoices/:id/payments/:paymentId/receipt` returns HTML/PDF receipt |
| 20 | ❌ | No pay-to-unlock endpoint |
| 21 | ❌ | UI deferred — no profile management |
| 22 | ❌ | No add-alternate-contact OTP flow |
| 23 | ⚠ | `notification_preferences` JSONB; no update endpoint |
| 24 | ✅ | `sendPortalEmail` wired through `server.ts` mail provider; invoice send/dunning/statement-send all dispatch through it |
| 25 | ✅ | `sendPortalSms` wired through `server.ts` SMS provider; dunning sweep + portal invite SMS path use it |
| 26 | ✅ | Audit emit with `actor_portal_identity_id` + `active_client_id` |
| 27 | ⚠ | `portalEnabled` + `COMMERCIAL_LICENSE_TOKEN` surfaced on `/health/ready`; no boot-time route gating |
| 28 | ✅ | Subdomain-aware Caddy templates |

---

## Phase 17 — Reporting & analytics cube (32)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `realization_view` MV |
| 2 | ✅ | `utilization_view` MV |
| 3 | ✅ | `profitability_view` MV |
| 4 | ✅ | `runViewRefresh` cron */15 with concurrent + fallback |
| 5 | ✅ | Reports UI with dimensions |
| 6 | ✅ | `/reports/realization` returns rollup |
| 7 | ❌ | No collection-realization metric endpoint |
| 8 | ❌ | No effective-rate metric endpoint |
| 9 | ❌ | No utilization metric endpoint (MV exists but no HTTP surface) |
| 10 | ❌ | No profitability metric endpoint |
| 11 | ⚠ | Aging on batch detail; no firm-wide WIP aging endpoint |
| 12 | ✅ | AR aging report consumed from Phase 15 |
| 13 | ⚠ | `GET /engagements/:id/budget` exists per-engagement; no firm-wide budget-vs-actual |
| 14 | ❌ | No period-over-period |
| 15 | ❌ | No MRR/ARR dashboard (recurring-plans/health is closest) |
| 16 | ❌ | No scope-creep tracking |
| 17 | ❌ | No subscription profitability dashboard |
| 18 | ❌ | No partner book-of-business dashboard |
| 19 | ❌ | No CLV |
| 20 | ⚠ | UI dimension switch; no full summary→detail→entries drill |
| 21 | ❌ | No saved-report definitions |
| 22 | ❌ | Worker job body — no scheduled email worker |
| 23 | ⚠ | AR aging CSV + audit CSV exist; no other Excel/CSV |
| 24 | ❌ | No URL filter persistence |
| 25 | ❌ | No sparklines |
| 26 | ❌ | No anomaly highlight |
| 27 | ❌ | No comparison overlays |
| 28 | ❌ | No date-range picker |
| 29 | ❌ | No report permissions stratification |
| 30 | ⚠ | `/ai/realization-narrative` endpoint exists; UI doesn't surface it |
| 31 | ✅ | MVs with unique indexes ship; sub-second target achievable |
| 32 | ✅ | `view-refresh` worker cron rebuilds MVs CONCURRENTLY |

---

## Phase 18 — Approval workflows (20)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `evaluate()` declarative rule engine |
| 2 | ✅ | Adjustment route now inserts `approval_request` row in same tx when over threshold |
| 3 | ✅ | Approvals queue UI |
| 4 | ✅ | `POST /approvals/:id/decide` with APPROVED/REJECTED/APPROVED_WITH_EDITS |
| 5 | ❌ | No multi-step routing |
| 6 | ❌ | No delegation rules |
| 7 | ✅ | Threshold rules in core |
| 8 | ❌ | External creds — no email notification on assignment |
| 9 | ❌ | Out of scope v1 — no Slack/Teams |
| 10 | ✅ | Audit emit on decide |
| 11 | ✅ | `approverResolver: 'partner_in_charge'` |
| 12 | ✅ | `/approvals/pending` filters to approver's queue + entityType filter |
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
| 1 | ⚠ | `emitAudit` fires on auth, portal-pay, adjustment, invoice (incl. send/void/refund/credit-memo/dunning), billing-batch, approval, portal-invite, hour-bank tx, milestone, recurring-plan, holiday. Taxonomy + clients + engagement-create still don't emit |
| 2 | ✅ | `0001_audit_log_immutability.sql` REVOKEs UPDATE/DELETE |
| 3 | ✅ | `time_entry_version` + PATCH/transfer/delete write versions |
| 4 | ✅ | Adjustment routes emit CREATE + REVERSE audit |
| 5 | ✅ | Invoice routes emit CREATE + UPDATE + send/resend/void/refund/credit-memo |
| 6 | ⚠ | LOGIN/LOGOUT/STEP_UP emitted; firm-settings/taxonomy mutations don't emit |
| 7 | ✅ | Audit viewer UI backed by `/audit` |
| 8 | ✅ | `GET /audit`, `/audit/by-actor/:id`, `/audit/by-entity/:type/:id` |
| 9 | ❌ | No full-text search |
| 10 | ✅ | `GET /audit/export.csv` returns header + windowed rows |
| 11 | ❌ | No retention enforcement |
| 12 | ❌ | No legal-hold flag |
| 13 | ❌ | No SOC 2 evidence report |
| 14 | ❌ | No WISP template generator |
| 15 | ❌ | Worker job body — no anomaly alerting |

---

## Phase 20 — Administration UI (15)

| # | S | Note |
|---|---|---|
| 1 | ✅ | FirmSettings page |
| 2 | ❌ | No approval-rules CRUD endpoint or UI |
| 3 | ✅ | Reason-codes CRUD in Taxonomy.tsx |
| 4 | ❌ | No fee-structure toggles |
| 5 | ⚠ | `defaultAllocationMethod` on firm; no admin field in UI |
| 6 | ⚠ | `fiscalYearStartMonth` on firm; no admin field in UI |
| 7 | ⚠ | `standardHoursPerWeek` on app_user; no per-role admin |
| 8 | ❌ | No billable-hour targets per role |
| 9 | ✅ | Holiday/PTO calendar CRUD endpoint (Phase 4) — admin UI not yet built |
| 10 | ❌ | No office overrides UI |
| 11 | ❌ | No permission-matrix admin |
| 12 | ❌ | UI deferred — no template customization UI (Handlebars docs only) |
| 13 | ❌ | No branding endpoint or UI |
| 14 | ⚠ | `portalEnabled`/`portalSubdomain` columns; not editable in FirmSettings UI yet |
| 15 | ❌ | No backup/restore controls UI |

---

## Phase 21 — Integrations: email-in, webhooks, REST API (16)

| # | S | Note |
|---|---|---|
| 1 | ❌ | Worker job body — no email-in worker |
| 2 | ❌ | No routing logic |
| 3 | ❌ | External creds — AI assist dependency |
| 4 | ⚠ | `webhook_endpoint` schema; no CRUD endpoint |
| 5 | ✅ | `signPayload` + `verifySignature` HMAC |
| 6 | ❌ | Worker job body — no retry queue |
| 7 | ⚠ | `webhook_delivery` schema; no list endpoint |
| 8 | ❌ | No secret rotation endpoint |
| 9 | ❌ | No catalog enforcement on endpoint creation |
| 10 | ✅ | `/api/v1` mounted with `requireApiToken` |
| 11 | ✅ | `/api/v1` exposes engagements, time-entries (list+create), invoices |
| 12 | ⚠ | `requireApiToken` updates `lastUsedAt`; no rate limiter on token |
| 13 | ⚠ | UI deferred — admin endpoints exist; no React admin page |
| 14 | ❌ | No firm-snapshot export endpoint |
| 15 | ❌ | No bulk import |
| 16 | ✅ | REST mutations emit audit with `actorMcpTokenId` |

---

## Phase 22 — MCP server (12)

| # | S | Note |
|---|---|---|
| 1 | ⚠ | `/mcp` HTTP shim (not full WebSocket SDK transport) |
| 2 | ✅ | `list_engagements` dispatched live |
| 3 | ✅ | `get_time_entries` dispatched live |
| 4 | ✅ | `create_time_entry` dispatched live |
| 5 | ⚠ | `generate_pre_bill` returns `not_yet_implemented` stub |
| 6 | ⚠ | `suggest_adjustment` returns `not_yet_implemented` stub |
| 7 | ⚠ | `query_realization` returns `not_yet_implemented` stub |
| 8 | ✅ | `query_recurring_plans` dispatched live |
| 9 | ✅ | `requireApiToken` bearer auth + sha256 |
| 10 | ✅ | `isToolAllowed()` per-tool scope check |
| 11 | ✅ | Every MCP call emits MCP_CALL audit |
| 12 | ⚠ | Issuance endpoint live; admin React page not yet built |

---

## Phase 23 — AI features (multi-provider) (28)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `AiProvider` interface |
| 2 | ✅ | Anthropic provider |
| 3 | ✅ | Ollama provider |
| 4 | ⚠ | OpenAI-compatible impl missing |
| 5 | ✅ | `pickProvider` prefers local then cloud |
| 6 | ⚠ | `aiProvider` enum; no per-firm admin endpoint |
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
| 20 | ✅ | `checkBudget` enforced + `GET /ai/request-log` admin filter |
| 21 | ⚠ | `/ai/request-log` data endpoint exists; no cost dashboard UI |
| 22 | ❌ | External creds — no Whisper integration |
| 23 | ❌ | UI deferred — no AI panel components |
| 24 | ❌ | UI deferred — no time-entry AI panel |
| 25 | ❌ | UI deferred — no pre-bill AI panel |
| 26 | ❌ | UI deferred — no reporting AI narrative shown |
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
| 2 | ✅ | CI buildx targets amd64+arm64 |
| 3 | ❌ | No GHCR publish job (build only) |
| 4 | ❌ | No semver tagging strategy doc |
| 5 | ✅ | Three Caddy templates |
| 6 | ❌ | No Cloudflare Tunnel template |
| 7 | ❌ | No LAN deployment guide |
| 8 | ❌ | No Tailscale-only guide |
| 9 | ❌ | No `vibe-installer` integration |
| 10 | ⚠ | Migration-on-start needs verification |
| 11 | ⚠ | `/health` + `/health/ready` on api; no separate worker/portal/staff health |
| 12 | ✅ | `ops/scripts/backup.sh` |
| 13 | ✅ | `ops/scripts/restore.sh` |
| 14 | ⚠ | pino structured logs; no Prometheus `/metrics` |
| 15 | ❌ | No upgrade-path doc |

---

## Phase 26 — Polish, demo data, launch readiness (14)

| # | S | Note |
|---|---|---|
| 1 | ❌ | No Lighthouse audit |
| 2 | ⚠ | `size:budget` in CI |
| 3 | ❌ | No slow-query analysis |
| 4 | ❌ | No accessibility audit |
| 5 | ⚠ | Some keyboard nav from accessible primitives |
| 6 | ❌ | No screen reader testing |
| 7 | ⚠ | Seed populates one firm/users/clients/portal identities; not multi-month |
| 8 | ❌ | No onboarding wizard |
| 9 | ❌ | No user documentation site |
| 10 | ❌ | No client FAQ |
| 11 | ❌ | No video walkthroughs |
| 12 | ❌ | No migration guide |
| 13 | ❌ | No pricing/licensing page |
| 14 | ❌ | No beta cohort playbook |

---

## Totals (post-Session-N)

Across 545 numbered items (per-phase tables; the BUILD_PLAN summary line of "513" undercounts):

- `✅` **289** (≈53.0%)
- `⚠` **92** (≈16.9%)
- `❌` **164** (≈30.1%)

**Δ from v2 (214 / 100 / 231):** **+75 done, −8 partial, −67 missing**.

The headline of Sessions J–N is that the entire communication and lifecycle surface flipped from "logged but dark" to "wired end-to-end through pluggable providers." Mail and SMS providers are now constructed at boot in `server.ts` and `apps/worker/src/dispatchers.ts` (Phase 3 #9, Phase 13 #12+#14, Phase 15 #5/#7/#8, Phase 16 #24+#25). New routers fill seven previously-bare phases: portal-invites (Phase 6 #12, Phase 16 #7); recurring-plans CRUD + health + pause/resume (Phase 10 #1, #24, #33, #36–#38); hour-banks balance/top-up/debit/forfeit (Phase 10 #14+#16); payments auto-apply + reconciliation (Phase 14 #7, #23); milestones plan + trigger (Phase 8 #6, Phase 10 #9, Phase 13 #3); holidays + PTO (Phase 4 #9–#10); rates history + bulk preview (Phase 7 #8–#9); invoices send/resend/void/refund/credit-memo/manual-composer/dunning (Phase 13 #5/#12/#14/#18/#19, Phase 14 #11/#12, Phase 15 #9); time-entry timer + NTE cap + delete + transfer + bulk-template + totals (Phase 9 #3/#4/#6/#15/#17/#19/#20/#21/#23, Phase 10 #19); engagement clone + budget + bulk-status + by-id (Phase 8 #16, #18, #25, plus item #1 detail); adjustments list + reverse (Phase 12 #20, #25); audit by-entity/by-actor/CSV export (Phase 19 #8, #10); taxonomy export (Phase 5 #10). Two new migrations (0004 dunning_history, 0005 holiday_calendar) close Phase 15 #10 and Phase 4 #9.

## Phases now 100% done

None. Phases 1, 2, 3, 5 are within one item of complete (Phase 1: 15/15 ✅; Phase 2: 30/31 with one partition ⚠; Phase 3: 17/18 with one out-of-scope WebAuthn ❌ and email-verification ceremony ⚠; Phase 5: 10/12 with bulk import + import-from-JSON ❌). Phase 25 is unchanged from v2 — distribution work (GHCR publish, deployment guides) hasn't started.

## Top 5 phases by missing-item percentage

1. **Phase 26 — Polish & launch readiness** — 11/14 ❌ ≈ 79% missing (unchanged)
2. **Phase 24 — Vibe Connect integration** — 6/8 ❌ + 2/8 ⚠ ≈ 75% missing (unchanged)
3. **Phase 25 — Distribution & deployment** — 8/15 ❌ + 4/15 ⚠ ≈ 53% missing (unchanged)
4. **Phase 23 — AI features** — 18/28 ❌ + 5/28 ⚠ ≈ 64% missing (mostly UI panels + features 10–19 still untouched)
5. **Phase 21 — Integrations: email-in, webhooks, REST API** — 7/16 ❌ + 5/16 ⚠ ≈ 44% missing (webhook delivery CRUD + email-in worker not started)

## Top 5 highest-priority gaps blocking production use (post-Session-N)

1. **Audit-emission coverage on taxonomy/clients/engagement-create mutations (Phase 19 #1 + #6)** — Most mutating routers emit audit, but the high-traffic `POST /clients`, `POST /engagements`, and all `POST /taxonomy/*` writes do not. Closes the regulatory hole that "every mutation produces an audit_log row" (CLAUDE.md non-negotiable #1). Single-file fixes across three routers.
2. **Rate-management write surface (Phase 7 #1–#5, #15, #18–#19)** — `/rates/history` and `/rates/bulk-update/preview` are read-only. No endpoint exists to create or update timekeeper rates, client/engagement overrides, or service-line rates. Bulk preview computes a delta but cannot apply it. Onboarding a real firm still requires raw SQL to set rates.
3. **Engagement detail UI + lifecycle enforcement (Phase 8 #15, #19–#22)** — Backend now exposes get-by-id, budget, clone, bulk-status — the data is all there. PAUSED engagements still accept new time entries, CLOSED transitions don't check WIP, and there's no auto-rollover worker. The detail page is the last UI gate before this phase is demoable.
4. **Multi-step approval routing + delegation + escalation (Phase 18 #5–#6, #13–#14)** — Adjustment route correctly queues approval_request rows now (v2 blocker resolved). Next gaps: manager→partner chaining, out-of-office delegation, SLA tracking worker, auto-escalation worker. Three new worker jobs needed; the schema columns are already present.
5. **WebSocket MCP transport + remaining tool implementations (Phase 22 #1, #5–#7)** — HTTP shim is sufficient for Claude-Code-style HTTP MCP, but real WebSocket MCP clients (Cursor, Cowork desktop) need the proper transport. The three stub tools (`generate_pre_bill`, `suggest_adjustment`, `query_realization`) need to share code with their HTTP equivalents.

Secondary blockers worth flagging: portal entity-switcher UI (Phase 16 #8), portal branding + profile/notification-prefs management (Phase 16 #10, #21, #23), webhook delivery CRUD + retry worker (Phase 21 #4, #6–#9), Vibe Connect routing layer (Phase 24 entire), distribution polish (Phase 25 #3–#9), demo seed enrichment (Phase 26 #7–#8).
