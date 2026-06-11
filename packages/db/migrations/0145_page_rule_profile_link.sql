-- =====================================================================
-- Migration: 0145_page_rule_profile_link.sql
--
-- Let a signature page rule reference a firm PLACEMENT PROFILE (by its
-- form_type; the latest version resolves at package-build time) instead
-- of only the four hard-coded layout keys. NULL keeps today's behavior
-- (layout_key picks a built-in layout). No FK: profiles are versioned
-- rows keyed by (firm_id, form_type, version) and a rule should follow
-- the firm's latest calibration, not pin one row.
--
-- NOTE: bare IF NOT EXISTS only (the pglite test harness strips DO $$ … $$).
-- =====================================================================

ALTER TABLE vibetb.signature_page_rules
  ADD COLUMN IF NOT EXISTS profile_form_type text;
