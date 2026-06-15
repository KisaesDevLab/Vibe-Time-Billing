-- =====================================================================
-- Migration: 0162_firm_logo_upload.sql
--
-- Firm logo upload. brand_logo_url already holds the effective wide-logo URL
-- (external or, now, the public branding endpoint). These add bookkeeping for
-- uploaded assets: the wide logo + the square icon source (resized into the
-- PWA/Apple icons), plus a version counter to bust caches on re-upload.
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare statements only. The migrate runner wraps each file in one txn.
-- =====================================================================

ALTER TABLE vibetb.firm_settings
  ADD COLUMN IF NOT EXISTS brand_logo_storage_key text,
  ADD COLUMN IF NOT EXISTS brand_icon_storage_key text,
  ADD COLUMN IF NOT EXISTS brand_assets_version integer NOT NULL DEFAULT 0;
