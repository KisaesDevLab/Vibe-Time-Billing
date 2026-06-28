-- =====================================================================
-- Migration: 0183_invoice_template.sql
--
-- Editable invoice document template (one row per firm). The firm edits
-- a single HTML body + CSS in Admin -> Catalog -> Templates -> Invoice;
-- the invoice renderer composes that body + CSS through the invoice
-- template engine for every surface (staff PDF, portal, pay-by-link,
-- email).
--
-- When `builtin_style` is set (modern|classic|minimal) the legacy
-- hardcoded renderer is used and the custom body/css are ignored. When
-- a firm has no row at all, the renderer uses the shipped default
-- letterhead template, so existing firms get the new design with no
-- backfill required. The first save creates the row.
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.invoice_template (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  body_html text,
  css text,
  variables_json jsonb,
  builtin_style text,
  updated_by_app_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One invoice template per firm.
CREATE UNIQUE INDEX IF NOT EXISTS invoice_template_firm_uk
  ON vibetb.invoice_template (firm_id);
