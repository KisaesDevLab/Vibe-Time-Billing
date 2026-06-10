-- 0141 — Signature Document Library: firm default documents to append to a
-- signing package, segregated by return type (consents, §7216 disclosures,
-- engagement letters, …). Each template is a firm-uploaded PDF stored under
-- the signature-templates/ prefix; `fields` optionally holds saved role-
-- tagged placements (else a default signature+date is used on the last page).

CREATE TABLE vibetb.signature_document_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id       uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  form_type     text NOT NULL,
  name          text NOT NULL,
  storage_key   text NOT NULL,
  total_pages   int NOT NULL DEFAULT 1,
  page_geometry jsonb,
  fields        jsonb,
  auto_include  boolean NOT NULL DEFAULT true,
  enabled       boolean NOT NULL DEFAULT true,
  sort_order    int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signature_document_templates_firm_idx
  ON vibetb.signature_document_templates (firm_id, form_type, sort_order);
