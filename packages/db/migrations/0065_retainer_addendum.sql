-- =====================================================================
-- Migration: 0065_retainer_addendum.sql  (Stage R0)
--
-- Vibe T&B Retainer Addendum — schema groundwork.
--
-- Implements the prepaid-retainer feature: firm configures two tiers per
-- return type, biller toggles offer creation on tax-prep invoices, client
-- portal page lets the client buy a tier, payment activates the retainer,
-- time entries auto-split between retainer and billable WIP, nightly
-- sweep expires unused hours.
--
-- This migration is STRUCTURE ONLY. Business logic lands in subsequent
-- stages (R1–R6). All retainer behavior is gated by
-- firm_retainer_settings.feature_enabled (Phase 14 #1), defaulting false.
--
-- Naming translation: the addendum doc says "service code"; Vibe T&B
-- uses `work_code`. Every "service code" in the addendum maps to
-- work_code_id. This migration creates NO new "service_code" concept.
--
-- Coexistence notes (these pre-existing constructs are LEFT ALONE):
--   • engagement.retainer_locked_at (from 0050) — unrelated lock toggle
--   • billing_batch.kind = 'RETAINER' (from 0050) — unrelated batch kind
--   • hour_bank / hour_bank_transaction — separate prepaid-hours pool
--     with its own manual-debit ledger. Phase 8 consumption logic in R5
--     only consumes the retainer; hour banks stay manual.
--
-- Tables created:
--   retainer_tier_config              — per (firm, return_type, tier)
--   retainer_tier_eligible_service    — work-codes covered by a tier
--   firm_retainer_settings            — per-firm feature toggle + cadence
--   retainer_offer                    — pending offer with frozen prices
--   retainer                          — activated retainer (UNIQUE per engagement)
--   retainer_eligible_service         — immutable eligibility snapshot
--   retainer_ledger                   — append-only consumption log
--
-- Columns added:
--   engagement.{retainer_id, return_type, tax_year, original_due_date,
--               extended_due_date}
--   time_entry.{retainer_id, retainer_hours, billable_hours}
-- =====================================================================

-- --- (1) enums ------------------------------------------------------

CREATE TYPE retainer_tier AS ENUM ('TIER_1', 'TIER_2');

CREATE TYPE retainer_status AS ENUM ('active', 'exhausted', 'expired', 'void');

CREATE TYPE return_type AS ENUM ('1040', '1065', '1120', '1120S', '1041', '990');

CREATE TYPE retainer_offer_status AS ENUM (
  'pending',
  'pending_payment',
  'purchased',
  'declined',
  'expired'
);

CREATE TYPE retainer_ledger_kind AS ENUM ('ACTIVATION', 'CONSUME', 'REVERSE');

-- --- (2) retainer_tier_config + eligibility ------------------------
--
-- Two tiers per (firm, return_type). Eligibility is a separate child
-- table (work_code multi-select). is_active=false soft-disables a tier
-- without deleting historical configs.

CREATE TABLE vibetb.retainer_tier_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  return_type return_type NOT NULL,
  tier retainer_tier NOT NULL,
  name text NOT NULL,
  hours numeric(8,2) NOT NULL,
  base_fee_cents bigint NOT NULL DEFAULT 0,
  -- Stored as basis points (0..10000 → 0%..100%). Matches the codebase
  -- convention (see engagement.rate_multiplier_bps). Core math primitive
  -- consumes this directly without scale conversion.
  pct_of_prep_fee_bps integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retainer_tier_config_hours_positive CHECK (hours > 0),
  CONSTRAINT retainer_tier_config_base_fee_nonneg CHECK (base_fee_cents >= 0),
  CONSTRAINT retainer_tier_config_pct_range
    CHECK (pct_of_prep_fee_bps BETWEEN 0 AND 10000)
);

CREATE UNIQUE INDEX retainer_tier_config_firm_return_tier_uk
  ON vibetb.retainer_tier_config (firm_id, return_type, tier);

CREATE TABLE vibetb.retainer_tier_eligible_service (
  tier_config_id uuid NOT NULL
    REFERENCES vibetb.retainer_tier_config(id) ON DELETE CASCADE,
  work_code_id uuid NOT NULL
    REFERENCES vibetb.work_code(id) ON DELETE RESTRICT,
  PRIMARY KEY (tier_config_id, work_code_id)
);

-- --- (3) firm_retainer_settings ------------------------------------
--
-- One row per firm. feature_enabled is the master kill switch — Phase 14
-- ships a per-firm flag defaulting OFF. Operational and notification
-- cadence settings live here so the partner UI can tune without code.

CREATE TABLE vibetb.firm_retainer_settings (
  firm_id uuid PRIMARY KEY REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  feature_enabled boolean NOT NULL DEFAULT false,
  -- D13 — biller toggle default ON
  default_biller_toggle_on boolean NOT NULL DEFAULT true,
  -- D12 / D20 — portal window (days from invoice_date)
  offer_window_days integer NOT NULL DEFAULT 60,
  -- D11 — work codes that count toward prep-fee basis
  prep_fee_work_code_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- D17 — togglable reminder cadence (fixed days for v1: 0/30/55)
  notify_on_bill boolean NOT NULL DEFAULT true,
  notify_day_30 boolean NOT NULL DEFAULT true,
  notify_day_55 boolean NOT NULL DEFAULT true,
  -- R6 placeholder — GL account mapping for cash-basis revenue posting.
  -- NULL until configured; gl_posting service refuses to post until set.
  revenue_gl_account text,
  offset_gl_account text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT firm_retainer_settings_window_positive
    CHECK (offer_window_days > 0)
);

-- Backfill: every existing firm gets a settings row with feature_enabled
-- still false so behavior is unchanged until an operator flips it.
INSERT INTO vibetb.firm_retainer_settings (firm_id)
SELECT id FROM vibetb.firm
ON CONFLICT (firm_id) DO NOTHING;

-- --- (4) retainer_offer --------------------------------------------
--
-- Created by R2 when a biller issues a tax-prep invoice. Carries frozen
-- tier prices (with optional override snapshot) and an expiry timestamp.
-- Selecting a tier (R3 portal flow) creates a new AR invoice and flips
-- status → pending_payment; paying that invoice activates the retainer.

CREATE TABLE vibetb.retainer_offer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES vibetb.client(id) ON DELETE RESTRICT,
  engagement_id uuid NOT NULL REFERENCES vibetb.engagement(id) ON DELETE RESTRICT,
  -- Source invoice that triggered the offer (the tax-prep invoice).
  invoice_id uuid NOT NULL REFERENCES vibetb.invoice(id) ON DELETE RESTRICT,
  return_type return_type NOT NULL,
  tax_year integer NOT NULL,
  -- Snapshot of prep-fee basis at offer creation. Frozen so reprice of
  -- the source invoice doesn't drift the offer.
  prep_fee_basis_cents bigint NOT NULL,
  tier_1_tier_config_id uuid NOT NULL
    REFERENCES vibetb.retainer_tier_config(id) ON DELETE RESTRICT,
  tier_2_tier_config_id uuid NOT NULL
    REFERENCES vibetb.retainer_tier_config(id) ON DELETE RESTRICT,
  -- Snapshot prices. May reflect biller-supplied overrides.
  tier_1_price_cents bigint NOT NULL,
  tier_2_price_cents bigint NOT NULL,
  -- Optional per-tier eligibility override at offer creation. Shape:
  -- { "tier1": [work_code_id, ...], "tier2": [work_code_id, ...] }
  -- Promoted to retainer_eligible_service at activation (D18).
  eligibility_overrides_json jsonb,
  offer_expires_at timestamptz NOT NULL,
  status retainer_offer_status NOT NULL DEFAULT 'pending',
  -- Filled when a tier is selected.
  purchased_tier retainer_tier,
  purchased_invoice_id uuid REFERENCES vibetb.invoice(id) ON DELETE RESTRICT,
  purchased_at timestamptz,
  declined_at timestamptz,
  -- BullMQ delayed-job ids (R4) so the activation handler can cancel them.
  reminder_job_ids jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retainer_offer_prices_nonneg
    CHECK (tier_1_price_cents >= 0 AND tier_2_price_cents >= 0),
  CONSTRAINT retainer_offer_basis_nonneg
    CHECK (prep_fee_basis_cents >= 0)
);

CREATE INDEX retainer_offer_sweep_idx
  ON vibetb.retainer_offer (status, offer_expires_at);
CREATE INDEX retainer_offer_invoice_idx
  ON vibetb.retainer_offer (invoice_id);
CREATE INDEX retainer_offer_engagement_idx
  ON vibetb.retainer_offer (engagement_id);

-- --- (5) retainer --------------------------------------------------
--
-- Activated retainer. UNIQUE (engagement_id) enforces D2. Cash-basis
-- revenue recognition (D5) means purchase_date = payment date, set by
-- the activation handler. expiry_date is COALESCE(extended, original)
-- + 3 years (D3), frozen at activation (D23).

CREATE TABLE vibetb.retainer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES vibetb.client(id) ON DELETE RESTRICT,
  engagement_id uuid NOT NULL REFERENCES vibetb.engagement(id) ON DELETE RESTRICT,
  offer_id uuid NOT NULL REFERENCES vibetb.retainer_offer(id) ON DELETE RESTRICT,
  -- The retainer-purchase AR invoice paid by the client. Distinct from
  -- the source tax-prep invoice on the offer.
  purchase_invoice_id uuid NOT NULL REFERENCES vibetb.invoice(id) ON DELETE RESTRICT,
  tier retainer_tier NOT NULL,
  return_type return_type NOT NULL,
  tax_year integer NOT NULL,
  tier_config_id uuid NOT NULL
    REFERENCES vibetb.retainer_tier_config(id) ON DELETE RESTRICT,
  -- Frozen at activation. Name lets the UI render historical tiers even
  -- if the firm renames the config later.
  name text NOT NULL,
  hours_purchased numeric(8,2) NOT NULL,
  hours_consumed numeric(8,2) NOT NULL DEFAULT 0,
  price_cents bigint NOT NULL,
  -- D5 — purchase_date = the date the activating payment landed.
  purchase_date date NOT NULL,
  -- D3 — COALESCE(extended_due_date, original_due_date) + 3 years.
  expiry_date date NOT NULL,
  status retainer_status NOT NULL DEFAULT 'active',
  -- Partner-editable workflow note (Phase 9).
  notes text,
  -- Void bookkeeping (D24 — only when hours_consumed = 0).
  voided_at timestamptz,
  voided_by_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  voided_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- D2 — one retainer per engagement
  CONSTRAINT retainer_engagement_uk UNIQUE (engagement_id),
  -- Consumption invariant — Phase 8 must never write a value outside this
  CONSTRAINT retainer_hours_consumed_bounds
    CHECK (hours_consumed >= 0 AND hours_consumed <= hours_purchased),
  CONSTRAINT retainer_hours_purchased_positive CHECK (hours_purchased > 0),
  CONSTRAINT retainer_price_nonneg CHECK (price_cents >= 0)
);

CREATE INDEX retainer_sweep_idx ON vibetb.retainer (status, expiry_date);
CREATE INDEX retainer_client_status_idx ON vibetb.retainer (client_id, status);

-- --- (6) retainer_eligible_service (immutable snapshot) ------------
--
-- Frozen at activation per D6. Resolves overrides first (D18), falls
-- back to the tier_config's current eligibility.

CREATE TABLE vibetb.retainer_eligible_service (
  retainer_id uuid NOT NULL
    REFERENCES vibetb.retainer(id) ON DELETE CASCADE,
  work_code_id uuid NOT NULL
    REFERENCES vibetb.work_code(id) ON DELETE RESTRICT,
  PRIMARY KEY (retainer_id, work_code_id)
);

-- --- (7) retainer_ledger (append-only) -----------------------------
--
-- Every consumption / reversal writes a row. Never UPDATE or DELETE;
-- edits insert a new REVERSE row. The hours_balance_after column is the
-- denormalized remaining-hours figure for ledger view rendering.

CREATE TABLE vibetb.retainer_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  retainer_id uuid NOT NULL REFERENCES vibetb.retainer(id) ON DELETE RESTRICT,
  -- Time entry that produced this row. NULL for ACTIVATION (seed) and
  -- some REVERSE rows where the originating entry has been deleted.
  time_entry_id uuid REFERENCES vibetb.time_entry(id) ON DELETE RESTRICT,
  kind retainer_ledger_kind NOT NULL,
  -- Positive for CONSUME, negative for REVERSE, 0 for ACTIVATION seed.
  hours_delta numeric(8,2) NOT NULL,
  -- Snapshot of hours_purchased - hours_consumed AFTER this row applied.
  hours_balance_after numeric(8,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL
);

CREATE INDEX retainer_ledger_retainer_created_idx
  ON vibetb.retainer_ledger (retainer_id, created_at);

-- --- (8) engagement columns ----------------------------------------

ALTER TABLE vibetb.engagement
  ADD COLUMN IF NOT EXISTS retainer_id uuid
    REFERENCES vibetb.retainer(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS return_type return_type,
  ADD COLUMN IF NOT EXISTS tax_year integer,
  ADD COLUMN IF NOT EXISTS original_due_date date,
  ADD COLUMN IF NOT EXISTS extended_due_date date;

-- The retainer.engagement_id UNIQUE constraint already enforces D2
-- (one retainer per engagement). engagement.retainer_id is a
-- convenience pointer that mirrors the active retainer; the activation
-- handler keeps them in sync within the same transaction.

-- --- (9) time_entry columns ----------------------------------------
--
-- Keep time_entry.hours as the canonical total so existing reports and
-- materialized views don't shift. The two new columns are the split
-- breakdown that the auto-split logic (R5) writes. NULL means "not yet
-- evaluated by the split logic" — pre-R5 entries, or entries against
-- engagements with no retainer.

ALTER TABLE vibetb.time_entry
  ADD COLUMN IF NOT EXISTS retainer_id uuid
    REFERENCES vibetb.retainer(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS retainer_hours numeric(8,2),
  ADD COLUMN IF NOT EXISTS billable_hours numeric(8,2);

-- Partial index — only entries that actually touched a retainer. Lets
-- the dashboard reconciliation queries scan only the relevant rows.
CREATE INDEX IF NOT EXISTS time_entry_retainer_idx
  ON vibetb.time_entry (retainer_id)
  WHERE retainer_id IS NOT NULL;
