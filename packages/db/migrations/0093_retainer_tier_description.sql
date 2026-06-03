-- =====================================================================
-- Migration: 0093_retainer_tier_description.sql
--
-- Per-tier marketing/scoping copy. Surfaces on the portal retainer
-- offer card and on the admin tier configuration page so partners can
-- explain what each tier covers in their own words (without having to
-- bake it into the tier name).
-- =====================================================================

ALTER TABLE vibetb.retainer_tier_config
  ADD COLUMN IF NOT EXISTS description text;
