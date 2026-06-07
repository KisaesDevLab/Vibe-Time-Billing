# Payments (Stripe) — Gap-Closure Plan

Codebase-grounded mapping of the Phase-28 Stripe Payments build plan against what
**already exists** in Vibe T&B, with sequenced milestones for the remaining work.

## Locked decisions (this round)

- **No platform application fee.** Keep CLAUDE.md decision #7: each firm owns its
  Stripe account and keeps 100% of every charge. **Phase 11 is dropped**, and the
  `application_fee_amount` parts of phases 10 / 12 / 16 are **out of scope**. (The code
  already uses Connect OAuth but takes no app fee — this just confirms that posture.)
- **Keep the existing custom Stripe HTTP client** (`packages/core/src/payments/stripe.ts`)
  rather than swapping to the official `stripe` SDK the plan assumes. It already injects
  `Stripe-Account` + `Idempotency-Key`. We will **pin the Stripe API version** explicitly
  in that client (currently relies on the account default).

## Status legend

✅ done · 🟡 partial · ❌ missing · ⛔ dropped (per decision)

## Phase-by-phase status

| # | Phase | Status | What exists / what's left |
|---|-------|--------|---------------------------|
| 1 | Foundations | 🟡 | Custom client w/ `Stripe-Account`+idempotency (`core/payments/stripe.ts`); per-firm gating exists. **Left:** pin API version; explicit ACH/FC config flags. |
| 2 | Connect Standard onboarding | ✅ | OAuth connect, `stripeAccountId`/capabilities on `firm_settings_proposals`, `/account-status` (`stripe-connect/routes.ts`,`oauth.ts`). **Left:** enforce `charges_enabled` gate before pay features; clean disconnect/revoke. |
| 3 | Capability & PM settings | 🟡 | Capabilities cached + `account.updated` refresh. **Left:** verify/request `us_bank_account_ach_payments`; enable ACH in PM settings; NACHA "don't classify as goods"; scheduled re-check. |
| 4 | Data model | 🟡 | Exist: stripe fields on `firm_settings_proposals`, `stripe_customers`, `payment_mandates`, `payment_method` (portal), `payments`, `payment_receipt`, `webhook_events`, `stripe_subscriptions`, `stripe_invoices`, `credit_memo`/`credit_application`, `recurring_billing_plan`, `dunning_history`. **Left:** `terminal_locations`, `terminal_readers`, `ach_returns`/disputes. (Discrete `payment_intents` table not needed — tracked via payments/receipts.) |
| 5 | Webhook ingestion + router | ✅ | Two routers (direct + Connect), signature verify, `event.account`→firm, idempotency ledger. **Left:** dedicated Terminal endpoint; dead-letter/replay tooling. |
| 6 | Payor Customer creation | ✅ | `stripe_customers` on the connected account; reused. |
| 7 | Save card on file | 🟡 | SetupIntent (card), persist on `setup_intent.succeeded`. **Left:** confirm consent + `allow_redisplay` handling. |
| 8 | Save bank account (ACH) | 🟡 | SetupIntent `us_bank_account`, portal collect, mandate capture. **Left:** Financial Connections instant-verify backend + `balances` permission; microdeposit fallback state; persist `fc_linked`. |
| 9 | NACHA mandate capture | 🟡 | Versioned + SHA-256 text, `payment_mandates` state machine, `mandate.updated`. **Left:** SEC code (WEB/CCD/PPD); recurring disclosure copy; ≥7-day notice; auto re-collect on `inactive`; portal copy delivery. |
| 10 | One-time on-session pay | ✅ | Portal `/pay` + staff `/receive/intent`; ACH stays `processing` until succeeded. |
| 11 | Application fee & pricing | ⛔ | Dropped — no platform fee. |
| 12 | Off-session card draft (MIT) | 🟡 | `stripe.charge()` off-session via `recurring-billing` autopay. **Left:** `authentication_required` (402) recovery + on-session recovery link; decline-code capture for dunning. |
| 13 | Off-session ACH draft | ❌ | **Net-new:** dedicated path = `confirm=true` + saved bank PM + `payment_method_types[]=us_bank_account`, **no `off_session`**, mandate-active/PM-not-blocked preconditions, optional FC balance refresh; reconcile via webhooks. |
| 14 | Saved-method management UI | 🟡 | Portal `PaymentMethods.tsx` list/default/remove. **Left:** re-verify microdeposits, re-authorize mandate, mandate status + "authorized on" display; staff view. |
| 15 | Terminal: Location + Reader provisioning | ❌ | **Net-new.** No code. Server-driven; create Location + register Reader (S700/S710) on the connected account; reader health. |
| 16 | Terminal: card-present collection | ❌ | **Net-new.** `card_present` PI (direct charge, **no app fee**), `process_payment_intent`, manual capture, dedicated Terminal webhooks, busy/stuck-reader recovery (`cancel_action`). |
| 17 | Terminal: card-on-file, receipts, refunds | ❌ | **Net-new.** `setup_future_usage`/`card_present` SetupIntent → `generated_card` → feeds Phase 12; receipts; refunds; CNP-recurring caveat. |
| 18 | Recurring schedules data model | 🟡 | `recurring_billing_plan` covers fixed + variable (T&B). **Left:** require active mandate for bank-PM schedules; notice-policy fields. |
| 19 | Scheduler engine | 🟡 | `recurring-billing.ts` worker. **Left:** verify idempotent run keys (`plan+period`); pre-debit notice job. |
| 20 | Variable-invoice binding | 🟡 | Worker builds invoices from T&B. **Left:** zero/negative skip, max-draft caps, write source invoice id on the PI/payment. |
| 21 | Dunning & retry (NACHA) | 🟡 | 5-step dunning + retry days 3/7/14 + auto-pause (`dunning-sweep.ts`,`payment-retry.ts`). **Left:** NACHA caps (≤2 retries/40 days), never retry R05/R07/R08/R10, firm-configurable thresholds. |
| 22 | ACH lifecycle handling | ❌ | **Net-new.** `processing`→`succeeded`/`failed`/**dispute**; late-failure disputes (final); `payment_method.automatically_updated` blocked-PM → pause schedules + re-link; `ach_returns` table. |
| 23 | Reconciliation → ledger/AR | 🟡 | `/reconciliation` + `paidCents` recompute. **Left:** GL/COA mapping (no ledger table), payout reconciliation snapshot, distinct fee recording. |
| 24 | Refunds, voids, credits | 🟡 | `charge.refunded`/dispute webhooks, refund + auto-credit excess. **Left:** void uncaptured; confirm permission gating. (`refund_application_fee` N/A.) |
| 25 | Notifications | 🟡 | `payment_received`/`payment_failed`/`autopay_retry_failed` templates. **Left:** **pre-debit notice**, dispute alerts, mandate-copy delivery. |
| 26 | Reporting | 🟡 | `PaymentsReceivedReport.tsx`. **Left:** Stripe-fee report, ACH returns/disputes dashboard, recurring health. |
| 27 | Security / PCI SAQ-A | 🟡 | Hosted Payment Element (no PAN transit). **Left (ops):** client-side script monitoring, ASV scans ≥90 days, CSP, attestation docs. |
| 28 | NACHA operational compliance | ❌ | **Net-new (process+config):** SEC codes, ≥7-day notice, `PURCHASE` labeling (Mar 20 2026), revocation + retention. |
| 29 | Error/observability/audit | 🟡 | Audit log + structured logs exist. **Left:** payment metrics (draft success, ACH return rate, auth-required rate, webhook lag). |
| 30 | Test plan | 🟡 | Payment/webhook tests exist. **Left:** ACH return-code fixtures, off-session draft e2e, scheduler idempotency, Terminal test reader. |
| 31 | Docs & runbooks | ❌ | Firm onboarding, dispute/blocked-account/stuck-reader runbooks. |
| 32 | Migration (optional) | ❌ | Offline `mandate_data` import for pre-existing bank accounts. |
| 33 | Launch & rollback | ❌ | Pilot one firm behind `payments_enabled`; 30-day ACH-return watch. |

## Sequenced milestones (each shippable behind `payments_enabled`)

**M1 — ACH on-file foundation** (phases 8, 9 finish, 14)
Financial Connections instant-verify backend (+ `balances`), microdeposit fallback state, mandate completeness (SEC code, disclosure copy, re-collect on inactive, portal copy), saved-method management polish. *This is the base every draft relies on.*

**M2 — ACH drafting + lifecycle + NACHA dunning** (13, 21, 22) — *highest value*
Correct off-session ACH draft path; `ach_returns` table; `processing`/dispute/blocked-PM handling; NACHA retry caps + non-retriable return codes; "never mark paid until `payment_intent.succeeded`" enforced. Makes recurring + retainer auto-draft trustworthy.

**M3 — Card MIT recovery + pre-debit notices + metrics** (12 finish, 19 notice job, 25, 29 metrics)
`authentication_required` recovery link; pre-debit notice job ahead of each draft; dispute/failure alerts; payment dashboards' metrics.

**M4 — Stripe Terminal (in-person)** (15, 16, 17) — *biggest net-new capability*
Location/Reader provisioning on the connected account; `card_present` direct charge (no app fee) via server-driven `process_payment_intent` + dedicated Terminal webhooks; card-on-file → `generated_card`; receipts/refunds; stuck-reader `cancel_action`. Pairs with the retainer "pay at office."

**M5 — Reconciliation, reporting & compliance hardening** (23, 26, 27, 28)
GL/payout reconciliation, ACH-returns + recurring-health dashboards, SAQ-A monitoring/ASV, NACHA operational items.

**M6 — Test, docs, launch** (30, 31, 33; 32 optional)
ACH/Terminal fixtures, scheduler idempotency tests, runbooks, pilot + rollback.

## Do-not-miss (still applies to the remaining work)

1. **ACH off-session has NO `off_session` flag and NO re-collected mandate** — just
   `confirm=true` + saved PM + `payment_method_types[]=us_bank_account`. (M2)
2. **Everything on the connected account** via `Stripe-Account` (already the pattern).
3. **Never mark an ACH invoice paid until `payment_intent.succeeded`** — late returns are
   final, uncontestable. (M2)
4. **Cap ACH retries at 2/40 days; never retry R05/R07/R08/R10 without new auth.** (M2)
5. **Idempotency keys on every create/confirm + run-keys per scheduled draft.** (verify M2/M3)
6. **SAQ-A is conditional:** hosted fields + script monitoring + 90-day ASV. (M5)
7. **Terminal: server-driven** (no client SDK / connection token); register Location+Reader
   on the connected account; `process_payment_intent` 200 = ack only → confirm via
   `terminal.reader.*` webhooks; don't recreate PI on decline; reset stuck reader with
   `cancel_action`. (M4)
8. **In-person `generated_card` recurring charges are card-not-present** (no EMV liability
   shift) and feed the off-session card path. (M4)

## Open items to confirm before each milestone

- M1/M2: business bank accounts (CCD/PPD) in scope, or WEB-consumer ACH only?
- M2: per-firm fallback policy (card↔ACH) + max variable-draft cap defaults.
- M3: pre-debit notice lead time (NACHA ≥7 days for timing changes).
- M4: Terminal hardware default per firm (S700 vs S710 cellular); manual-capture window.
- M5: GL/COA target (is there a ledger we map into, or AR-only reconciliation?).
