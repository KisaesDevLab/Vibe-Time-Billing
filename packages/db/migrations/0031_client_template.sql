-- =====================================================================
-- Migration: 0031_client_template.sql
--
-- v2 Sprint D — client templates (workstream 1.8). Lets the Create
-- Client wizard offer one-click prefills for common client shapes
-- (Individual 1040, Small Business S-corp, Bookkeeping, Nonprofit).
--
-- defaults_json holds wizard prefill values keyed by field name:
--   { "clientType": "INDIVIDUAL", "filingStatus": "MFJ",
--     "termsDays": 30, "tags": ["tax-return"] }
-- default_engagement_template_ids points at engagement_template rows
-- so picking a client template can also queue an engagement spinup.
-- =====================================================================

CREATE TABLE IF NOT EXISTS client_template (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID NOT NULL REFERENCES firm(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  client_type client_type NOT NULL,
  defaults_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  default_engagement_template_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_system BOOLEAN NOT NULL DEFAULT false,
  status entity_status NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS client_template_firm_key_uk
  ON client_template (firm_id, key);

-- Seed 4 system templates per existing firm.
INSERT INTO client_template (firm_id, key, name, client_type, defaults_json, is_system)
SELECT f.id, t.key, t.name, t.client_type::client_type, t.defaults_json::jsonb, true
FROM firm f
CROSS JOIN (VALUES
  ('individual_1040', 'Individual 1040', 'INDIVIDUAL',
   '{"termsDays": 30, "pipelineStage": "CLIENT", "tags": ["1040", "individual"]}'),
  ('small_business_scorp', 'Small Business (S-corp)', 'BUSINESS',
   '{"termsDays": 30, "pipelineStage": "CLIENT", "tags": ["1120s", "scorp"]}'),
  ('bookkeeping_client', 'Bookkeeping Client', 'BUSINESS',
   '{"termsDays": 15, "invoiceConsolidationPreference": "CONSOLIDATED", "pipelineStage": "CLIENT", "tags": ["bookkeeping", "monthly"]}'),
  ('nonprofit', 'Nonprofit', 'BUSINESS',
   '{"termsDays": 45, "pipelineStage": "CLIENT", "tags": ["990", "nonprofit"]}')
) AS t(key, name, client_type, defaults_json)
ON CONFLICT DO NOTHING;
