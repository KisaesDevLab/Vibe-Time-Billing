-- =====================================================================
-- Migration: 0229_filer_k1_recipient.sql
--
-- Vibe Filer: K-1 recipient secondary match. UltraTax K-1 packages
-- ("..._K1_Package_<Recipient Name>_<entity ids>.pdf") name a recipient
-- who may also be a client. Scan suggests a name-only fuzzy match;
-- staff must confirm (or dismiss) it; on commit the route job files an
-- ADDITIONAL copy of the PDF into the recipient client's folder at the
-- profile-configured path. Trailing id tokens in the filename belong to
-- the ENTITY, never the recipient, so matching is name-only.
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare statements only. Migrate runner wraps each file in one txn.
-- =====================================================================

-- Suggestion columns are refreshed on every scan; k1_status transitions
-- 'confirmed'/'dismissed' are review state and are never clobbered.
ALTER TABLE vibetb.inbox_items ADD COLUMN k1_recipient_name text;
ALTER TABLE vibetb.inbox_items ADD COLUMN k1_matched_client uuid REFERENCES vibetb.client(id) ON DELETE SET NULL;
ALTER TABLE vibetb.inbox_items ADD COLUMN k1_match_score real;
ALTER TABLE vibetb.inbox_items ADD COLUMN k1_status text;
ALTER TABLE vibetb.inbox_items ADD COLUMN k1_override_folder text;
ALTER TABLE vibetb.inbox_items
  ADD CONSTRAINT inbox_items_k1_status_ck
  CHECK (k1_status IS NULL OR k1_status IN ('suggested', 'confirmed', 'dismissed'));

-- Profile-level destination for recipient copies.
ALTER TABLE vibetb.inbox_routing_profiles ADD COLUMN k1_target_path text NOT NULL DEFAULT 'Income Tax';
ALTER TABLE vibetb.inbox_routing_profiles ADD COLUMN k1_year_behavior text NOT NULL DEFAULT 'current_only';
ALTER TABLE vibetb.inbox_routing_profiles
  ADD CONSTRAINT inbox_routing_profiles_k1_year_behavior_ck
  CHECK (k1_year_behavior IN ('none', 'current_only', 'current_and_next', 'previous'));

-- The recipient copy logs its own row per file, discriminated by action.
ALTER TABLE vibetb.inbox_routing_log
  DROP CONSTRAINT IF EXISTS inbox_routing_log_action_ck;
ALTER TABLE vibetb.inbox_routing_log
  ADD CONSTRAINT inbox_routing_log_action_ck
  CHECK (action IN ('filed', 'tax_flagged', 'skipped', 'failed', 'k1_recipient'));
