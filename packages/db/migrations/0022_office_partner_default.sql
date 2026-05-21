-- =====================================================================
-- Migration: 0022_office_partner_default.sql
--
-- Office-level partner-in-charge default (Phase 4 #14). When set,
-- clients created with that office implicit (e.g. from bulk import)
-- inherit this user as partner_in_charge_id. Independent of the FK
-- on app_user; we don't cascade because deleting the user shouldn't
-- silently break the default.
-- =====================================================================

ALTER TABLE office
  ADD COLUMN IF NOT EXISTS default_partner_in_charge_id UUID
    REFERENCES app_user(id) ON DELETE SET NULL;
