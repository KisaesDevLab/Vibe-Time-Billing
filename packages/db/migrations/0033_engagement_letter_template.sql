-- =====================================================================
-- Migration: 0033_engagement_letter_template.sql
--
-- v2 Sprint D — engagement letter template library (workstream 3.3).
-- Replaces the markdown files under seed/engagement-letters/ with
-- firm-editable rows. Variables are Handlebars-style ({{client.name}}).
-- The engagement-detail "Generate letter" picker reads these rows,
-- substitutes vars, and inserts a DRAFT row in engagement_letter
-- (existing endpoint).
--
-- Also adds the deferred FK from engagement_template.default_letter_template_id.
-- =====================================================================

CREATE TABLE IF NOT EXISTS engagement_letter_template (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID NOT NULL REFERENCES firm(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  engagement_type_id UUID REFERENCES engagement_type(id) ON DELETE SET NULL,
  body_html TEXT NOT NULL,
  variables_json JSONB,
  is_system BOOLEAN NOT NULL DEFAULT false,
  status entity_status NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS engagement_letter_template_firm_key_uk
  ON engagement_letter_template (firm_id, key);

-- Seed 4 starter letter templates per firm. Real firm-letter language
-- lives in seed/engagement-letters/*.md; for the v2 first cut we ship
-- short placeholder bodies so admins have a working starting point.
INSERT INTO engagement_letter_template (firm_id, key, name, body_html, is_system)
SELECT f.id, t.key, t.name, t.body, true
FROM firm f
CROSS JOIN (VALUES
  ('el_individual_1040', 'Individual 1040',
   '<h1>Engagement letter — Individual 1040</h1><p>This letter confirms our engagement to prepare {{client.name}}''s {{engagement.tax_year}} federal and state individual income tax returns.</p><p>Scope: {{engagement.name}}. Fee: {{engagement.fee}}.</p><p>Sign below to accept.</p>'),
  ('el_1120s', '1120-S',
   '<h1>Engagement letter — 1120-S</h1><p>This letter confirms our engagement to prepare {{client.name}}''s {{engagement.tax_year}} federal Form 1120-S and applicable state returns.</p><p>Fee: {{engagement.fee}}.</p>'),
  ('el_monthly_bookkeeping', 'Monthly Bookkeeping',
   '<h1>Engagement letter — Monthly Bookkeeping</h1><p>This letter confirms our engagement to provide monthly bookkeeping services to {{client.name}}.</p><p>Monthly fee: {{engagement.fee}}. Renews automatically until canceled.</p>'),
  ('el_audit_gaas', 'Audit (GAAS)',
   '<h1>Engagement letter — Audit (GAAS)</h1><p>This letter confirms our engagement to audit the financial statements of {{client.name}} for the year ended {{engagement.fye_date}}.</p><p>Estimated fee: {{engagement.fee}}.</p>')
) AS t(key, name, body)
ON CONFLICT DO NOTHING;

-- Deferred FK from engagement_template (0032).
ALTER TABLE engagement_template
  ADD CONSTRAINT engagement_template_default_letter_fk
    FOREIGN KEY (default_letter_template_id)
    REFERENCES engagement_letter_template(id)
    ON DELETE SET NULL;
