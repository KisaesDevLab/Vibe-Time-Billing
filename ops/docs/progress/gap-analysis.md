# Gap Analysis — BUILD_PLAN vs. Codebase

**Generated:** 2026-05-20
**Method:** Each of the 513 numbered items in `BUILD_PLAN.md` compared against the actual source tree.

Legend
- `✅` implemented (domain code + tests, or working endpoint, or working schema, as appropriate)
- `⚠` partial — typically domain logic exists in `@vibe/core` but no HTTP route, worker job, or UI consumer
- `❌` missing entirely

React UI items are uniformly `❌` (apps/web and apps/portal are header placeholders). Worker/BullMQ items are mostly `⚠` (worker boots but registers no queues).

---

## Phase 1 — Repo & infrastructure (15)

| # | S | Note |
|---|---|---|
| 1 | ✅ | pnpm workspaces at root, `apps/*` + `packages/*` configured |
| 2 | ✅ | `apps/web` Vite + React 18 + TS strict scaffold present |
| 3 | ✅ | `apps/portal` Vite + React 18 + TS strict scaffold present |
| 4 | ✅ | `apps/api` Express + tsx with server.ts, app.ts, routers |
| 5 | ⚠ | `apps/worker` boots but registers no BullMQ queues |
| 6 | ✅ | `packages/db` Drizzle schema + migrations + seed |
| 7 | ✅ | `packages/types` exports shared TS types |
| 8 | ⚠ | `packages/ui` exists with `tokens.ts` + single `Pill.tsx` only |
| 9 | ✅ | `Dockerfile` multi-stage at repo root |
| 10 | ✅ | `ops/docker/docker-compose.dev.yml` defined |
| 11 | ✅ | ESLint/Prettier/lint-staged/husky configured |
| 12 | ✅ | `LICENSE.md` (PolyForm), `README.md`, `CLAUDE.md`, `QUESTIONS.md` present |
| 13 | ✅ | `.github/workflows/ci.yml` runs lint/typecheck/test |
| 14 | ✅ | Three Caddyfile templates (`domain`, `lan`, `tailscale`) |
| 15 | ✅ | `.env.example` + `apps/api/src/config.ts` validates at startup |

Phase 1 essentially complete; only worker queues and UI component library remain skeletal.

---

## Phase 2 — Database schema & migrations (31)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `firm` table with settings JSON + `firm_settings` companion |
| 2 | ✅ | `office` table with timezone + isDefault |
| 3 | ✅ | `app_user` table with TOTP fields + status |
| 4 | ✅ | `portal_identity` with email+phone+verified-at + preferred method |
| 5 | ✅ | `client_portal_access` join with role + per-access notification prefs |
| 6 | ✅ | `role`, `role_permission`, `user_role` joins present |
| 7 | ✅ | `service_line` with category enum |
| 8 | ✅ | `work_code` with service_line linkage + key + description template |
| 9 | ✅ | `engagement_type` with default fee structure + template_data |
| 10 | ✅ | `reason_code` grouped by category enum |
| 11 | ✅ | `client` with partner_in_charge + consolidation preference + tags |
| 12 | ✅ | `engagement` with seven fee structures + budgets + mixed-mode flag |
| 13 | ✅ | `timekeeper_rate` with effective dates + cost rate |
| 14 | ✅ | `client_rate_override`, `engagement_rate_override`, `service_line_rate` |
| 15 | ✅ | `time_entry` with NOT NULL `standardRateSnapshotCents` + check constraint |
| 16 | ✅ | `time_entry_version` with version unique index |
| 17 | ✅ | `recurring_billing_plan` with next_run_date + autopay |
| 18 | ✅ | `recurring_billing_plan_service` |
| 19 | ✅ | `milestone_plan` + `milestone` with trigger types |
| 20 | ✅ | `hour_bank` + `hour_bank_transaction` ledger with running_balance |
| 21 | ✅ | `billing_batch` + `billing_batch_entry` with action enum |
| 22 | ✅ | `adjustment` with method + allocation_method + reason + status |
| 23 | ✅ | `adjustment_allocation` at (adj, entry, user) grain + sum trigger migration |
| 24 | ✅ | `invoice` + `invoice_line_item` with mixed-kind enum |
| 25 | ✅ | `payment` + `payment_method` (payment_method belongs to portal_identity) |
| 26 | ✅ | `portal_session` with `active_client_id` |
| 27 | ✅ | `portal_invitation` with delivery_channel + token_hash |
| 28 | ✅ | `portal_auth_challenge` (unified replaces `sms_otp`) — covers SMS OTP |
| 29 | ❌ | No materialized views: `ar_aging_snapshot`, `realization_view`, `utilization_view`, `profitability_view` missing |
| 30 | ⚠ | `approval_rule`, `approval_request`, `audit_log`, `webhook_endpoint`, `webhook_delivery`, `mcp_token`, `ai_request_log` all present in schema |
| 31 | ⚠ | FK indexes present; no partitioning declared for `audit_log` or `time_entry` |

Schema is the most complete area; missing only materialized views and partitioning.

---

## Phase 3 — Authentication & sessions (staff) (18)

| # | S | Note |
|---|---|---|
| 1 | ✅ | Magic link via JOSE-signed JWT, 15-min TTL in `staff-routes.ts` |
| 2 | ✅ | Redis session store with sliding expiration in `session-store.ts` |
| 3 | ⚠ | `requireAuth`, `requireRole` (via `requirePermission`) present; no separate `requireRole` middleware |
| 4 | ✅ | TOTP enroll generates otpauth URI + recovery codes |
| 5 | ✅ | `requireStepUp` via `lastStepUpAt` + step-up timeout check |
| 6 | ⚠ | Step-up tag mechanism exists; no sensitive endpoints yet require it (no adjustments/refund endpoints) |
| 7 | ✅ | `/logout` destroys session + clears cookie |
| 8 | ❌ | No WebAuthn enrollment |
| 9 | ⚠ | `POST /admin/users/invite` creates user record only — no email-out invite flow |
| 10 | ⚠ | No explicit email-verification step (magic-link receipt implies verification) |
| 11 | ✅ | Account lockout after 5 failed TOTP attempts (15-min lockout) |
| 12 | ✅ | Redis sliding-window rate limit in `rate-limit.ts` |
| 13 | ✅ | CSRF via SameSite cookie + double-submit token (`requireCsrf`) |
| 14 | ✅ | `emitAudit` called on LOGIN/LOGOUT/STEP_UP |
| 15 | ❌ | Login UI in apps/web not built |
| 16 | ❌ | TOTP enrollment UI not built |
| 17 | ❌ | Account settings UI not built |
| 18 | ❌ | No API key generation endpoints (mcp_token schema exists, no issuance route) |

Auth backend solid; staff UI and API-key issuance missing.

---

## Phase 4 — Firm, office & user administration (15)

| # | S | Note |
|---|---|---|
| 1 | ⚠ | `GET/PATCH /admin/firm-settings` endpoint exists; no UI |
| 2 | ⚠ | `GET/POST /admin/offices` endpoint exists; no UI, no edit/delete |
| 3 | ⚠ | `GET /admin/users` + `POST /admin/users/invite` endpoints; no UI |
| 4 | ❌ | No role assignment endpoint or UI |
| 5 | ✅ | Role templates defined in `@vibe/core/rbac/permissions.ts` |
| 6 | ✅ | Permission key catalog in `permissions.ts` |
| 7 | ❌ | No per-office override of firm settings |
| 8 | ⚠ | `standardHoursPerWeek` column on `app_user`; no consumer |
| 9 | ❌ | No holiday/PTO calendar tables or endpoints |
| 10 | ❌ | No time-off entry endpoint |
| 11 | ⚠ | `status` column supports active/inactive; no toggle endpoint |
| 12 | ❌ | No user detail page |
| 13 | ❌ | No bulk CSV user import |
| 14 | ❌ | No office partner-in-charge default field |
| 15 | ❌ | No multi-entity flag |

Backend partially scaffolded (settings, offices, users list/invite); everything else missing.

---

## Phase 5 — Taxonomy (12)

| # | S | Note |
|---|---|---|
| 1 | ⚠ | `GET/POST/PATCH archive /taxonomy/service-lines` endpoints; no UI |
| 2 | ⚠ | `GET/POST /taxonomy/work-codes` endpoints; no UI; no archive route |
| 3 | ⚠ | `GET/POST /taxonomy/engagement-types` endpoints; no UI |
| 4 | ⚠ | `GET/POST /taxonomy/reason-codes` endpoints; no UI |
| 5 | ⚠ | Seed script populates only 4 SLs/12 WCs/8 engagement types; not auto-seeded on firm creation via UI |
| 6 | ❌ | No bulk import endpoint |
| 7 | ⚠ | Service-line archive endpoint exists; reference-check on delete not enforced |
| 8 | ✅ | Category enums in `packages/types` |
| 9 | ✅ | `color`/`icon` columns on service_line |
| 10 | ❌ | No taxonomy export endpoint |
| 11 | ❌ | No taxonomy import endpoint |
| 12 | ✅ | `description_template` column on work_code |

Read/create endpoints present; export/import/bulk operations missing.

---

## Phase 6 — Client management (12)

| # | S | Note |
|---|---|---|
| 1 | ⚠ | `GET/POST/PATCH archive /clients` endpoints; no UI; no full update endpoint |
| 2 | ✅ | Billing contact columns present and writable via POST |
| 3 | ✅ | `partnerInChargeId` required in zod schema |
| 4 | ⚠ | `status` enum supports prospect/active/inactive; no transition endpoint |
| 5 | ⚠ | `customFields` JSONB column; no UI |
| 6 | ⚠ | `tags` array column; no UI |
| 7 | ❌ | No client detail page or aggregated engagement query |
| 8 | ❌ | No client merge tool |
| 9 | ⚠ | `notes` column; no audit-log emission wired |
| 10 | ❌ | No CSV bulk import |
| 11 | ⚠ | Search supports `?q=` ilike on name only; not across email/custom fields |
| 12 | ❌ | No portal access invite endpoint or UI (despite portal_invitation schema being ready) |

Basic CRUD endpoint only; portal invite flow is the biggest gap.

---

## Phase 7 — Rate management (20)

| # | S | Note |
|---|---|---|
| 1 | ⚠ | `timekeeper_rate` schema present; no CRUD endpoint |
| 2 | ⚠ | `client_rate_override` schema; no endpoint |
| 3 | ⚠ | `engagement_rate_override` schema; no endpoint |
| 4 | ⚠ | `service_line_rate` schema; no endpoint |
| 5 | ❌ | No firm-default rate by role |
| 6 | ✅ | `resolveRate` in `@vibe/core/rates/rate-resolution.ts` with hierarchy |
| 7 | ✅ | `captureRateSnapshot` invoked from time-entry POST |
| 8 | ❌ | No effective-dated history view endpoint |
| 9 | ❌ | No bulk rate-update preview tool |
| 10 | ❌ | No rate CSV import |
| 11 | ✅ | `costRateCents` on `timekeeper_rate` |
| 12 | ❌ | No loaded margin computation |
| 13 | ❌ | No premium/discount multiplier per engagement |
| 14 | ✅ | Verified via test: `rate-resolution.test.ts` checks historical-snapshot invariant |
| 15 | ❌ | No rate UI |
| 16 | ❌ | No rate history modal |
| 17 | ⚠ | Resolution returns `trace[]`; no debug panel UI |
| 18 | ❌ | Rate change endpoints don't exist, so no audit emission yet |
| 19 | ❌ | Rate write endpoint not built (would gate on admin perm) |
| 20 | ✅ | Reports would read `standard_rate_snapshot_cents` from `time_entry` (column exists) |

Resolution math complete; full CRUD surface absent.

---

## Phase 8 — Engagement & fee structure (28)

| # | S | Note |
|---|---|---|
| 1 | ⚠ | `POST /engagements` + `PATCH /engagements/:id/status`; no update endpoint, no UI |
| 2 | ✅ | All 5 fee structures accepted in zod enum |
| 3 | ✅ | `mixedModeEnabled` flag accepted |
| 4 | ✅ | `nteCapCents` + `nteCapScope` columns |
| 5 | ✅ | `feeAmountCents` column |
| 6 | ⚠ | `milestone_plan`/`milestone` schema; no editor endpoint |
| 7 | ⚠ | `recurring_billing_plan` schema; no creation endpoint |
| 8 | ⚠ | `hour_bank` schema; no creation endpoint |
| 9 | ✅ | `budgetHours`/`budgetAmountCents` columns + accepted in POST |
| 10 | ✅ | `engagementTypeId` linkage in POST |
| 11 | ✅ | `partnerId`/`managerId` in POST |
| 12 | ✅ | `scopeDefinition` text column |
| 13 | ✅ | Status enum + PATCH transitions endpoint |
| 14 | ⚠ | `autoRolloverEnabled` + `autoRolloverPriceIncreasePct` columns; no worker job |
| 15 | ❌ | No engagement detail UI |
| 16 | ❌ | No budget-vs-actual live computation |
| 17 | ❌ | No engagement letter attachment storage |
| 18 | ❌ | No clone endpoint |
| 19 | ⚠ | Status PATCH writes closedAt/reason; audit emission not wired |
| 20 | ❌ | No PAUSED behavior enforcement (still accepts time entries) |
| 21 | ❌ | CLOSED transition doesn't check WIP-resolved |
| 22 | ❌ | No auto-rollover worker job |
| 23 | ⚠ | GET supports listing; no search/filter endpoints beyond scoped-by-firm |
| 24 | ❌ | No list views by partner/SL/status |
| 25 | ❌ | No bulk operations |
| 26 | ⚠ | `customFields` column; no UI |
| 27 | ⚠ | Engagement template starter pack lives only as engagementTypes in seed + `seed/engagement-letters/*.md`; no proper template library |
| 28 | ❌ | No proposal-acceptance stub |

CRUD endpoint exists; complex lifecycle behavior unimplemented.

---

## Phase 9 — Time entry & capture (32)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `POST /time-entries` resolves rate + captures snapshot |
| 2 | ✅ | `PATCH /time-entries/:id` writes `time_entry_version` row |
| 3 | ❌ | No DELETE/soft-delete endpoint |
| 4 | ❌ | No timer endpoint or state |
| 5 | ❌ | No idle detection |
| 6 | ❌ | No timer recovery |
| 7 | ❌ | No day view |
| 8 | ❌ | No week view |
| 9 | ❌ | No month view |
| 10 | ❌ | No quick entry form UI |
| 11 | ❌ | No required-field rules engine |
| 12 | ✅ | `descriptionTemplate` column on work_code (read by future UI) |
| 13 | ✅ | `billableFlag` field on POST |
| 14 | ✅ | `inScopeFlag` computed at write time from engagement's `in_scope_work_code_ids` |
| 15 | ❌ | No late-entry alert worker job |
| 16 | ⚠ | `lateEntryLockoutDays` setting present; not enforced on POST |
| 17 | ❌ | No bulk-from-template endpoint |
| 18 | ⚠ | `lockedAt` column + PATCH refuses when locked; no batch-lock endpoint |
| 19 | ❌ | No transfer-between-engagements endpoint |
| 20 | ❌ | No per-day totals endpoint |
| 21 | ❌ | No per-week summary endpoint |
| 22 | ❌ | No approver field |
| 23 | ⚠ | `/time-entries/mine` exists; no admin all-entries endpoint |
| 24 | ❌ | No per-timekeeper export |
| 25 | ❌ | No voice entry |
| 26 | ❌ | No email-to-time-entry |
| 27 | ❌ | No workflow-task integration |
| 28 | ❌ | No mobile PWA shell |
| 29 | ❌ | No offline draft support |
| 30 | ❌ | No engagement filter UI |
| 31 | ❌ | No smart engagement suggestions |
| 32 | ❌ | No required-fields admin UI |

Backend create/update/list endpoints work; everything UI/timer/PWA-related missing.

---

## Phase 10 — Recurring billing engine (38)

| # | S | Note |
|---|---|---|
| 1 | ⚠ | Plan schema exists; no creation endpoint |
| 2 | ⚠ | Plan schema; no scheduler |
| 3 | ⚠ | `nextRunDate()` function in `@vibe/core/billing/recurring.ts`; no BullMQ job |
| 4 | ❌ | No subscription invoice generation worker |
| 5 | ❌ | No time-based recurring WIP rollup worker |
| 6 | ❌ | No milestone trigger evaluator |
| 7 | ❌ | No date-trigger worker |
| 8 | ❌ | No event-trigger handler |
| 9 | ❌ | No manual trigger endpoint |
| 10 | ❌ | No mixed-mode invoice composer |
| 11 | ❌ | No overage roll-up |
| 12 | ⚠ | hour_bank schema present; no opening-balance endpoint |
| 13 | ❌ | No debit-on-time-entry trigger |
| 14 | ❌ | No balance/runway query |
| 15 | ❌ | No auto-replenish |
| 16 | ❌ | No top-up endpoint |
| 17 | ❌ | No expiration enforcement worker |
| 18 | ❌ | No rollover cap enforcement |
| 19 | ❌ | No NTE cap check |
| 20 | ❌ | No NTE auto-suggest |
| 21 | ⚠ | `prorate()` function exists; not wired |
| 22 | ❌ | No plan-change proration flow |
| 23 | ⚠ | `applyAnnualPrepayDiscount()` exists; not wired |
| 24 | ❌ | No pause/resume endpoint |
| 25 | ⚠ | `autoPayFlag` column; no autopay execution |
| 26 | ❌ | No Stripe payment intent integration |
| 27 | ❌ | No CPACharge integration |
| 28 | ⚠ | `nextRetryDate()` function exists; not wired |
| 29 | ❌ | No dunning email sequence |
| 30 | ❌ | No auto-pause after N failures |
| 31 | ❌ | No auto-resume |
| 32 | ❌ | No partner notification |
| 33 | ❌ | No plan-health view |
| 34 | ❌ | No worker monitoring |
| 35 | ❌ | No idempotency keys |
| 36 | ❌ | No plan list UI |
| 37 | ❌ | No plan detail UI |
| 38 | ❌ | No plan audit log emission |

Pure-function building blocks exist; orchestration entirely missing.

---

## Phase 11 — Pre-bill & WIP management (25)

| # | S | Note |
|---|---|---|
| 1 | ⚠ | `billing_batch` schema; no creation endpoint |
| 2 | ❌ | No worker that pulls entries by period |
| 3 | ❌ | No pre-bill review UI |
| 4 | ⚠ | `applyEntryAction()` in `@vibe/core/billing/wip.ts`; not wired to endpoint |
| 5 | ❌ | No WIP carry-forward worker |
| 6 | ❌ | No held vs. removed write-off variants |
| 7 | ⚠ | `bucketize()` function exists; no materialized view |
| 8 | ❌ | No pre-bill PDF generation |
| 9 | ❌ | No emailable pre-bill |
| 10 | ❌ | No partner assignment |
| 11 | ❌ | No bulk pre-bill worker |
| 12 | ❌ | No cost transfer endpoint |
| 13 | ⚠ | Batch status enum supports lifecycle; no transition endpoint |
| 14 | ❌ | No per-entry comments |
| 15 | ❌ | No approval-flow integration |
| 16 | ❌ | No WIP totals endpoint |
| 17 | ❌ | No fixed-fee gap calc |
| 18 | ❌ | No NTE cap check on batch |
| 19 | ❌ | No subscription in-scope/overage split |
| 20 | ❌ | No budget compare |
| 21 | ❌ | No recompute on entry change |
| 22 | ❌ | No freeze-on-approve |
| 23 | ❌ | No batch versioning |
| 24 | ❌ | No WIP age alert worker |
| 25 | ❌ | No WIP dashboard |

Aging helper exists; rest entirely missing.

---

## Phase 12 — Adjustments & allocation (32)

| # | S | Note |
|---|---|---|
| 1 | ⚠ | `adjustment` schema; no API endpoint to create |
| 2 | ✅ | Method enum (RATE/TIME/FEE) on schema |
| 3 | ✅ | Allocation method enum (6 values) on schema |
| 4 | ✅ | `allocateSpecificEntries()` in core, tested |
| 5 | ✅ | `allocateProRataByValue()` in core, tested |
| 6 | ✅ | `allocateProRataByHours()` in core, tested |
| 7 | ✅ | `allocatePartnerAbsorbs()` in core, tested |
| 8 | ✅ | `allocateHierarchicalCascade()` in core, tested (passes Vance scenario per test) |
| 9 | ✅ | `allocateCustomWeighted()` in core, tested |
| 10 | ✅ | `adjustment_allocation` row generation at correct grain |
| 11 | ✅ | Symmetric write-up math handled in `proRata` sign preservation |
| 12 | ✅ | `reasonCodeId` NOT NULL on adjustment schema |
| 13 | ✅ | `notes` text column on adjustment |
| 14 | ❌ | No impact preview endpoint |
| 15 | ⚠ | `evaluate()` in approvals can gate on threshold; not wired to adjustment write |
| 16 | ❌ | No routing to approval workflow |
| 17 | ⚠ | `status` enum supports approval lifecycle; no transition endpoint |
| 18 | ❌ | No audit emission on adjustment transitions |
| 19 | ❌ | No credit memo generation |
| 20 | ⚠ | `reversedById`/`reversedAt` columns; no reverse endpoint |
| 21 | ❌ | No bulk adjustment endpoint |
| 22 | ❌ | No NTE auto-suggest |
| 23 | ❌ | No fixed-fee gap auto-suggest |
| 24 | ❌ | No adjustment dialog UI |
| 25 | ❌ | No adjustment list view |
| 26 | ❌ | No adjustment search |
| 27 | ❌ | No per-timekeeper allocation table UI |
| 28 | ✅ | Sum constraint enforced via deferred trigger (`0002_adjustment_sum_trigger.sql`) |
| 29 | ❌ | No step-up gate on adjustment endpoint (none exists) |
| 30 | ❌ | No cascading adjustment handling |
| 31 | ❌ | No export |
| 32 | ❌ | No metrics endpoint |

Allocation math (the wedge) is fully implemented and tested; HTTP/UI surface, approval wiring, and reverse/credit-memo flows all missing.

---

## Phase 13 — Invoicing (25)

| # | S | Note |
|---|---|---|
| 1 | ❌ | No endpoint to convert pre-bill → invoice |
| 2 | ❌ | No recurring → invoice generation |
| 3 | ❌ | No milestone → invoice |
| 4 | ✅ | Line-item kind enum + `LineItem` type in `@vibe/core/invoicing` |
| 5 | ❌ | No manual composer endpoint |
| 6 | ❌ | No template system |
| 7 | ✅ | `formatInvoiceNumber()` numbering function |
| 8 | ⚠ | Consolidation preference on client; no consolidated-invoice composer |
| 9 | ❌ | No detail-level options |
| 10 | ❌ | No preview UI |
| 11 | ❌ | No Puppeteer PDF generator |
| 12 | ❌ | No email delivery wired |
| 13 | ⚠ | `firstViewedAt` column; no portal-view trigger (Q30 — pixel banned) |
| 14 | ❌ | No resend endpoint |
| 15 | ⚠ | `computeLateFee()` in core; no accrual worker |
| 16 | ❌ | No expense pass-through |
| 17 | ⚠ | Unique index on (firm_id, invoice_number); no atomic sequence generator |
| 18 | ⚠ | `voidedAt`/`voidedReason` columns; no void endpoint |
| 19 | ❌ | No partial credit |
| 20 | ❌ | No list/sort/filter UI |
| 21 | ❌ | No detail page |
| 22 | ❌ | No invoice search |
| 23 | ❌ | No e-sign integration |
| 24 | ⚠ | `payToUnlockAttachments` flag; no unlock signal |
| 25 | ❌ | No audit emission on invoice mutations |

Numbering + line-item composition primitives only; no orchestration.

---

## Phase 14 — Payment processing (24)

| # | S | Note |
|---|---|---|
| 1 | ⚠ | `PaymentProvider` interface defined; no Stripe impl |
| 2 | ⚠ | Interface supports CPACharge; no impl |
| 3 | ✅ | `paymentMethodKind` enum supports ACH |
| 4 | ✅ | Same enum supports CARD |
| 5 | ✅ | `payment_method` keyed on `portal_identity_id` |
| 6 | ✅ | Schema stores only `provider_token` + `last_four` (no PAN) |
| 7 | ❌ | No auto-apply logic |
| 8 | ❌ | No manual-apply endpoint |
| 9 | ⚠ | `paidCents` column on invoice; no partial tracker |
| 10 | ❌ | No multiple-payments-per-invoice flow |
| 11 | ⚠ | `refundedAt`/`refundedAmountCents` columns; no refund endpoint |
| 12 | ❌ | No credit memo |
| 13 | ⚠ | `pay_to_unlock_attachments` flag; no backend lock |
| 14 | ❌ | No webhook-driven unlock signal |
| 15 | ❌ | No payment confirmation email |
| 16 | ❌ | No payment receipt PDF |
| 17 | ❌ | No firm notification |
| 18 | ❌ | No Stripe webhook handler |
| 19 | ❌ | No CPACharge webhook handler |
| 20 | ❌ | No failed-payment routing |
| 21 | ✅ | Provider interface in core |
| 22 | ❌ | No payment-mutation audit emission |
| 23 | ❌ | No reconciliation report |
| 24 | ❌ | No portal-consumable payment endpoint |

Schema + interface stub; zero provider implementation.

---

## Phase 15 — AR aging & dunning (15)

| # | S | Note |
|---|---|---|
| 1 | ❌ | No AR aging worker |
| 2 | ✅ | `bucketForAge()`/`bucketize()` in core |
| 3 | ❌ | No AR report endpoint |
| 4 | ❌ | No statement generation |
| 5 | ❌ | No statement email/SMS |
| 6 | ✅ | `DEFAULT_DUNNING_SCHEDULE` + `stepsDueOn()` in core |
| 7 | ❌ | No template renderer |
| 8 | ❌ | No auto-send worker |
| 9 | ❌ | No manual trigger endpoint |
| 10 | ❌ | No dunning history table or endpoint |
| 11 | ❌ | No escalation logic |
| 12 | ❌ | No auto-pause on chronic failure |
| 13 | ❌ | No AR filters |
| 14 | ❌ | No AR export |
| 15 | ❌ | No DSO/collection metrics |

Aging + dunning-step pure functions only.

---

## Phase 16 — Client portal (28)

| # | S | Note |
|---|---|---|
| 1 | ⚠ | `apps/portal` scaffold present (header placeholder) |
| 2 | ✅ | `detectLoginKind()` + `normalizePhone()` in `@vibe/core/auth` |
| 3 | ✅ | Magic-link path in `portal-routes.ts` with distinct `PORTAL_JWT_SECRET` |
| 4 | ✅ | SMS OTP path with 6-digit code, 5-min TTL |
| 5 | ⚠ | Phone verified at OTP success (Q6 first-use); no new-device re-verify |
| 6 | ✅ | `portalAuthDeps` + `requireAuth` middleware in `portal-middleware.ts` |
| 7 | ❌ | No firm-side invite endpoint (Phase 6 #12) |
| 8 | ⚠ | `/switch-client` endpoint exists; no UI |
| 9 | ✅ | Multi-identity-per-client supported by schema |
| 10 | ❌ | No portal layout/branding |
| 11 | ❌ | No invoice list endpoint scoped to `active_client_id` |
| 12 | ❌ | No paid invoices history endpoint |
| 13 | ❌ | No invoice detail endpoint |
| 14 | ❌ | No PDF download endpoint |
| 15 | ❌ | No payment flow |
| 16 | ❌ | No saved payment methods endpoint |
| 17 | ❌ | No auto-pay enrollment endpoint |
| 18 | ❌ | No statement view |
| 19 | ❌ | No receipt download |
| 20 | ❌ | No pay-to-unlock endpoint |
| 21 | ❌ | No profile management endpoint |
| 22 | ❌ | No alternate-contact OTP verify |
| 23 | ⚠ | `notification_preferences` JSONB; no update endpoint |
| 24 | ❌ | No email notification dispatcher |
| 25 | ❌ | No SMS notification dispatcher |
| 26 | ✅ | Audit emission with `actor_portal_identity_id` + `active_client_id` in portal routes |
| 27 | ⚠ | `portalEnabled` setting; no boot-time license gate enforcement |
| 28 | ✅ | Subdomain-aware Caddy templates; no path-based routing config |

Auth realm fully isolated and tested (cross-realm-isolation.test.ts); portal data surface absent.

---

## Phase 17 — Reporting & analytics cube (32)

| # | S | Note |
|---|---|---|
| 1 | ❌ | No `realization_view` materialized view |
| 2 | ❌ | No `utilization_view` |
| 3 | ❌ | No `profitability_view` |
| 4 | ❌ | No view-refresh worker |
| 5 | ❌ | No realization report UI |
| 6 | ⚠ | `rollup()`/`rollupBy()` in core; no endpoint |
| 7 | ❌ | No collection realization metric |
| 8 | ❌ | No effective-rate metric |
| 9 | ❌ | No utilization metric |
| 10 | ❌ | No profitability metric |
| 11 | ❌ | No WIP aging report endpoint |
| 12 | ❌ | No AR aging report endpoint |
| 13 | ❌ | No budget-vs-actual |
| 14 | ❌ | No period comparison |
| 15 | ❌ | No MRR/ARR dashboard |
| 16 | ❌ | No scope creep tracking |
| 17 | ❌ | No subscription profitability |
| 18 | ❌ | No partner book-of-business |
| 19 | ❌ | No CLV |
| 20 | ❌ | No drill-through |
| 21 | ❌ | No saved reports |
| 22 | ❌ | No scheduled email worker |
| 23 | ❌ | No Excel/CSV export |
| 24 | ❌ | No URL filter persistence |
| 25 | ❌ | No sparklines |
| 26 | ❌ | No anomaly highlight |
| 27 | ❌ | No comparison overlays |
| 28 | ❌ | No date-range presets |
| 29 | ❌ | No report permissions |
| 30 | ❌ | No AI narrative |
| 31 | ❌ | No sub-second perf (no views) |
| 32 | ❌ | No background rebuild |

Realization rollup pure function only.

---

## Phase 18 — Approval workflows (20)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `evaluate()` declarative rule engine in `@vibe/core/approvals` |
| 2 | ⚠ | `approval_request` schema; no creation endpoint |
| 3 | ❌ | No queue UI |
| 4 | ❌ | No approve/reject endpoints |
| 5 | ❌ | No multi-step routing |
| 6 | ❌ | No delegation rules |
| 7 | ✅ | Threshold rules in core (cents + pct + reason + exempt roles) |
| 8 | ❌ | No email notification |
| 9 | ❌ | No Slack/Teams |
| 10 | ❌ | No approval audit emission |
| 11 | ⚠ | `approverResolver: 'partner_in_charge'` supported in core |
| 12 | ❌ | No pending-approvals dashboard endpoint |
| 13 | ⚠ | `slaHours` column on `approval_rule`; no tracking worker |
| 14 | ⚠ | `autoEscalateHours` column; no escalation worker |
| 15 | ❌ | No modification log |
| 16 | ❌ | No rule-testing endpoint |
| 17 | ❌ | No requester-visible comments |
| 18 | ❌ | No admin reassignment |
| 19 | ❌ | No export |
| 20 | ❌ | No metrics |

Rule engine done; no HTTP surface or workflow lifecycle.

---

## Phase 19 — Audit trail & compliance (15)

| # | S | Note |
|---|---|---|
| 1 | ⚠ | `emitAudit()` helper exists; only auth events emit; most mutations don't |
| 2 | ✅ | `0001_audit_log_immutability.sql` REVOKEs UPDATE/DELETE on app role |
| 3 | ✅ | `time_entry_version` table + PATCH endpoint writes versions |
| 4 | ❌ | Adjustment mutations don't emit (no adjustment endpoints exist) |
| 5 | ❌ | No invoice change log emissions |
| 6 | ⚠ | LOGIN/LOGOUT/STEP_UP emitted; settings changes/exports don't |
| 7 | ⚠ | `GET /audit` endpoint exists with filters |
| 8 | ✅ | Filter by actor/entity/dates in audit router |
| 9 | ❌ | No full-text search |
| 10 | ❌ | No export endpoint |
| 11 | ❌ | No retention policy enforcement |
| 12 | ❌ | No legal-hold flag |
| 13 | ❌ | No SOC 2 evidence reports |
| 14 | ❌ | No WISP template generator |
| 15 | ❌ | No anomaly alerting |

Append-only enforced + viewer exists; emission coverage is the gap.

---

## Phase 20 — Administration UI (15)

| # | S | Note |
|---|---|---|
| 1 | ⚠ | `/admin/firm-settings` GET+PATCH exists; no UI |
| 2 | ❌ | No approval rules CRUD endpoint or UI |
| 3 | ⚠ | Reason-codes CRUD endpoint; no UI |
| 4 | ❌ | No fee-structure toggles |
| 5 | ⚠ | `defaultAllocationMethod` on firm; no admin endpoint |
| 6 | ⚠ | `fiscalYearStartMonth` on firm; no admin endpoint |
| 7 | ⚠ | `standardHoursPerWeek` on app_user; no per-role admin |
| 8 | ❌ | No billable-hour targets |
| 9 | ❌ | No holiday calendar |
| 10 | ❌ | No office overrides UI |
| 11 | ❌ | No permission matrix admin |
| 12 | ❌ | No template customization endpoint (`ops/docs/template-variables.md` documents schema only) |
| 13 | ❌ | No branding endpoint |
| 14 | ⚠ | `portalEnabled`/`portalSubdomain` columns; no admin endpoint |
| 15 | ❌ | No backup/restore controls (scripts exist but no UI/endpoint) |

Most admin items are schema-ready, endpoint-absent.

---

## Phase 21 — Integrations (16)

| # | S | Note |
|---|---|---|
| 1 | ❌ | No email-in worker |
| 2 | ❌ | No routing logic |
| 3 | ❌ | No AI assist (phase-23 dependency missing too) |
| 4 | ⚠ | `webhook_endpoint` schema; no CRUD endpoint |
| 5 | ✅ | `signPayload()` + `verifySignature()` HMAC in `@vibe/core/webhooks` |
| 6 | ❌ | No retry queue |
| 7 | ⚠ | `webhook_delivery` schema; no list endpoint |
| 8 | ❌ | No secret rotation endpoint |
| 9 | ❌ | No catalog enforcement on endpoint creation |
| 10 | ❌ | No REST API with key auth |
| 11 | ❌ | No public REST endpoints |
| 12 | ❌ | No rate limiting on API keys |
| 13 | ❌ | No API key UI |
| 14 | ❌ | No bulk export |
| 15 | ❌ | No bulk import |
| 16 | ❌ | No integration audit emission |

Only HMAC signing primitive implemented.

---

## Phase 22 — MCP server (12)

| # | S | Note |
|---|---|---|
| 1 | ❌ | No MCP server transport (no SDK wiring) |
| 2 | ✅ | `MCP_TOOL_KEYS` catalog includes `list_engagements` |
| 3 | ✅ | Catalog includes `get_time_entries` |
| 4 | ✅ | Catalog includes `create_time_entry` |
| 5 | ✅ | Catalog includes `generate_pre_bill` |
| 6 | ✅ | Catalog includes `suggest_adjustment` |
| 7 | ✅ | Catalog includes `query_realization` |
| 8 | ✅ | Catalog includes `query_recurring_plans` |
| 9 | ⚠ | `mcp_token` schema with `token_hash`; no issuance endpoint |
| 10 | ✅ | `isToolAllowed()` claims check in core |
| 11 | ❌ | No MCP audit emission (`actor_mcp_token_id` column ready) |
| 12 | ❌ | No MCP server config UI |

Token-claims math + catalog ready; transport and tool implementations absent.

---

## Phase 23 — AI features (28)

| # | S | Note |
|---|---|---|
| 1 | ✅ | `AiProvider` interface in `@vibe/core/ai/provider.ts` |
| 2 | ❌ | No Anthropic provider impl |
| 3 | ❌ | No Ollama provider impl |
| 4 | ❌ | No OpenAI-compatible impl |
| 5 | ❌ | No routing logic |
| 6 | ⚠ | `aiProvider` enum + `ai_request_log`; no per-firm config endpoint |
| 7 | ❌ | No per-feature toggle |
| 8 | ⚠ | `ai_request_log` schema present; not written |
| 9 | ❌ | No description suggestion |
| 10 | ❌ | No anomaly detection |
| 11 | ❌ | No pricing suggestion |
| 12 | ❌ | No write-down pattern analysis |
| 13 | ❌ | No scope creep detection |
| 14 | ❌ | No realization narrative |
| 15 | ❌ | No capacity forecasting |
| 16 | ❌ | No plain-English query |
| 17 | ❌ | No NL → filter translation |
| 18 | ❌ | No citation rendering |
| 19 | ❌ | No reason-code suggestion |
| 20 | ✅ | `checkBudget()` in core (warn/exhausted states) |
| 21 | ❌ | No cost dashboard endpoint |
| 22 | ❌ | No Whisper integration |
| 23 | ❌ | No AI panel components |
| 24 | ❌ | No time-entry AI panel |
| 25 | ❌ | No pre-bill AI panel |
| 26 | ❌ | No reporting AI panel |
| 27 | ❌ | No admin AI panel |
| 28 | ❌ | No opt-in toggle |

Provider interface + budget check only.

---

## Phase 24 — Vibe Connect integration (8)

| # | S | Note |
|---|---|---|
| 1 | ⚠ | `ConnectClient` interface + `noopConnectClient` |
| 2 | ❌ | No config UI |
| 3 | ❌ | No invoice-sent routing |
| 4 | ❌ | No payment-received routing |
| 5 | ❌ | No payment-failed routing |
| 6 | ❌ | No e-sign request |
| 7 | ❌ | No signed → engagement transition |
| 8 | ⚠ | `health()` in interface; no actual client/degraded-mode wiring |

Interface stub only.

---

## Phase 25 — Distribution & deployment (15)

| # | S | Note |
|---|---|---|
| 1 | ✅ | Multi-stage `Dockerfile` at root |
| 2 | ❌ | No multi-arch build config in CI |
| 3 | ❌ | No GHCR publish workflow |
| 4 | ❌ | No semver tagging |
| 5 | ✅ | Three Caddy templates for staff+portal two-host routing |
| 6 | ❌ | No Cloudflare Tunnel template |
| 7 | ❌ | No LAN deployment guide |
| 8 | ❌ | No Tailscale-only guide |
| 9 | ❌ | No vibe-installer integration |
| 10 | ⚠ | `entrypoint-api.sh` exists; migration-on-start status unclear |
| 11 | ⚠ | `/health` exists on api; no separate worker/portal/staff health endpoints |
| 12 | ✅ | `ops/scripts/backup.sh` |
| 13 | ✅ | `ops/scripts/restore.sh` + `ops/docs/restore.md` |
| 14 | ⚠ | pino structured logging; no Prometheus endpoint |
| 15 | ❌ | No upgrade-path doc with portal session invalidation |

Docker + Caddy + backup scripts present; release/distribution automation absent.

---

## Phase 26 — Polish, demo data, launch readiness (14)

| # | S | Note |
|---|---|---|
| 1 | ❌ | No Lighthouse audit (no UI to audit) |
| 2 | ❌ | No bundle optimization |
| 3 | ❌ | No query optimization analysis |
| 4 | ❌ | No accessibility audit |
| 5 | ❌ | No keyboard nav |
| 6 | ❌ | No screen reader testing |
| 7 | ⚠ | Seed script is minimal demo (1 firm/7 users/5 clients/3 identities); not rich multi-month |
| 8 | ❌ | No onboarding wizard |
| 9 | ❌ | No user documentation site |
| 10 | ❌ | No client FAQ |
| 11 | ❌ | No video walkthroughs |
| 12 | ❌ | No migration guide |
| 13 | ❌ | No pricing page |
| 14 | ❌ | No beta playbook |

Largely untouched.

---

## Totals

- **✅ implemented:** ~115
- **⚠ partial:** ~127
- **❌ missing:** ~271
- **Total:** 513

(Approximate; "partial" is a judgment call when schema exists but no endpoint/UI consumes it.)

## Top 5 phases by missing-item count

1. **Phase 17 — Reporting (32 items, ~31 missing)** — no materialized views, no report endpoints
2. **Phase 10 — Recurring billing (38 items, ~30 missing)** — pure-function bricks only; no orchestration
3. **Phase 9 — Time entry (32 items, ~24 missing)** — backend create/update work; UI/timer/PWA absent
4. **Phase 16 — Client portal (28 items, ~23 missing)** — auth realm done; data surface absent
5. **Phase 23 — AI features (28 items, ~25 missing)** — provider interface only

## Top 5 highest-priority gaps that block production use

1. **No invoice → PDF → email pipeline** (Phase 13 #11-12, #25). The product cannot bill clients end-to-end. Puppeteer dep not added; no template directory under `apps/api/src/pdf-templates/`; no email dispatcher wired into invoice flow.
2. **No Stripe/CPACharge implementation** (Phase 14 #1-2, #18-19). The interface in `@vibe/core/payments` exists but neither provider is implemented; no webhook handlers; auto-pay (Phase 10 #25-26) cannot execute.
3. **No materialized views or report endpoints** (Phase 17 #1-4, plus Phase 2 #29). Realization, utilization, profitability all undelivered — these are the differentiator. The `rollup()` pure function exists in `@vibe/core/reporting` but no SQL views and no HTTP surface.
4. **No BullMQ queues registered** (Phase 10 worker entry is a no-op `await new Promise(() => {})`). Recurring billing, AR aging snapshots, view refreshes, dunning sequences, late-entry alerts, auto-rollover — none run. Phase 10/11/15/17/18 workflows all depend on this.
5. **No staff UI and no portal UI** (Phases 3 #15-17, 4 #1-3, 6 #1-12, 9 #4-9, 11-13, 16 #10-25, etc.). Both `apps/web` and `apps/portal` are 30-line headers. Even with the backend complete, the product is unusable without a UI; for the portal specifically the firm-side invite endpoint (Phase 6 #12) is also missing so clients cannot be onboarded.

Secondary blockers worth flagging: no adjustment HTTP surface (Phase 12 — the wedge math is done but nothing calls it), no pre-bill review pipeline (Phase 11), no audit emission on most mutations (Phase 19 #1 only covers auth events).
