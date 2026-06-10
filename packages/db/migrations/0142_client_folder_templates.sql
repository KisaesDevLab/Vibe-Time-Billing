-- 0142 — client folder structure templates.
--
-- A firm defines one or more named folder skeletons (Correspondence, Income
-- Tax, Payroll, …). One template is the firm default. Templates are applied
-- as a *virtual* skeleton: the Explorer shows a client's template folders
-- under its root even when empty — no per-client folder rows or B2 markers.
-- A client may be assigned a specific template (else the firm default).

CREATE TABLE vibetb.client_folder_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id     uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  name        text NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- At most one default template per firm.
CREATE UNIQUE INDEX client_folder_templates_firm_default_uk
  ON vibetb.client_folder_templates (firm_id) WHERE is_default;
CREATE INDEX client_folder_templates_firm_idx
  ON vibetb.client_folder_templates (firm_id);

CREATE TABLE vibetb.client_folder_template_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES vibetb.client_folder_templates(id) ON DELETE CASCADE,
  name        text NOT NULL,
  sort_order  int NOT NULL DEFAULT 0,
  visibility  text CHECK (visibility IS NULL OR visibility IN ('private','client_visible')),
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX client_folder_template_items_template_idx
  ON vibetb.client_folder_template_items (template_id, sort_order);

-- Per-client template override (NULL → firm default).
ALTER TABLE vibetb.client
  ADD COLUMN folder_template_id uuid REFERENCES vibetb.client_folder_templates(id) ON DELETE SET NULL;
