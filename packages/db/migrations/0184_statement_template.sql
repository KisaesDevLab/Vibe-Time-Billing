-- =====================================================================
-- Migration: 0184_statement_template.sql
--
-- Editable statement-of-account document template (one row per firm),
-- the statement counterpart to invoice_template (0183). The firm edits a
-- single HTML body + CSS in Admin -> Catalog -> Templates -> Statement;
-- the statement renderer composes that body + CSS through the template
-- engine for every surface (single PDF, bulk-generate, bulk-email).
--
-- When `builtin_style` is set the legacy hardcoded renderer is used and
-- the custom body/css are ignored. No row → shipped default template, so
-- existing firms get the new design with no backfill. First save creates
-- the row.
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.statement_template (
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

CREATE UNIQUE INDEX IF NOT EXISTS statement_template_firm_uk
  ON vibetb.statement_template (firm_id);
