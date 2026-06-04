-- =====================================================================
-- Migration: 0098_opensign_esign_provider.sql
--
-- Q35 — OpenSign as a first-class, per-firm-opt-in e-signature provider.
--
-- OpenSign is AGPL and runs ONLY as an isolated upstream container image
-- reached over HTTP on the docker network (see LICENSING.md). Nothing in
-- this migration imports or links OpenSign — these columns/tables are
-- our own bookkeeping for envelopes the sidecar signs.
--
-- Adds:
--   - firm_settings_proposals.esign_provider — per-firm provider choice
--     (native default | opensign). Native stays the default everywhere.
--   - proposal_pending_mandate — stashes the Stripe ACH mandate inputs
--     between the portal "start OpenSign signing" call and the async
--     completion (webhook / poll), so the completion can capture the
--     mandate idempotently keyed on stripe_mandate_id.
--   - opensign_webhook_events — idempotency ledger for OpenSign webhook
--     deliveries, keyed on the OpenSign event id (mirrors the Stripe
--     webhook_events pattern).
--
-- Backward compatible: every existing firm keeps esign_provider='native'
-- (the column default), and the two new tables are empty until a firm
-- opts in.
-- =====================================================================

-- Per-firm e-sign provider selection. Native is the default; opensign is
-- only honored when OPENSIGN_URL is configured (otherwise the API logs a
-- warning and falls back to native — see app.ts wiring).
ALTER TABLE vibetb.firm_settings_proposals
  ADD COLUMN IF NOT EXISTS esign_provider text NOT NULL DEFAULT 'native';

ALTER TABLE vibetb.firm_settings_proposals
  DROP CONSTRAINT IF EXISTS firm_settings_proposals_esign_provider_chk;
ALTER TABLE vibetb.firm_settings_proposals
  ADD CONSTRAINT firm_settings_proposals_esign_provider_chk
  CHECK (esign_provider IN ('native', 'opensign'));

-- Pending ACH mandate context for an in-flight OpenSign signing session.
-- One row per (proposal, signature) signing attempt. The async
-- completion reads it, captures the mandate, then leaves the row in
-- place (it's harmless history; capture is idempotent on
-- stripe_mandate_id via payment_mandates).
CREATE TABLE IF NOT EXISTS vibetb.proposal_pending_mandate (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  proposal_id uuid NOT NULL REFERENCES vibetb.proposals(id) ON DELETE CASCADE,
  signature_id uuid NOT NULL REFERENCES vibetb.signatures(id) ON DELETE CASCADE,
  selected_package_id uuid,
  stripe_customer_id text,
  stripe_payment_method_id text,
  stripe_mandate_id text,
  mandate_text_rendered text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT proposal_pending_mandate_signature_uk UNIQUE (signature_id)
);

CREATE INDEX IF NOT EXISTS proposal_pending_mandate_proposal_idx
  ON vibetb.proposal_pending_mandate (proposal_id);

-- OpenSign webhook idempotency ledger. Keyed on the OpenSign event id so
-- a redelivered event is a no-op. Mirrors the Stripe webhook_events
-- pattern (state machine + received/processed timestamps).
CREATE TABLE IF NOT EXISTS vibetb.opensign_webhook_events (
  opensign_event_id text PRIMARY KEY,
  firm_id uuid REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  envelope_id text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  state text NOT NULL DEFAULT 'PENDING',
  last_error text,
  payload jsonb NOT NULL DEFAULT '{}',
  CONSTRAINT opensign_webhook_events_state_chk
    CHECK (state IN ('PENDING', 'PROCESSED', 'FAILED', 'IGNORED'))
);

CREATE INDEX IF NOT EXISTS opensign_webhook_events_envelope_idx
  ON vibetb.opensign_webhook_events (envelope_id);

-- Lookup index for the worker poll fallback: pending OpenSign signatures
-- with an envelope id.
CREATE INDEX IF NOT EXISTS signatures_opensign_pending_idx
  ON vibetb.signatures (opensign_envelope_id)
  WHERE method = 'OPENSIGN' AND state = 'PENDING' AND opensign_envelope_id IS NOT NULL;
