-- =====================================================================
-- Migration: 0190_letter_page_margin.sql
--
-- Per-template page margin for mail-merge letters. A CSS length value
-- (e.g. '1in', or per-side '1in 0.75in') injected as the letter's
-- `@page { margin }` at render time. NULL = the 1in default.
-- =====================================================================

ALTER TABLE vibetb.engagement_letter_template
  ADD COLUMN IF NOT EXISTS page_margin text;
