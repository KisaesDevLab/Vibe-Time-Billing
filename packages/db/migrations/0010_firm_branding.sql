-- =====================================================================
-- Migration: 0010_firm_branding.sql
--
-- Per-firm branding settings (Phase 4 #13). Added to firm_settings since
-- a firm only ever has one set of branding values. Used by invoice PDFs
-- and portal pages.
-- =====================================================================

ALTER TABLE firm_settings
  ADD COLUMN IF NOT EXISTS brand_display_name  TEXT,
  ADD COLUMN IF NOT EXISTS brand_logo_url      TEXT,
  ADD COLUMN IF NOT EXISTS brand_accent_color  TEXT,
  ADD COLUMN IF NOT EXISTS brand_support_email TEXT,
  ADD COLUMN IF NOT EXISTS brand_support_phone TEXT,
  ADD COLUMN IF NOT EXISTS brand_footer_html   TEXT;
