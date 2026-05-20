# Gap Analysis v5 — BUILD_PLAN vs. Codebase

**Generated:** 2026-05-20 (re-audit; supersedes `gap-analysis-v4.md`)
**Method:** Fresh walk of every numbered item in `BUILD_PLAN.md` against the current source tree (8 sessions S–DD after v4). Verified each delta by reading router/job/UI/migration that allegedly shipped.

**Summary:** **545** items total.
- `✅` **365** (≈67.0%)
- `⚠` **83** (≈15.2%)
- `❌` **97** (≈17.8%)

**Δ from v4 (332 / 88 / 125):** **+33 done, −5 partial, −28 missing**.

Big movers since v4: outbound webhook CRUD + dispatch worker + secret rotation + replay + event catalog (Phase 21 #4, #6–#9), MCP fleshed-out tools `generate_pre_bill`/`suggest_adjustment`/`query_realization` (Phase 22 #5–#7), auto-rollover scanner (Phase 8 #22), recurring-plan auto-pause-after-N-failures (Phase 10 #30), retention enforcement worker (Phase 19 #11), scope-creep + WIP-age alert workers (Phase 11 #24, Phase 17/19), period-close bulk pre-bill + firm-wide WIP dashboard endpoint+UI (Phase 11 #11, #25), expense pass-through with markup (Phase 13 #16), `/aging/by-service-line` + new portal Statement/PaymentMethods pages (Phase 16 #16, #18 UI), bulk-preview adjustments + `/metrics` endpoints (Phase 12 #32, Phase 18 #19–#20, Phase 23 #20), `/reports/dso|collection-realization|effective-rate|revenue-period-over-period|mrr|book-of-business|clv|scope-creep` and `/engagements/:id/fixed-fee-gap|nte-suggest` (Phase 11 #17, Phase 15 #15, Phase 17 #7–#9, #14–#19), firm branding migration + admin UI (Phase 20 #13), required-field rules engine + `/totals/by-month` + `/suggestions/mine` + `/export.csv/by-timekeeper` (Phase 9 #9, #23, #31), saved-reports CRUD + admin (Phase 17 #21), `/permission-matrix` + page (Phase 20 #11).

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
| 4 | ✅ | `apps/api` Express + tsx; 35+ routers wired in `app.ts` |
| 5 | ✅ | `apps/worker` registers 14 BullMQ jobs with cron upserts |
| 6 | ✅ | `packages/db` Drizzle schema + 12 migrations (0000–0011) + seed |
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
| 1 | ✅ | `firm` + `firm_settings` (now incl. 6 branding cols + adjustment_approval_threshold) |
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
| 17 | ✅ | `recurring_billing_plan` + `consecutive_failure_count` + `autopay_pause_threshold` (0011) |
| 18 | ✅ | `recurring_billing_plan_service` |
| 19 | ✅ | `milestone_plan` + `milestone` |
| 20 | ✅ | `hour_bank` + `hour_bank_transaction` |
| 21 | ✅ | `billing_batch` + `billing_batch_entry` |
| 22 | ✅ | `adjustment` |
| 23 | ✅ | `adjustment_allocation` at (adj, entry, user) grain + sum trigger |
| 24 | ✅ | `invoice` + `invoice_line_item` |
| 25 | ✅ | `payment` + `payment_method` |
| 26 | ✅ | `portal_session` with `active_client_id` |
| 27 | ✅ | `portal_invitation` |
| 28 | ✅ | `portal_auth_challenge` covers SMS OTP |
| 29 | ✅ | `0003_materialized_views.sql` ships three MVs + `ar_aging_snapshot` |
| 30 | ✅ | Compliance + ops tables incl. saved_report (0009) |
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
| 9 | ✅ | `sendMagicLink` wired via configured mail provider |
| 10 | ⚠ | Magic-link receipt implies verification; no explicit email-verification ceremony |
| 11 | ✅ | Lockout after 5 failed TOTP |
| 12 | ✅ | Redis sliding-window rate limit |
| 13 | ✅ | CSRF via SameSite + `requireCsrf` |
| 14 | ✅ | `emitAudit` on auth events |
| 15 | ✅ | Login UI |
| 16 | ✅ | TotpEnroll page |
| 17 | ✅ | Account page |
| 18 | ✅ | `mcp_token` + `/api/staff/admin/api-tokens` CRUD |

---

## Phase 4 — Firm, office & user administration (15)

| # | S | Note |
|---|---|---|
| 1 | ✅ | Firm settings UI backed by `/admin/firm-settings` (now includes branding section) |
| 2 | ✅ | Offices page CRUD |
| 3 | ✅ | Users page (list + invite + detail) |
| 4 | ✅ | `/admin/roles`, `/admin/users/:id/roles` + permission-matrix endpoint |
| 5 | ✅ | Role templates in `@vibe/core/rbac/permissions.ts` |
| 6 | ✅ | Permission key catalog + `/admin/permission-matrix` GET endpoint + `PermissionMatrix.tsx` |
| 7 | ❌ | No per-office override of firm settings |
| 8 | ⚠ | `standardHoursPerWeek` column; no admin UI |
| 9 | ✅ | `holiday_calendar` + `/api/staff/holidays` CRUD + admin Holidays.tsx |
| 10 | ✅ | Same router supports per-user PTO entries via `appUserId` field |
| 11 | ✅ | `/admin/users/:id/archive` + PATCH toggles status |
| 12 | ✅ | `GET /admin/users/:id` returns engagement assignments; Users.tsx links to detail |
| 13 | ✅ | `POST /admin/users/import` CSV-aware bulk import |
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
| 10 | ✅ | `/api/staff/taxonomy/export` returns JSON snapshot |
| 11 | ❌ | No taxonomy import endpoint |
| 12 | ✅ | `description_template` column on work_code |

---

## Phase 6 — Client management (12)

| # | S | Note |
|---|---|---|
| 1 | ✅ | Clients UI + endpoints |
| 2 | ✅ | Billing contact columns |
| 3 | ✅ | `partnerInChargeId` required |
| 4 | ⚠ | Status enum; transitions limited to archive endpoint |
| 5 | ⚠ | `customFields` JSONB; no admin definition UI |
| 6 | ⚠ | `tags` array; UI does not edit tags |
| 7 | ✅ | `ClientDetail.tsx` renders engagement aggregation via `/stats/client/:clientId` |
| 8 | ❌ | No merge tool |
| 9 | ✅ | `client_note` table + `/clients/:id/notes` CRUD with audit |
| 10 | ✅ | `POST /clients/bulk-import` CSV import endpoint |
| 11 | ⚠ | Search supports `?q=` ilike on name only |
| 12 | ✅ | `/api/staff/portal-invites` router (invite, dedupe, resend, revoke, by-client) |

---

## Phase 7 — Rate management (20)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `POST /rates/timekeeper` |
| 2 | ✅ | `POST/DELETE /rates/client-override/:id` |
| 3 | ✅ | `POST/DELETE /rates/engagement-override/:id` |
| 4 | ✅ | `POST/PATCH/DELETE /rates/service-line/:id` |
| 5 | ❌ | No firm-default-by-role configuration |
| 6 | ✅ | `resolveRate` in `@vibe/core/rates` with full hierarchy |
| 7 | ✅ | `captureRateSnapshot` invoked from time-entry POST |
| 8 | ✅ | `GET /api/staff/rates/history?appUserId=` |
| 9 | ✅ | `POST /rates/bulk-update/preview` + `/bulk-update/commit` |
| 10 | ❌ | No CSV import |
| 11 | ✅ | `costRateCents` column on `timekeeper_rate` |
| 12 | ✅ | `GET /rates/loaded-margin` returns bill/cost/marginPct |
| 13 | ❌ | No premium/discount multiplier per engagement |
| 14 | ✅ | Verified via `rate-resolution.test.ts` |
| 15 | ✅ | `Rates.tsx` admin page lists margins + write form |
| 16 | ⚠ | History endpoint live; no history modal in UI |
| 17 | ⚠ | `resolveRate` returns `trace[]`; no debug-panel UI |
| 18 | ✅ | Rate write endpoints emit audit |
| 19 | ✅ | Rate write endpoints gated by `rate:write` permission |
| 20 | ✅ | Reports/invoices read `standard_rate_snapshot_cents` |

---

## Phase 8 — Engagement & fee structure (28)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `POST /engagements` + GET/PATCH; EngagementDetail.tsx wired |
| 2 | ✅ | All 5 fee structures in zod enum |
| 3 | ✅ | `mixedModeEnabled` flag accepted |
| 4 | ✅ | `nteCapCents` + `nteCapScope` enforced at write-time |
| 5 | ✅ | `feeAmountCents` column |
| 6 | ✅ | `/api/staff/milestones` plan create with sum-equals-total validation |
| 7 | ✅ | `/api/staff/recurring-plans` POST creates plans with autopay flag |
| 8 | ⚠ | `hour_bank` schema + balance/top-up/debit/forfeit; no auto-create alongside engagement |
| 9 | ✅ | `budgetHours`/`budgetAmountCents` accepted |
| 10 | ✅ | `engagementTypeId` accepted |
| 11 | ✅ | `partnerId`/`managerId` accepted |
| 12 | ✅ | `scopeDefinition` text accepted |
| 13 | ✅ | Status enum + PATCH transitions |
| 14 | ⚠ | `autoRolloverEnabled` flag accepted; scan worker notifies — no auto-create per Q23 |
| 15 | ✅ | `EngagementDetail.tsx` with engagement + summary + milestones + banks |
| 16 | ✅ | `GET /engagements/:id/budget` returns hours/amount actuals vs. budget |
| 17 | ✅ | `engagement_letters` table + `/engagement-letters` CRUD + send/accept/void |
| 18 | ✅ | `POST /engagements/:id/clone` clones structure |
| 19 | ✅ | Status PATCH emits audit on every transition |
| 20 | ✅ | PAUSED/CLOSED/ARCHIVED refused on time-entry POST |
| 21 | ✅ | CLOSED transition refuses with 409 when SUBMITTED entries remain |
| 22 | ✅ | `auto-rollover-scan` worker writes audit-log notifications per Q23 spec |
| 23 | ✅ | `GET /engagements/export.csv` + filtering by clientId/partnerId/status |
| 24 | ⚠ | List filters supported; no dedicated by-partner/by-SL views in UI |
| 25 | ✅ | `POST /engagements/bulk-status` flips status across an id list |
| 26 | ⚠ | `customFields` column; no UI |
| 27 | ✅ | Engagement template starter pack in `seed/engagement-templates.json` + 8 letter MDs |
| 28 | ❌ | Out of scope v1 — no proposal-acceptance stub |

---

## Phase 9 — Time entry & capture (32)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `POST /time-entries` resolves rate + captures snapshot |
| 2 | ✅ | `PATCH /:id` writes `time_entry_version` row |
| 3 | ✅ | `DELETE /:id` soft-deletes with version row + lock guard |
| 4 | ✅ | `/timer/start|status|stop` with Redis-backed state + 24h TTL |
| 5 | ❌ | No idle detection |
| 6 | ✅ | Timer state persists in Redis keyed by appUserId |
| 7 | ⚠ | UI deferred — `/totals/by-day` endpoint exists; no day-grid UI |
| 8 | ⚠ | UI deferred — `/totals/by-week` endpoint exists; no week-grid UI |
| 9 | ⚠ | UI deferred — `/totals/by-month` endpoint exists; no month-grid UI |
| 10 | ✅ | Quick-entry form in `TimeEntry.tsx` |
| 11 | ✅ | `/required-field-rules` CRUD + evaluator applied at POST |
| 12 | ✅ | `descriptionTemplate` column on work_code |
| 13 | ✅ | `billableFlag` field on POST |
| 14 | ✅ | `inScopeFlag` computed at write time |
| 15 | ✅ | `runLateEntryAlert` worker scans missing days, emails digest |
| 16 | ⚠ | `lateEntryLockoutDays` setting present; not enforced on POST |
| 17 | ✅ | `POST /time-entries/bulk-from-template` |
| 18 | ✅ | `lockedAt` + PATCH refuses; batch finalize sets billingBatchId |
| 19 | ✅ | `POST /time-entries/:id/transfer` with version row |
| 20 | ✅ | `GET /time-entries/totals/by-day` |
| 21 | ✅ | `GET /time-entries/totals/by-week` |
| 22 | ❌ | No approver field |
| 23 | ✅ | `GET /time-entries/totals/firm/by-user` admin firm-wide totals |
| 24 | ✅ | `GET /time-entries/export.csv/by-timekeeper/:appUserId` |
| 25 | ❌ | Out of scope v1 — no voice entry |
| 26 | ❌ | Out of scope v1 — no email-to-time-entry |
| 27 | ❌ | Out of scope v1 — workflow integration |
| 28 | ❌ | UI deferred — no mobile PWA shell |
| 29 | ❌ | UI deferred — no offline drafts |
| 30 | ⚠ | TimeEntry.tsx filters engagements; no permission-scoped narrowing |
| 31 | ✅ | `GET /time-entries/suggestions/mine` ranks (engagement, work-code) by 30d frequency |
| 32 | ✅ | `RequiredFieldRules.tsx` admin page |

---

## Phase 10 — Recurring billing engine (38)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `POST /recurring-plans` creates plan tied to engagement |
| 2 | ✅ | Subscription plan: frequency enum + `nextRunDate`; tick advances |
| 3 | ✅ | Worker advances next_run_date per `nextRunDate()` |
| 4 | ✅ | Tick: APPROVED batch + RECURRING_FEE line + numbered invoice |
| 5 | ⚠ | Worker job body — fixed plan-amount only; no per-period WIP rollup |
| 6 | ⚠ | `milestone-date-trigger` flips PENDING→TRIGGERED only; no event-trigger evaluator |
| 7 | ✅ | `milestone-date-trigger` worker fires on `triggerDate` arrival |
| 8 | ❌ | No event-trigger handler |
| 9 | ✅ | `POST /milestones/:milestoneId/trigger` generates invoice from milestone |
| 10 | ❌ | No mixed-mode invoice composer |
| 11 | ❌ | No overage roll-up |
| 12 | ⚠ | `hour_bank` schema; opening-balance via top-up only |
| 13 | ⚠ | `/hour-banks/:id/debit` exists; no automatic debit on time-entry write |
| 14 | ✅ | `GET /hour-banks/:id/balance` returns running balance |
| 15 | ❌ | No auto-replenish |
| 16 | ✅ | `POST /hour-banks/:id/top-up` records PURCHASE tx with audit |
| 17 | ✅ | `hour-bank-expiration` worker writes EXPIRE tx + marks forfeited |
| 18 | ❌ | No rollover-cap enforcement |
| 19 | ✅ | NTE cap enforced on POST `/time-entries` (LIFETIME + PERIOD scopes) |
| 20 | ✅ | `GET /engagements/:id/nte-suggest` returns suggested cap based on history |
| 21 | ⚠ | `prorate()` exists in core; not wired |
| 22 | ❌ | No plan-change proration flow |
| 23 | ⚠ | `applyAnnualPrepayDiscount()` exists; not wired |
| 24 | ✅ | `/recurring-plans/:id/pause|resume|cancel` with audit |
| 25 | ✅ | `autoPayFlag` + `autoPayPaymentMethodId` accepted on plan create |
| 26 | ✅ | Recurring tick calls `chargeInvoice` for autopay, records SUCCEEDED payment |
| 27 | ❌ | External creds — no CPACharge implementation |
| 28 | ⚠ | `nextRetryDate()` exists; webhook marks FAILED; no scheduled retry job |
| 29 | ✅ | `runDunningSweep` dispatches per-step email/SMS, records ledger |
| 30 | ✅ | Recurring-billing worker auto-pauses after N consecutive autopay failures (0011 + worker) |
| 31 | ❌ | No auto-resume on payment-method update |
| 32 | ❌ | No partner notification on pause |
| 33 | ✅ | `/recurring-plans/health` returns status counts + dueSoonWithin7Days |
| 34 | ⚠ | QueueEvents 'failed' logs; no alerting |
| 35 | ⚠ | Unique index on (engagement_id, period_start) is idempotency boundary; no explicit key |
| 36 | ✅ | `GET /recurring-plans` list with engagement/client join |
| 37 | ✅ | `GET /recurring-plans/:id` detail + `/:id/services` + `/:id/invoices` |
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
| 11 | ✅ | `POST /billing-batches/period-close` bulk pre-bill per-engagement |
| 12 | ❌ | No cost-transfer endpoint (time-entry transfer doesn't allocate cost) |
| 13 | ✅ | Batch DRAFT→APPROVED→INVOICED via finalize + generate-from-batch |
| 14 | ⚠ | `comment` per-entry; no thread UI |
| 15 | ✅ | Adjustment route runs evaluator + queues approval_request |
| 16 | ✅ | `GET /billing-batches/wip-dashboard` firm-wide WIP rollup endpoint |
| 17 | ✅ | `GET /engagements/:id/fixed-fee-gap` returns WIP vs. fee gap |
| 18 | ❌ | No NTE cap check on batch creation (at entry-create only) |
| 19 | ❌ | No subscription in-scope/overage split |
| 20 | ❌ | No budget comparison on pre-bill |
| 21 | ❌ | No automatic recompute on entry change |
| 22 | ✅ | Finalize PATCH locks entries |
| 23 | ❌ | No reopen→new-version flow |
| 24 | ✅ | `wip-age-alert` worker writes audit notification for engagements >45d unbilled |
| 25 | ✅ | `Wip.tsx` firm-wide dashboard wired to `/wip-dashboard` |

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
| 16 | ✅ | Decision over threshold inserts `approval_request` row in same tx |
| 17 | ✅ | Status enum + lifecycle |
| 18 | ✅ | `emitAudit` on adjustment create |
| 19 | ⚠ | `/invoices/:id/credit-memo` exists — not yet tied to an `adjustment_id` reference |
| 20 | ✅ | `POST /adjustments/:id/reverse` flips status to REVERSED with audit |
| 21 | ✅ | `POST /adjustments/bulk-preview` multi-batch target-realization preview |
| 22 | ❌ | No NTE auto-suggest (cap enforced at entry-create instead) |
| 23 | ❌ | No fixed-fee-gap auto-suggest (gap endpoint exists but no adjustment hint UI) |
| 24 | ✅ | `AdjustmentDialog.tsx` |
| 25 | ✅ | `GET /adjustments?batchId=&status=` firm-wide list |
| 26 | ⚠ | List filters batchId + status; no free-text search |
| 27 | ✅ | Per-timekeeper allocation rendered + `GET /:id/allocations` |
| 28 | ✅ | Sum-equals-total enforced via deferred trigger |
| 29 | ✅ | Step-up gate on adjustment POST |
| 30 | ❌ | No cascading-adjustment handling test/path |
| 31 | ✅ | `GET /adjustments/export.csv` returns header + rows |
| 32 | ✅ | `bulk-preview` + future metrics; per-status counts via `/count-by-status` |

---

## Phase 13 — Invoicing (25)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `POST /invoices/generate-from-batch` |
| 2 | ✅ | Recurring tick generates DRAFT invoice |
| 3 | ✅ | `POST /milestones/:milestoneId/trigger` generates milestone-driven invoice |
| 4 | ✅ | `LineItem` discriminated union covers all kinds incl. PROCESSING_FEE + EXPENSE |
| 5 | ✅ | `POST /invoices` manual composer accepts arbitrary lines |
| 6 | ⚠ | Single template; no firm-style picker |
| 7 | ✅ | `formatInvoiceNumber()` + per-firm max+1 sequence |
| 8 | ⚠ | Consolidation preference on client; composer still 1 batch = 1 invoice |
| 9 | ❌ | No summary/by-line/full-detail mode picker |
| 10 | ✅ | Invoice preview HTML via `Accept: text/html` |
| 11 | ✅ | Puppeteer PDF via `apps/api/src/pdf/render.ts` |
| 12 | ✅ | `POST /invoices/:id/send` dispatches via mail provider + publishes `invoice.sent` |
| 13 | ✅ | `firstViewedAt` set on first portal GET (Q30) |
| 14 | ✅ | `POST /invoices/:id/resend` re-dispatches + bumps sentAt |
| 15 | ✅ | `runLateFeeAccrual` worker adds CUSTOM late-fee lines idempotently |
| 16 | ✅ | `POST /invoices/:id/expense` adds cost+markup EXPENSE line items |
| 17 | ⚠ | Per-firm max+1 + unique index; no Postgres sequence |
| 18 | ✅ | `POST /invoices/:id/void` flips status with reason + audit |
| 19 | ✅ | `POST /invoices/:id/credit-memo` mints negative-total invoice |
| 20 | ✅ | Invoice list UI with export.csv |
| 21 | ✅ | Invoice detail view + line items CRUD + notes + dunning-history |
| 22 | ⚠ | Search `?q=` ilike on number + client name; no full-text |
| 23 | ❌ | Out of scope v1 — no e-sign integration |
| 24 | ⚠ | `payToUnlockAttachments` flag; attachments table exists but no lock enforcement |
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
| 7 | ✅ | `POST /payments/auto-apply` applies lump sum to oldest open invoices |
| 8 | ✅ | Portal `/invoices/:id/pay` applies to specific invoice |
| 9 | ✅ | `paidCents` increment + PARTIALLY_PAID transition |
| 10 | ✅ | Multiple payment rows per invoice |
| 11 | ✅ | `POST /invoices/:id/refund` Stripe refund + invoice ledger update |
| 12 | ✅ | `POST /invoices/:id/credit-memo` mints memo invoice |
| 13 | ⚠ | `pay_to_unlock_attachments` flag; no lock enforcement |
| 14 | ❌ | No webhook-driven unlock signal |
| 15 | ⚠ | External creds — invoice send dispatches; no separate payment-confirmation flow |
| 16 | ✅ | `GET /api/portal/invoices/:id/payments/:paymentId/receipt` |
| 17 | ✅ | Stripe webhook publishes `payment.received`/`payment.failed` outbound events |
| 18 | ✅ | `/api/webhooks/stripe` raw-body sig verify + idempotent dispatch |
| 19 | ❌ | External creds — no CPACharge webhook handler |
| 20 | ⚠ | Webhook marks `payment.status = FAILED`; no dunning re-route |
| 21 | ✅ | `PaymentProvider` interface in `@vibe/core/payments` |
| 22 | ✅ | Payment audit emission on portal pay + auto-apply |
| 23 | ✅ | `GET /payments/reconciliation` + `/refunds` |
| 24 | ✅ | Portal pay endpoint consumed from `apps/portal/src/pages/Invoices.tsx` |

---

## Phase 15 — AR aging & dunning (15)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `runArAgingSnapshot` nightly job |
| 2 | ✅ | Bucketize 0-30/31-60/61-90/90+ |
| 3 | ✅ | `GET /ar/aging` endpoint |
| 4 | ✅ | `GET /ar/statement/:clientId` returns running statement |
| 5 | ✅ | `POST /ar/statement/:clientId/send` dispatches statement |
| 6 | ✅ | `DEFAULT_DUNNING_SCHEDULE` + `stepsDueOn()` |
| 7 | ✅ | Dunning sweep dispatches via email/SMS |
| 8 | ✅ | `runDunningSweep` writes to `dunning_history` ledger |
| 9 | ✅ | `POST /invoices/:id/dunning` manual reminder + audits |
| 10 | ✅ | Migration 0004 + `GET /invoices/:id/dunning-history` |
| 11 | ⚠ | `PARTNER_NOTIFY` step kind defined; no partner-targeted dispatch |
| 12 | ⚠ | `AUTO_PAUSE` step kind logged; no engagement-pause write yet |
| 13 | ✅ | `GET /ar/aging?partnerId=` + by-service-line |
| 14 | ✅ | `GET /ar/aging?format=csv` |
| 15 | ✅ | `GET /reports/dso` + `/collection-realization` metric endpoints |

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
| 7 | ✅ | `/api/staff/portal-invites` mints invitations + dedupes |
| 8 | ⚠ | `/switch-client` endpoint; no entity-switcher dropdown in portal UI |
| 9 | ✅ | Schema supports multi-identity-per-client |
| 10 | ⚠ | Branding columns + admin write; portal shell still hardcodes "Client Portal" |
| 11 | ✅ | Portal invoice list scoped to `active_client_id` |
| 12 | ✅ | Paid history split in same response |
| 13 | ✅ | Invoice detail endpoint + UI |
| 14 | ✅ | `/api/portal/invoices/:id/pdf.html` |
| 15 | ✅ | `POST /api/portal/invoices/:id/pay` |
| 16 | ✅ | `PaymentMethods.tsx` page wired to GET/DELETE + set-autopay |
| 17 | ✅ | `POST /api/portal/profile/payment-methods/:id/set-autopay` |
| 18 | ✅ | `Statement.tsx` page wired to `/statement` endpoint |
| 19 | ✅ | `GET /api/portal/invoices/:id/payments/:paymentId/receipt` |
| 20 | ❌ | No pay-to-unlock endpoint |
| 21 | ✅ | `PATCH /api/portal/profile/me` updates name/preferred method |
| 22 | ❌ | No add-alternate-contact OTP flow |
| 23 | ⚠ | `notification_preferences` JSONB; no update endpoint |
| 24 | ✅ | `sendPortalEmail` wired through `server.ts` |
| 25 | ✅ | `sendPortalSms` wired through `server.ts` |
| 26 | ✅ | Audit emit with `actor_portal_identity_id` + `active_client_id` |
| 27 | ⚠ | `portalEnabled` + `COMMERCIAL_LICENSE_TOKEN` on `/health/ready`; no boot-time route gating |
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
| 7 | ✅ | `/reports/collection-realization` |
| 8 | ✅ | `/reports/effective-rate` |
| 9 | ✅ | `/reports/utilization` |
| 10 | ✅ | `/reports/profitability` |
| 11 | ✅ | `/billing-batches/wip-dashboard` firm-wide WIP rollup |
| 12 | ✅ | AR aging report consumed from Phase 15 |
| 13 | ✅ | `GET /engagements/:id/budget` + `/fixed-fee-gap` |
| 14 | ✅ | `/reports/revenue-period-over-period` |
| 15 | ✅ | `/reports/mrr` dashboard endpoint |
| 16 | ✅ | `/reports/scope-creep` |
| 17 | ⚠ | MRR endpoint live; no dedicated subscription-profitability dashboard |
| 18 | ✅ | `/reports/book-of-business` |
| 19 | ✅ | `/reports/clv` |
| 20 | ⚠ | UI dimension switch; no full summary→detail→entries drill |
| 21 | ✅ | `saved_report` table + `/saved-reports` CRUD + `SavedReports.tsx` admin |
| 22 | ❌ | Worker job body — no scheduled email worker for saved reports |
| 23 | ⚠ | AR aging CSV + audit CSV + invoice CSV + adjustment CSV; no Excel |
| 24 | ❌ | No URL filter persistence |
| 25 | ❌ | No sparklines |
| 26 | ❌ | No anomaly highlight |
| 27 | ❌ | No comparison overlays |
| 28 | ❌ | No date-range picker |
| 29 | ❌ | No report permissions stratification |
| 30 | ⚠ | `/ai/realization-narrative` exists; UI doesn't surface it |
| 31 | ✅ | MVs with unique indexes; sub-second target achievable |
| 32 | ✅ | `view-refresh` worker cron rebuilds MVs CONCURRENTLY |

---

## Phase 18 — Approval workflows (20)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `evaluate()` declarative rule engine |
| 2 | ✅ | Approval rules CRUD (`/approvals/rules` GET/POST/PATCH/DELETE) |
| 3 | ✅ | Approvals queue UI |
| 4 | ✅ | `POST /approvals/:id/decide` with APPROVED/REJECTED/APPROVED_WITH_EDITS |
| 5 | ❌ | No multi-step routing |
| 6 | ✅ | `POST /approvals/:id/delegate` reassigns to backup |
| 7 | ✅ | Threshold rules in core |
| 8 | ❌ | External creds — no email notification on assignment |
| 9 | ❌ | Out of scope v1 — no Slack/Teams |
| 10 | ✅ | Audit emit on decide + delegate + reassign |
| 11 | ✅ | `approverResolver: 'partner_in_charge'` |
| 12 | ✅ | `/approvals/pending` filters to approver's queue + entityType filter |
| 13 | ⚠ | `slaHours` column; no tracking worker |
| 14 | ✅ | `approval-escalation` worker scans PENDING + clears approver on auto-escalate |
| 15 | ✅ | `approval_comment` table + `/:id/comments` CRUD |
| 16 | ✅ | `POST /approvals/rules/:id/dry-run` evaluator |
| 17 | ✅ | Comments thread visible via `/:id/comments` GET + UI |
| 18 | ✅ | `POST /approvals/:id/reassign` admin reassignment |
| 19 | ✅ | `GET /approvals/export.csv` |
| 20 | ✅ | `GET /approvals/metrics` (count, avg time to decide, rejection rate) |

---

## Phase 19 — Audit trail & compliance (15)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `emitAudit` fires on auth, portal-pay, adjustment, invoice, billing-batch, approval, portal-invite, hour-bank, milestone, recurring-plan, holiday, client CRUD, engagement CRUD, taxonomy CRUD, rate writes, attachments, webhook endpoint mutations |
| 2 | ✅ | `0001_audit_log_immutability.sql` REVOKEs UPDATE/DELETE |
| 3 | ✅ | `time_entry_version` + PATCH/transfer/delete write versions |
| 4 | ✅ | Adjustment routes emit CREATE + REVERSE audit |
| 5 | ✅ | Invoice routes emit CREATE + UPDATE + send/resend/void/refund/credit-memo |
| 6 | ✅ | LOGIN/LOGOUT/STEP_UP emitted; taxonomy/clients/engagements/rates emit |
| 7 | ✅ | Audit viewer UI backed by `/audit` |
| 8 | ✅ | `GET /audit`, `/audit/by-actor/:id`, `/audit/by-entity/:type/:id`, `/audit/by-ip/:ip` |
| 9 | ❌ | No full-text search |
| 10 | ✅ | `GET /audit/export.csv` |
| 11 | ✅ | `retention-enforcement` worker purges `ai_request_log` + `webhook_delivery` past retention; audit_log exempt |
| 12 | ❌ | No legal-hold flag |
| 13 | ❌ | No SOC 2 evidence report |
| 14 | ❌ | No WISP template generator |
| 15 | ❌ | Worker job body — no anomaly alerting (scope-creep + wip-age workers exist but not generalized) |

---

## Phase 20 — Administration UI (15)

| # | S | Note |
|---|---|---|
| 1 | ✅ | FirmSettings page |
| 2 | ✅ | ApprovalRules.tsx page backed by `/approvals/rules` CRUD |
| 3 | ✅ | Reason-codes CRUD in Taxonomy.tsx |
| 4 | ❌ | No fee-structure toggles |
| 5 | ⚠ | `defaultAllocationMethod` on firm; no admin field in UI |
| 6 | ⚠ | `fiscalYearStartMonth` on firm; no admin field in UI |
| 7 | ⚠ | `standardHoursPerWeek` on app_user; no per-role admin |
| 8 | ❌ | No billable-hour targets per role |
| 9 | ✅ | Holidays.tsx admin page wired |
| 10 | ❌ | No office overrides UI |
| 11 | ✅ | `/admin/permission-matrix` endpoint + `PermissionMatrix.tsx` page |
| 12 | ❌ | UI deferred — no template customization UI |
| 13 | ⚠ | Branding cols + admin form write; not consumed by PDF/portal yet |
| 14 | ⚠ | `portalEnabled`/`portalSubdomain` columns; not editable in FirmSettings UI |
| 15 | ❌ | No backup/restore controls UI |

---

## Phase 21 — Integrations: email-in, webhooks, REST API (16)

| # | S | Note |
|---|---|---|
| 1 | ❌ | Worker job body — no email-in worker |
| 2 | ❌ | No routing logic |
| 3 | ❌ | External creds — AI assist dependency |
| 4 | ✅ | `/api/staff/webhooks` CRUD + secret returned once + `Webhooks.tsx` page |
| 5 | ✅ | `signPayload` + `verifySignature` HMAC + dispatcher uses HMAC-SHA256 |
| 6 | ✅ | `webhook-dispatch` worker with exponential backoff (30s→8h, 6 attempts) |
| 7 | ✅ | `webhook_delivery` schema + `/:id/deliveries` list + replay endpoint |
| 8 | ✅ | `POST /webhooks/:id/rotate-secret` returns new secret once |
| 9 | ✅ | `KNOWN_EVENTS` catalog enforced by zod on endpoint create + `/known-events` GET |
| 10 | ✅ | `/api/v1` mounted with `requireApiToken` |
| 11 | ✅ | `/api/v1` exposes engagements, time-entries (list+create), invoices |
| 12 | ⚠ | `requireApiToken` updates `lastUsedAt`; no rate limiter on token |
| 13 | ✅ | `/api/staff/admin/api-tokens` CRUD + admin UI under jobs panel |
| 14 | ❌ | No firm-snapshot export endpoint |
| 15 | ⚠ | `/clients/bulk-import` covers clients; no firm-wide bulk import |
| 16 | ✅ | REST mutations emit audit with `actorMcpTokenId` |

---

## Phase 22 — MCP server (12)

| # | S | Note |
|---|---|---|
| 1 | ⚠ | `/mcp` HTTP shim (not full WebSocket SDK transport) |
| 2 | ✅ | `list_engagements` dispatched live |
| 3 | ✅ | `get_time_entries` dispatched live |
| 4 | ✅ | `create_time_entry` dispatched live |
| 5 | ✅ | `generate_pre_bill` creates billing_batch + entries scoped to firm |
| 6 | ✅ | `suggest_adjustment` returns WIP + target write-down delta |
| 7 | ✅ | `query_realization` returns dimension-rollup scoped to firm |
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
| 4 | ⚠ | `openai_compatible` in enum; no impl class |
| 5 | ✅ | `pickProvider` prefers local then cloud |
| 6 | ⚠ | `aiProvider` enum; no per-firm admin endpoint |
| 7 | ❌ | No per-feature provider toggle |
| 8 | ✅ | `ai_request_log` written by `/ai/*` routes |
| 9 | ✅ | `/ai/suggest-description` endpoint |
| 10 | ❌ | No anomaly detection AI feature |
| 11 | ❌ | No pricing-suggestion |
| 12 | ❌ | No write-down pattern analysis |
| 13 | ❌ | No scope-creep AI feature (`/reports/scope-creep` is rule-based) |
| 14 | ✅ | `/ai/realization-narrative` endpoint |
| 15 | ❌ | No capacity forecasting |
| 16 | ✅ | `/ai/plain-english-query` translates to plan bullets |
| 17 | ⚠ | Endpoint returns plan text; no NL→structured-filter translation |
| 18 | ❌ | No citation rendering |
| 19 | ❌ | No reason-code suggestion |
| 20 | ✅ | `checkBudget` enforced + `GET /ai/request-log` + `/ai/metrics` admin endpoints |
| 21 | ✅ | `AiUsage.tsx` admin page renders request log + metrics |
| 22 | ❌ | External creds — no Whisper integration |
| 23 | ❌ | UI deferred — no AI panel components |
| 24 | ❌ | UI deferred — no time-entry AI panel |
| 25 | ❌ | UI deferred — no pre-bill AI panel |
| 26 | ❌ | UI deferred — no reporting AI narrative shown |
| 27 | ❌ | UI deferred — AiUsage shows log only, no pricing-renewal panel |
| 28 | ❌ | No firm-level opt-in toggle |

---

## Phase 24 — Vibe Connect integration (8)

| # | S | Note |
|---|---|---|
| 1 | ⚠ | `ConnectClient` interface in core + `noopConnectClient` + HTTP client impl |
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
| 7 | ⚠ | Seed populates one firm/users/clients/portal identities + Vance scenario; not multi-month |
| 8 | ❌ | No onboarding wizard |
| 9 | ❌ | No user documentation site |
| 10 | ❌ | No client FAQ |
| 11 | ❌ | No video walkthroughs |
| 12 | ❌ | No migration guide |
| 13 | ❌ | No pricing/licensing page |
| 14 | ❌ | No beta cohort playbook |

---

## Phases now ≥95% done

- **Phase 1** (15/15 ✅) — 100%
- **Phase 2** (30/31 ✅) — partition strategy is the only gap
- **Phase 3** (16/18 ✅) — only WebAuthn (OOS) + explicit email verification ceremony missing
- **Phase 12** (29/32 ✅) — bulk-preview added; only credit-memo link, NTE/gap auto-suggest, cascading test missing
- **Phase 14** (20/24 ✅) — Stripe + payments largely complete; CPACharge OOS
- **Phase 15** (13/15 ✅) — partner-notify + auto-pause action still partial
- **Phase 17** (24/32 ✅, ~75%) — endpoints fan-out done; UX polish (drill, sparklines, dates) outstanding
- **Phase 18** (19/20 ✅) — only multi-step routing missing
- **Phase 21** (10/16 ✅, +5 vs v4) — webhook outbound fully landed; email-in still OOS

## Top 5 phases by missing-item percentage (v5)

1. **Phase 26 — Polish & launch readiness** — 11/14 ❌ ≈ 79% missing (unchanged)
2. **Phase 24 — Vibe Connect integration** — 6/8 ❌ + 2/8 ⚠ ≈ 75% missing (unchanged)
3. **Phase 23 — AI features** — 15/28 ❌ + 4/28 ⚠ ≈ 54% missing (UI panels + features 10–13, 15, 18, 19)
4. **Phase 25 — Distribution & deployment** — 8/15 ❌ + 4/15 ⚠ ≈ 53% missing (unchanged)
5. **Phase 21 — Integrations** — 4/16 ❌ + 3/16 ⚠ ≈ 44% missing (email-in worker still entirely absent)

## Top 5 highest-priority gaps blocking production use (post-Session-DD)

1. **AI feature catalog (Phase 23 #10–#13, #15, #18, #19, #23–#27)** — Anomaly, pricing, write-down pattern, scope-creep AI, capacity forecasting, citations, reason-code suggestion. All UI panels (time-entry/pre-bill/reporting/pricing) are still absent. Most visible competitive gap vs. Canopy/Karbon AI features.
2. **Portal polish (Phase 16 #8 entity-switcher UI, #10 branding consumption, #22 alternate-contact, #23 notification prefs, #20 pay-to-unlock)** — Backend mostly there; React surface is the bottleneck for day-of-demo readiness.
3. **Pre-bill enrichment leftovers (Phase 11 #5, #6, #10, #12, #14, #18–#21, #23)** — Deferred-entry carry-forward worker, held vs. removed write-off, cost-transfer endpoint, comment thread UI, NTE/budget compare on batch, reopen→new-version flow.
4. **Distribution + ops polish (Phase 25 #3, #6–#9, #15)** — GHCR publish, Cloudflare Tunnel template, LAN/Tailscale guides, upgrade-path doc. Mostly docs+CI work but blocks third-party install confidence.
5. **Vibe Connect integration (Phase 24 #2–#7)** — All but interface still empty; once Connect ships routable events the wire-up should be one session.

Secondary blockers worth flagging: reporting UX polish (Phase 17 #20, #24–#28); admin polish (fee-structure toggles, branding-PDF wiring, backup/restore UI — Phase 20 #4, #13 consumption, #15); MCP transport upgrade (Phase 22 #1 still HTTP shim); audit retention enforcement extends only to ai_request_log + webhook_delivery (Phase 19 #11 ✅; #12 legal-hold + #13 SOC2 + #14 WISP still missing); demo seed enrichment + onboarding wizard (Phase 26 #7–#8).
