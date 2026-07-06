-- =====================================================================
-- Migration: 0187_signature_print_rules.sql
--
-- Configurable auto-print rules for signature confirmations. Each rule
-- defines a trigger (form codes + engagement types), a template source
-- (built-in report or a Vibe Print gateway template), and a printer
-- (specific id or the client office's assigned printer). First enabled
-- rule (priority asc) whose filters match a completed tax-return
-- signature wins. Empty filter array = match any.
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.signature_print_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  name text NOT NULL,
  priority integer NOT NULL DEFAULT 100,
  enabled boolean NOT NULL DEFAULT true,
  form_codes text[] NOT NULL DEFAULT '{}',
  engagement_type_ids uuid[] NOT NULL DEFAULT '{}',
  template_source text NOT NULL DEFAULT 'builtin',
  gateway_template_id integer,
  printer_mode text NOT NULL DEFAULT 'specific',
  printer_id integer,
  copies integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signature_print_rule_firm_priority_idx
  ON vibetb.signature_print_rule (firm_id, priority);
