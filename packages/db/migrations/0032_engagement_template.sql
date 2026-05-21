-- =====================================================================
-- Migration: 0032_engagement_template.sql
--
-- v2 Sprint D — engagement templates (workstream 3.2). Replaces the
-- read-only JSON starter-pack (seed/engagement-templates.json) with a
-- firm-scoped editable table. Cloning a system template lets firms
-- customize without losing the defaults.
--
-- The engagement-create flow gains a "Start from template" picker that
-- reads these rows and prefills the engagement form.
-- =====================================================================

CREATE TABLE IF NOT EXISTS engagement_template (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID NOT NULL REFERENCES firm(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  engagement_type_id UUID REFERENCES engagement_type(id) ON DELETE SET NULL,
  default_fee_structure fee_structure NOT NULL,
  default_fee_amount_cents BIGINT,
  default_budget_hours NUMERIC(8, 2),
  in_scope_work_code_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  default_letter_template_id UUID,  -- FK added in 0033 after letter table exists
  custom_fields_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_system BOOLEAN NOT NULL DEFAULT false,
  status entity_status NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS engagement_template_firm_key_uk
  ON engagement_template (firm_id, key);

-- Seed the same 8 system templates that ship in seed/engagement-templates.json.
-- Firms inherit them at install; cloning gives them an editable copy.
INSERT INTO engagement_template (
  firm_id, key, name, default_fee_structure, default_fee_amount_cents,
  default_budget_hours, is_system
)
SELECT f.id, t.key, t.name, t.fee_structure::fee_structure,
       t.fee_cents, t.budget_hours, true
FROM firm f
CROSS JOIN (VALUES
  ('individual_1040', 'Individual 1040 Tax Return', 'FIXED_FEE', 75000, 6.0),
  ('1120s_tax_return', '1120-S S-Corp Tax Return', 'FIXED_FEE', 200000, 12.0),
  ('1065_partnership_return', '1065 Partnership Tax Return', 'FIXED_FEE', 250000, 14.0),
  ('audit_gaas', 'Audit (GAAS)', 'HOURLY_NTE', 1500000, 150.0),
  ('review_ssars', 'Review (SSARS)', 'HOURLY_NTE', 500000, 50.0),
  ('compilation_ssars', 'Compilation (SSARS)', 'FIXED_FEE', 200000, 20.0),
  ('monthly_bookkeeping', 'Monthly Bookkeeping', 'RECURRING_SUBSCRIPTION', 50000, 8.0),
  ('payroll_services', 'Payroll Services', 'RECURRING_SUBSCRIPTION', 25000, 4.0)
) AS t(key, name, fee_structure, fee_cents, budget_hours)
ON CONFLICT DO NOTHING;
