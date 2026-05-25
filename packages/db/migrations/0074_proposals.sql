-- =====================================================================
-- Migration: 0074_proposals.sql  (Stage PP0)
--
-- Proposals + Live Agreements (Build Plan §2.8). The biggest single
-- portal addition — converts the firm's "send PDF letter + chase for
-- ACH" sales cycle into a single ~2-minute portal interaction.
--
-- Staged rollout (each stage closes with one commit):
--   PP0  schema groundwork (this migration + RBAC keys)
--   PP1  staff proposal CRUD + draft → send
--   PP2  portal list + review + tier select (UI steps 1-2)
--   PP3  sign + agreement creation + counter-propose (UI step 3)
--   PP4  Stripe Setup Intent payment authorization (UI step 4)
--   PP5  live agreement PATCH + change log + portal view
--   PP6  recurring billing wire-up on agreement activation
--
-- Five tables. Lifecycle:
--
--   proposal:
--     DRAFT → SENT (firm clicks Send; sets sent_at + expires_at)
--     SENT  → SIGNED    (client clicks Sign — terminal for proposal,
--                        creates agreement row)
--     SENT  → COUNTERED (client clicks "Request changes" — kicks back
--                        to firm with a typed note; firm amends + sends
--                        a NEW proposal)
--     SENT  → EXPIRED   (sweep — expires_at < now)
--     DRAFT / SENT → CANCELLED (firm pulls it back)
--
--   agreement (one per signed proposal):
--     ACTIVE → PAUSED   (firm pause; recurring billing skips this row)
--     PAUSED → ACTIVE   (resume)
--     ACTIVE / PAUSED → TERMINATED (terminal — firm ends the
--                                    engagement; a new proposal/agreement
--                                    cycle starts the next term)
--
-- All proposal + agreement mutations write an audit_log row via the
-- application's emitAudit helper. Field-level diffs on agreement
-- edits land in agreement_change_log so partner + client see the
-- exact change history.
-- =====================================================================

CREATE TYPE proposal_status AS ENUM (
  'DRAFT',
  'SENT',
  'SIGNED',
  'COUNTERED',
  'EXPIRED',
  'CANCELLED'
);

CREATE TYPE price_cadence AS ENUM (
  'ONE_TIME',
  'MONTHLY',
  'QUARTERLY',
  'ANNUALLY'
);

CREATE TYPE agreement_status AS ENUM (
  'ACTIVE',
  'PAUSED',
  'TERMINATED'
);

-- ---------------------------------------------------------------------
-- proposal — header. Tiers + addons live in child tables so a single
-- query can render the full picker.
-- ---------------------------------------------------------------------
CREATE TABLE vibetb.proposal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES vibetb.client(id) ON DELETE RESTRICT,

  title text NOT NULL,
  subtitle text,
  cover_note text,
  -- Opaque firm-defined terms. Typical keys: cancellation_days,
  -- payment_terms_days, processing_fees_label, governing_law_state.
  -- JSONB so firms can extend without schema changes.
  terms jsonb NOT NULL DEFAULT '{}'::jsonb,

  status proposal_status NOT NULL DEFAULT 'DRAFT',

  sent_at timestamptz,
  expires_at timestamptz,
  sent_by_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,

  -- Filled in atomically when the client signs.
  signed_at timestamptz,
  signed_by_portal_identity_id uuid REFERENCES vibetb.portal_identity(id) ON DELETE SET NULL,
  signature_text text,   -- typed name as it appeared on the sign field
  signature_svg text,    -- optional drawn signature (sanitized by CP8 helper)
  signed_ip text,
  -- sha256 of the canonical signed payload (tiers + addons + terms +
  -- signature_text + signed_at).  Lets either party prove integrity
  -- of the document later — recomputable from the persisted rows.
  agreement_hash text,

  countered_at timestamptz,
  countered_note text,

  cancelled_at timestamptz,
  cancelled_by_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,

  -- A SENT proposal must have both sent_at and (optionally) expires_at
  -- after sent_at. Enforced at the application layer for clearer
  -- error messages; the CHECK below is just a sanity guard.
  CONSTRAINT proposal_expiry_after_send
    CHECK (expires_at IS NULL OR sent_at IS NULL OR expires_at > sent_at)
);

CREATE INDEX proposal_firm_status_idx
  ON vibetb.proposal (firm_id, status);
CREATE INDEX proposal_client_status_idx
  ON vibetb.proposal (client_id, status);
CREATE INDEX proposal_sweep_idx
  ON vibetb.proposal (status, expires_at)
  WHERE expires_at IS NOT NULL;

-- ---------------------------------------------------------------------
-- proposal_tier — 1..4 options the client picks from. The Side-by-side
-- cards in step 2 of the UI.
-- ---------------------------------------------------------------------
CREATE TABLE vibetb.proposal_tier (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES vibetb.proposal(id) ON DELETE CASCADE,
  name text NOT NULL,
  tagline text,
  price_cents bigint NOT NULL,
  price_cadence price_cadence NOT NULL,
  -- Used in the "save $X/year vs à-la-carte" pitch. NULL when n/a.
  annual_savings_cents bigint,
  recommended boolean NOT NULL DEFAULT false,
  -- Array of {name: string, included: boolean} so the checkmark/strike
  -- list renders directly from this column.
  services jsonb NOT NULL DEFAULT '[]'::jsonb,
  sequence integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT proposal_tier_price_nonneg CHECK (price_cents >= 0),
  CONSTRAINT proposal_tier_savings_nonneg
    CHECK (annual_savings_cents IS NULL OR annual_savings_cents >= 0)
);

CREATE INDEX proposal_tier_proposal_seq_idx
  ON vibetb.proposal_tier (proposal_id, sequence);

-- ---------------------------------------------------------------------
-- proposal_addon — required + optional line items below the tier cards.
-- ---------------------------------------------------------------------
CREATE TABLE vibetb.proposal_addon (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES vibetb.proposal(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  price_cents bigint NOT NULL,
  price_cadence price_cadence NOT NULL,
  -- false = required (always added); true = client picks per checkbox.
  optional boolean NOT NULL DEFAULT true,
  sequence integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT proposal_addon_price_nonneg CHECK (price_cents >= 0)
);

CREATE INDEX proposal_addon_proposal_seq_idx
  ON vibetb.proposal_addon (proposal_id, sequence);

-- ---------------------------------------------------------------------
-- agreement — the live row created when the client signs. One per
-- signed proposal (UNIQUE backstop).
-- ---------------------------------------------------------------------
CREATE TABLE vibetb.agreement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES vibetb.client(id) ON DELETE RESTRICT,
  proposal_id uuid NOT NULL UNIQUE REFERENCES vibetb.proposal(id) ON DELETE RESTRICT,
  selected_tier_id uuid NOT NULL REFERENCES vibetb.proposal_tier(id) ON DELETE RESTRICT,
  -- Array of selected addon ids (subset of proposal_addon.id). Stored
  -- as JSONB to keep the schema flat — addons that change post-sign go
  -- into agreement_change_log.
  selected_addon_ids jsonb NOT NULL DEFAULT '[]'::jsonb,

  status agreement_status NOT NULL DEFAULT 'ACTIVE',
  -- Filled in by PP4 after Stripe Setup Intent confirms. NULL until
  -- then; recurring billing skips this agreement until it's set.
  autopay_method_id uuid REFERENCES vibetb.payment_method(id) ON DELETE SET NULL,
  -- Optional linkage to a live engagement created from this agreement.
  -- PP6 wires this when the firm chooses "convert to engagement".
  engagement_id uuid REFERENCES vibetb.engagement(id) ON DELETE SET NULL,

  activated_at timestamptz NOT NULL DEFAULT now(),
  paused_at timestamptz,
  paused_reason text,
  terminated_at timestamptz,
  terminated_reason text,
  terminated_by_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agreement_firm_status_idx
  ON vibetb.agreement (firm_id, status);
CREATE INDEX agreement_client_status_idx
  ON vibetb.agreement (client_id, status);

-- ---------------------------------------------------------------------
-- agreement_change_log — every staff edit to an active agreement gets
-- a row here so the client can see what changed and when.
-- Append-only by convention (no UPDATE / DELETE from the app).
-- ---------------------------------------------------------------------
CREATE TABLE vibetb.agreement_change_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id uuid NOT NULL REFERENCES vibetb.agreement(id) ON DELETE CASCADE,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  -- { before: {...}, after: {...}, fields_touched: [...] }
  diff jsonb NOT NULL,
  -- Optional human note ("Adding bookkeeping per client request").
  note text
);

CREATE INDEX agreement_change_log_agreement_idx
  ON vibetb.agreement_change_log (agreement_id, changed_at DESC);
