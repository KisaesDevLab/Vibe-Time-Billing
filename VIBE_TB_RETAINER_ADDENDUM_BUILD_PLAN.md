# Vibe Time & Billing — Prepaid Retainer Module

## Addendum Build Plan

**Status:** Draft v1.0
**Parent module:** Vibe Time & Billing (existing)
**License:** PolyForm Small Business License 1.0.0 (matches Vibe family)
**Env prefix:** `VIBETB_` (existing T&B prefix)
**DB schema:** `vibetb` (existing T&B schema)
**Stack:** React 18 / TypeScript / Node.js 20 / Express / Drizzle ORM / PostgreSQL 16 / Redis 7 / BullMQ / pnpm workspaces / Vitest / Playwright / distroless Docker / GHCR

---

## §0.1 Fallback hierarchy (self-contained)

When the executing agent encounters ambiguity, resolve in this order:

1. **Explicit decision in this addendum** (see §0.2 Locked Decisions)
2. **Vibe T&B module conventions** (existing schemas, env vars, error formats)
3. **Vibe family conventions** (monetary as BIGINT cents, time as `numeric(8,2)` decimal hours, UUIDs everywhere, ISO 8601 timestamps with timezone, canonical error format)
4. **Stack defaults** (Drizzle, React 18, etc.)
5. **STOP and write to QUESTIONS.md** — never invent a business rule

## §0.2 Locked Decisions

| #   | Decision                          | Value                                                                                 |
| --- | --------------------------------- | ------------------------------------------------------------------------------------- |
| D1  | Hours overflow behavior           | Auto-split: fill retainer, spill to billable WIP                                      |
| D2  | Multiple retainers per engagement | No — one retainer per engagement (DB-enforced)                                        |
| D3  | Expiry date                       | `COALESCE(extended_due_date, original_due_date) + 3 years`                            |
| D4  | Unused hours at expiry            | Forfeit (no refund, no rollover)                                                      |
| D5  | Revenue recognition               | Cash basis — recognize at purchase                                                    |
| D6  | Eligibility scope                 | Service-code based, snapshotted at retainer creation                                  |
| D7  | Dashboards                        | Two views: Partner and Staff                                                          |
| D8  | Tier model                        | Two tiers (TIER_1 / TIER_2), per return type                                          |
| D9  | Tier differentiation              | Both hours AND scope differ                                                           |
| D10 | Price formula                     | `base_fee + (pct_of_prep_fee × prep_fee_basis)`                                       |
| D11 | Prep fee basis                    | Sum of invoice line items whose service code is in firm's `prep_fee_service_code_ids` |
| D12 | Retainer initiation               | Auto-create on tax-return invoice + 60-day portal window                              |
| D13 | Biller toggle default             | ON (must uncheck to skip)                                                             |
| D14 | Tier config scope                 | Per return type, firm-wide (1040, 1120, 1120S, 1065, 1041, 990)                       |
| D15 | Portal payment                    | Generate invoice → existing Vibe T&B AR flow                                          |
| D16 | Portal tier display               | Tier 1 default + Tier 2 upgrade card                                                  |
| D17 | Portal notifications              | Firm-configurable: on-bill, day-30, day-55                                            |
| D18 | Offer overrides                   | Flow to both offer AND eventual retainer                                              |
| D19 | Tier upgrade after purchase       | Not in v1                                                                             |
| D20 | Offer expiry trigger              | `invoice_date + offer_window_days` (not paid date)                                    |
| D21 | No prep-fee basis                 | Suppress offer (don't create row)                                                     |
| D22 | Eligible entries on expiry_date   | Eligible (entry_date `<=` expiry_date)                                                |
| D23 | Retroactive extension UI          | No — extended_due_date frozen at retainer creation                                    |
| D24 | Retainer void                     | Allowed only when `hours_consumed = 0`                                                |

---

# Phase 1 — Schema migration & seed data

- [ ] Create migration `NNNN_retainer_addendum.ts` under `db/migrations/`
- [ ] Define `retainer_tier` enum (`TIER_1`, `TIER_2`)
- [ ] Define `retainer_status` enum (`active`, `exhausted`, `expired`, `void`)
- [ ] Define `return_type` enum (`1040`, `1065`, `1120`, `1120S`, `1041`, `990`)
- [ ] Define `retainer_offer_status` enum (`pending`, `pending_payment`, `purchased`, `declined`, `expired`)
- [ ] Create table `retainer_tier_configs` with unique index on `(firm_id, return_type, tier)`
- [ ] Create table `retainer_tier_eligible_services` (composite PK)
- [ ] Create table `firm_retainer_settings` (firm_id PK)
- [ ] Create table `retainer_offers` with FK to invoices, engagements, clients
- [ ] Create table `retainers` with unique index on `engagement_id` (enforces D2)
- [ ] Create table `retainer_eligible_services` (composite PK, immutable snapshot)
- [ ] Create table `retainer_ledger` (immutable consumption log)
- [ ] Add columns to `time_entries`: `retainer_id`, `retainer_hours numeric(8,2)`, `billable_hours numeric(8,2)`
- [ ] Add column to `engagements`: `retainer_id uuid REFERENCES retainers(id)` (nullable)
- [ ] Add column to `engagements`: `return_type return_type` (nullable)
- [ ] Add columns to `engagements`: `tax_year integer`, `original_due_date date`, `extended_due_date date` (if not already present)
- [ ] Add CHECK constraint on `retainers`: `hours_consumed >= 0 AND hours_consumed <= hours_purchased`
- [ ] Add CHECK constraint on `retainer_tier_configs`: `pct_of_prep_fee >= 0 AND pct_of_prep_fee <= 1`
- [ ] Add CHECK constraint on `retainer_offers`: `tier_1_price_cents >= 0 AND tier_2_price_cents >= 0`
- [ ] Create index `retainers(status, expiry_date)` for the nightly sweep
- [ ] Create index `retainer_offers(status, offer_expires_at)` for the nightly sweep
- [ ] Create index `retainers(client_id, status)` for client portal lookups
- [ ] Create index `retainer_ledger(retainer_id, created_at)` for ledger display
- [ ] Write Drizzle schema definitions in `db/schema/retainers.ts`
- [ ] Add new tables to schema barrel export `db/schema/index.ts`
- [ ] Generate Drizzle types and run `pnpm db:generate`
- [ ] Run migration locally against test database
- [ ] Write rollback migration verifying clean reversal
- [ ] Seed: create dummy `retainer_tier_configs` for each return type in dev fixtures
- [ ] Verify FK ON DELETE behavior: tier_configs CASCADE to eligibility; retainers RESTRICT against time_entries
- [ ] Add audit triggers (existing Vibe pattern) to `retainers`, `retainer_offers`, `retainer_tier_configs`

# Phase 2 — Tier configuration UI

- [ ] Route: `GET /admin/settings/retainer-tiers` (partner role required)
- [ ] React page `RetainerTierSettingsPage.tsx`
- [ ] Return-type tab switcher (1040, 1065, 1120, 1120S, 1041, 990)
- [ ] Side-by-side TIER_1 / TIER_2 editor cards
- [ ] Fields per tier: name, hours, base_fee_cents, pct_of_prep_fee, is_active, eligible service code multi-select
- [ ] Live pricing example panel (use sample basis `$1,500` to show formula result)
- [ ] Firm-level settings section: offer_window_days, notification toggles, prep_fee_service_code_ids
- [ ] Default biller toggle setting (`default_biller_toggle_on`)
- [ ] Validation: hours > 0, base_fee >= 0, pct between 0 and 1, at least one eligible service per tier
- [ ] Mutation: `PUT /api/admin/retainer-tier-configs/:returnType` upserting both tiers
- [ ] Mutation: `PUT /api/admin/firm-retainer-settings` for firm-level settings
- [ ] Optimistic UI with rollback on error
- [ ] Audit log entry on every tier config change (existing Vibe audit pattern)
- [ ] Vitest unit tests for tier config validation
- [ ] Playwright E2E: edit Tier 1 hours, save, reload, verify persistence

# Phase 3 — Offer creation hook (invoice flow integration)

- [ ] Service module `services/retainerOffers.ts`
- [ ] Function `computePrepFeeBasis(invoice, firmSettings)` returning bigint cents
- [ ] Function `computeTierPrice(baseFee, pct, basis)` with rounding (round half to even on cents)
- [ ] Function `maybeCreateRetainerOffer(trx, invoice, toggleOn, overrides?)`
- [ ] Suppress logic: return `null` if `basisCents === 0n` (D21)
- [ ] Suppress logic: return `null` if engagement has no `return_type`
- [ ] Suppress logic: return `null` if no active tier configs for return type
- [ ] Suppress logic: return `null` if engagement already has a retainer (D2)
- [ ] Snapshot tier prices into offer row (frozen at creation)
- [ ] Snapshot override values when provided
- [ ] Compute `offer_expires_at = invoice.invoice_date + firm.offer_window_days` (D20)
- [ ] Hook into invoice creation: extend `createInvoice` controller to accept `retainerOptions` body
- [ ] `retainerOptions`: `{ enabled: boolean, overrides?: { tier1Price?, tier2Price?, tier1Services?, tier2Services? } }`
- [ ] Default `enabled` from `firm_retainer_settings.default_biller_toggle_on` (D13)
- [ ] Schedule notifications via BullMQ delayed jobs (Phase 7 dependency — stub for now)
- [ ] Vitest: prep-fee basis calculation across mixed-service-code invoices
- [ ] Vitest: tier price calc with various base/pct combos
- [ ] Vitest: suppression cases (zero basis, no return type, existing retainer)
- [ ] Vitest: override propagation into offer row

# Phase 4 — Biller invoice UI (retainer toggle)

- [ ] Extend existing invoice draft component `InvoiceDraftPanel.tsx`
- [ ] Conditional render: only when any line item's service code is in firm's prep_fee codes AND engagement has return_type
- [ ] Toggle component: "Offer retainer to client" defaulting to firm setting
- [ ] Live calc preview: basis, Tier 1 price, Tier 2 price
- [ ] Show portal visibility setting (read-only display of firm default)
- [ ] Show computed `offer_expires_at` (live updated when invoice_date changes)
- [ ] "Override pricing" modal: editable Tier 1 / Tier 2 prices with reset-to-default button
- [ ] "Override eligibility" modal: per-tier service code multi-select pre-populated from tier config
- [ ] Override indicators (badge "Pricing overridden" / "Eligibility overridden")
- [ ] Submit invoice with `retainerOptions` payload
- [ ] Empty state when no prep-fee line: muted message "No tax-prep line — retainer offer suppressed"
- [ ] Tooltip on toggle explaining 60-day portal window
- [ ] Vitest: component renders correctly for eligible/ineligible invoices
- [ ] Playwright E2E: create tax-prep invoice → verify offer row created with correct prices
- [ ] Playwright E2E: override prices → verify overrides persisted to offer

# Phase 5 — Client portal offer page

- [ ] Route: `GET /portal/retainer-offers/:id` (magic-link auth, existing Vibe Connect pattern)
- [ ] Backend endpoint `GET /api/portal/retainer-offers/:id` with auth scoped to offer's client
- [ ] React page `PortalRetainerOfferPage.tsx`
- [ ] Hero: "Protect your TY{year} {return_type} return"
- [ ] Countdown display: days remaining until `offer_expires_at`
- [ ] Tier 1 card (default, prominent): price, hours, eligible services, expiry date
- [ ] Tier 2 card (upgrade variant): price, hours, eligible services, expiry date
- [ ] "How it works" educational section
- [ ] [Add Standard Coverage] CTA → `POST /api/portal/retainer-offers/:id/select` with `tier: 'TIER_1'`
- [ ] [Upgrade to Premium] CTA → same endpoint with `tier: 'TIER_2'`
- [ ] [No thanks] CTA → `POST /api/portal/retainer-offers/:id/decline` → status = `declined`
- [ ] Backend selection handler creates invoice via existing `createInvoice` service
- [ ] Invoice metadata: `{ retainerOfferId, retainerTier, retainerTierConfigId }`
- [ ] Invoice line item: `RETAINER` service code, description per tier
- [ ] Offer status transitions to `pending_payment`, stores `purchased_tier` and `purchased_invoice_id`
- [ ] Post-selection redirect: existing AR invoice payment page
- [ ] Expired offer view: show "This offer expired on {date}" with no CTAs
- [ ] Already-purchased view: show "Coverage active — view in portal" linking to client retainer view
- [ ] Vitest: selection endpoint validates offer status and expiry
- [ ] Playwright E2E: full portal flow tier 1 selection → invoice issued

# Phase 6 — Payment webhook → retainer activation

- [ ] Extend existing AR payment webhook handler (`handleInvoicePaid`)
- [ ] Detect retainer-purchase invoices via `metadata.retainerOfferId`
- [ ] Service function `activateRetainerFromPaidInvoice(invoiceId)`
- [ ] Transaction wraps: load offer FOR UPDATE, validate `pending_payment`, idempotent on retry
- [ ] Load tier config snapshot (the specific tier purchased)
- [ ] Compute `expiry_date = COALESCE(extended, original) + 3 years` (D3)
- [ ] Insert `retainers` row with all frozen fields (D5: cash recognition — purchase_date = payment date)
- [ ] Determine service eligibility: prefer override snapshot, fallback to tier_config eligibility (D18)
- [ ] Insert `retainer_eligible_services` rows snapshotting eligibility
- [ ] Update offer: status `purchased`, set `purchased_at`
- [ ] Update engagement: set `retainer_id` (the unique constraint enforces D2)
- [ ] Cancel any remaining scheduled offer reminder jobs (BullMQ removeJobs)
- [ ] Emit `retainer.activated` domain event for downstream listeners
- [ ] Send confirmation email to client (existing email template system)
- [ ] Send notification to assigned staff and partner
- [ ] Idempotency: if retainer already exists for this offer, no-op and return existing
- [ ] Failure handling: if activation fails, leave offer in `pending_payment` and alert ops
- [ ] Vitest: activation creates retainer with frozen tier values
- [ ] Vitest: override snapshot used when present, tier default otherwise
- [ ] Vitest: idempotent on duplicate webhook delivery
- [ ] Playwright E2E: pay retainer invoice → verify retainer activated and engagement linked

# Phase 7 — BullMQ jobs

- [ ] Create queue `retainers` in `jobs/queues.ts`
- [ ] Worker `jobs/retainerWorker.ts` handling all retainer job types
- [ ] Job `expiry-sweep`: daily 02:00 cron, marks `active` retainers with `expiry_date < CURRENT_DATE` as `expired`
- [ ] Job `offer-expiry-sweep`: daily 02:15 cron, marks pending offers with `offer_expires_at < NOW()` as `expired`
- [ ] Job `expiry-warning`: per-retainer delayed jobs at 90/60/30/7 days before expiry
- [ ] Job `offer-reminder`: per-offer delayed jobs at firm-configured intervals (on-bill, day-30, day-55)
- [ ] Email template `retainer-expiry-warning.{days}d.tsx` (React Email or existing template engine)
- [ ] Email template `retainer-offer-reminder.tsx` with tier comparison
- [ ] Email template `retainer-activated.tsx` (Phase 6 dependency)
- [ ] Email template `retainer-exhausted.tsx` triggered by domain event from auto-split (Phase 8)
- [ ] Job scheduler service: register all repeating jobs at app boot
- [ ] Use `jobId` to make repeating jobs idempotent on redeploy
- [ ] Offer notification scheduling: schedule delayed reminder jobs at offer creation (Phase 3 hook)
- [ ] Cancel offer reminders when offer purchased/declined (Phase 6)
- [ ] Dead-letter queue for failed retainer jobs with alerting
- [ ] Job concurrency = 1 for sweep jobs (avoid duplicate emails on retry)
- [ ] Vitest: expiry sweep correctly transitions statuses
- [ ] Vitest: offer reminder respects firm settings (skips disabled reminders)
- [ ] Integration test against ephemeral Redis: schedule + execute reminder

# Phase 8 — Time-entry auto-split

- [ ] Service module `services/retainerConsumption.ts`
- [ ] Function `applyTimeEntryToRetainer(trx, entry)` returning split result
- [ ] `SELECT FOR UPDATE` on retainer row inside transaction (D1 race-safe)
- [ ] Eligibility checks: retainer is `active`, `entry_date <= expiry_date` (D22), service_code in eligible set
- [ ] On any check fail: return 100% billable WIP, no retainer link
- [ ] Compute `applied = LEAST(entry.hours, remaining)` and `spillover = entry.hours - applied`
- [ ] Update retainer: increment `hours_consumed`, transition to `exhausted` if equal to `hours_purchased`
- [ ] Insert `retainer_ledger` row after time_entry is persisted (need entry_id)
- [ ] Emit `retainer.exhausted` event when transitioning to exhausted status
- [ ] Edit path: reverse old ledger entry (decrement consumed), re-apply with new values, all in one transaction
- [ ] Delete path: reverse ledger entry, flip `exhausted` → `active` if consumed drops below purchased
- [ ] Approval/locking: if existing T&B has approved entries that lock further edits, respect that flag
- [ ] Extend time entry creation API to call `applyTimeEntryToRetainer` for any entry with engagement_id
- [ ] Extend time entry update API similarly
- [ ] Extend time entry delete API to reverse ledger
- [ ] Time entry UI: read-only retainer panel showing current retainer status when engagement selected
- [ ] Time entry UI: live split preview as hours/service_code change ("X.XX → retainer, Y.YY → WIP")
- [ ] Service-code-ineligible variant: muted info panel, no split preview
- [ ] Retainer-exhausted variant: muted info panel "Retainer exhausted — entry will be 100% billable WIP"
- [ ] Vitest: split logic across exact, under, over scenarios
- [ ] Vitest: race-safety with concurrent insert attempts (two transactions, same retainer, both 5h, only 8h left)
- [ ] Vitest: edit/delete correctly reverses ledger
- [ ] Vitest: service code mismatch routes to 100% WIP
- [ ] Vitest: entry on exact `expiry_date` is eligible (D22)
- [ ] Vitest: entry day after expiry routes to 100% WIP even if status still `active` (sweep may not have run)
- [ ] Playwright E2E: create entry that exhausts retainer, verify status transition and email

# Phase 9 — Partner dashboard

- [ ] Route: `GET /admin/retainers` (partner role required)
- [ ] React page `PartnerRetainerDashboard.tsx`
- [ ] KPI strip endpoint: `GET /api/admin/retainers/kpis` returning all card values in one round-trip
- [ ] KPI cards: Active count, Tier 1 active, Tier 2 active, Hours sold 12mo, Hours consumed 12mo, Utilization %, Expiring 90d (count + hours), Deferred liability (informational), Spillover billed 30d ($), Open offers
- [ ] Offer funnel panel: last 90d Offered / Purchased / Declined / Expired / Pending with Tier 1 vs Tier 2 split
- [ ] Main retainers table with columns: Client, TY, Type, Tier, Hours bar, Consumed, Expires, Status
- [ ] Filters: status, return_type, tier, expiry range, search by client name
- [ ] Sort by any column with server-side sorting
- [ ] Pagination (existing Vibe table pattern)
- [ ] Side panels: "Expiring in 90 days", "Idle 180+ days", "Top spillover (undersized signal)"
- [ ] Export to CSV button (existing Vibe CSV export pattern)
- [ ] Row click → retainer detail page `/admin/retainers/:id`
- [ ] Retainer detail page: header with status/expiry, hours progress bar, purchase info, engagement info, eligibility chips, ledger table, activity timeline
- [ ] Retainer detail actions: [Edit notes], [Void] (enabled only if `hours_consumed = 0` per D24)
- [ ] Void confirmation modal: requires reason text, reverses invoice via existing AR credit memo flow
- [ ] Vitest: KPI query correctness against fixture data
- [ ] Vitest: void blocked when `hours_consumed > 0`
- [ ] Playwright E2E: dashboard renders, filters work, void on unused retainer succeeds

# Phase 10 — Staff dashboard

- [ ] Route: `GET /my/retainers` (any authenticated staff role)
- [ ] React page `StaffRetainerDashboard.tsx`
- [ ] Filter logic: retainers on engagements where current user is in assigned staff list
- [ ] KPI strip: My active retainers, Hours remaining (sum), Near exhaustion count (<20% remaining), Expiring 90d count
- [ ] "Action needed" alert list: retainers with critical thresholds for this staff member
- [ ] Per-retainer table: Client, TY, Hours remaining bar, Expires, My hours contributed
- [ ] Row click → retainer detail (read-only for non-partners, no Void button)
- [ ] Vitest: filter correctly scopes to current user
- [ ] Playwright E2E: staff sees only assigned retainers

# Phase 11 — Client portal retainer view (optional, light-touch)

- [ ] Route: `GET /portal/retainers` (client magic-link auth)
- [ ] Lists client's active retainers
- [ ] Per-retainer detail: hours used / remaining / expiry / covered services
- [ ] Read-only ledger view (date, hours used, no internal description text — privacy)
- [ ] PDF "Retainer Activity Statement" generation using existing Vibe PDF generator
- [ ] Vitest: privacy filter strips internal-only fields
- [ ] Playwright E2E: client logs in, sees own retainers only

# Phase 12 — Reporting, exports, integration

- [ ] CSV export: full retainer ledger with all consumption events (for audit / accountant review)
- [ ] CSV export: offer funnel report
- [ ] Vibe MyBooks integration: post retainer revenue to GL on purchase (cash-basis recognition per D5)
- [ ] Vibe MyBooks GL mapping: configurable revenue account + offset to cash/AR
- [ ] Audit trail page showing every retainer mutation (creation, time entries applied, edits, voids, expiry)
- [ ] Vitest: GL posting amount and account selection
- [ ] Documentation: `docs/retainers.md` end-user guide
- [ ] Documentation: `docs/retainers-admin.md` partner setup guide
- [ ] Documentation: `docs/retainers-api.md` API reference

# Phase 13 — Observability & ops

- [ ] Metrics: `retainer_active_count`, `retainer_hours_remaining_total`, `retainer_expiring_30d`, `retainer_offers_pending`
- [ ] Metrics: `retainer_job_duration_seconds`, `retainer_job_failures_total`
- [ ] Structured logs on every state transition (`info`, with retainer_id, old_status, new_status, actor)
- [ ] Alert: any retainer with `hours_consumed > hours_purchased` (data integrity violation)
- [ ] Alert: any offer stuck in `pending_payment` for > 60 days
- [ ] Alert: BullMQ job failure rate > 1% over 1h window
- [ ] Healthcheck endpoint `GET /api/health/retainers` confirming queue connectivity and recent sweep run
- [ ] Runbook: `docs/runbooks/retainer-expiry-recovery.md` (what to do if nightly sweep misses a day)
- [ ] Runbook: `docs/runbooks/retainer-data-fix.md` (manual ledger reversal procedure)

# Phase 14 — Migration & rollout

- [ ] Feature flag `retainers.enabled` (per-firm) defaulting to OFF
- [ ] Backfill script: for firms enabling the feature, create default tier configs from a template
- [ ] Backfill script: optional — convert any existing manual "retainer" tracking (custom service codes, GL accounts) into proper retainer rows
- [ ] Pre-launch checklist documenting flag flip, smoke test, monitor period
- [ ] Internal QA on staging with synthetic client + invoice + offer + portal purchase + time entry consumption + expiry sweep
- [ ] Pilot firm rollout (one CPA firm) for 30 days before general availability
- [ ] Post-pilot review: KPI accuracy, edge cases discovered, refinements
- [ ] General availability flip
- [ ] Sunset: any legacy retainer tracking pattern deprecated with 90-day notice

---

## QUESTIONS.md protocol

If any phase encounters ambiguity unresolved by §0.1 fallback hierarchy or §0.2 locked decisions, append a question to `QUESTIONS.md` in this format:

```
## Q{NN} — Phase {N} — {Short title}
**Context:** {what you were doing}
**Ambiguity:** {what's unclear}
**Options considered:**
- A: {option}
- B: {option}
**Recommendation:** {your best guess if forced to pick}
**Blocker:** {yes/no — can you proceed past this?}
```

Do not invent business rules. Ask.

---

## Acceptance criteria summary

A reviewer should be able to verify the addendum is complete by:

1. Creating tier configs for 1040 in firm settings, both tiers active
2. Drafting a tax-prep invoice for a 1040 engagement → retainer toggle defaults ON, prices computed correctly
3. Sending the invoice → offer row created in `retainer_offers` table
4. Client portal renders the offer page with Tier 1 default + Tier 2 upgrade
5. Client selects Tier 1 → invoice issued via AR flow
6. Marking that invoice paid → `retainers` row created, engagement linked, status `active`
7. Logging a 1.5h time entry against the engagement with a covered service code → ledger row, hours_consumed = 1.5
8. Logging another time entry that exceeds remaining → ledger row with spillover, retainer status `exhausted`
9. Running the expiry sweep against a retainer past its expiry date → status `expired`
10. Partner dashboard shows correct KPIs at every step
11. Staff dashboard scoped to that user's assigned engagements only
12. Voiding an unused retainer reverses the source invoice; voiding a used retainer is blocked
