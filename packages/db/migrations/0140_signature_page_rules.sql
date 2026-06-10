-- 0140 — Signature Page Rules: per-return-type bookmark patterns that
-- identify the signature page(s) inside a tax-return PDF (the federal 8879,
-- state e-file authorizations, a bundled engagement letter, …).
--
-- Modeled on the Filer routing rules (0137): firm-scoped, ordered, soft
-- enums via text + CHECK. `layout_key` selects the role-tagged field
-- layout placed on a matched page (see packages/core/src/signatures).
-- `form_type` is a return-type key (1040, 1120-S, …, or '*' = any).

CREATE TABLE vibetb.signature_page_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id         uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  form_type       text NOT NULL,
  sort_order      int NOT NULL DEFAULT 0,
  bookmark_pattern text NOT NULL,
  match_mode      text NOT NULL DEFAULT 'contains',
  case_sensitive  boolean NOT NULL DEFAULT false,
  layout_key      text NOT NULL DEFAULT 'generic',
  enabled         boolean NOT NULL DEFAULT true,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT signature_page_rules_match_mode_ck CHECK (match_mode IN ('contains','exact','regex')),
  CONSTRAINT signature_page_rules_layout_ck CHECK (layout_key IN ('us-8879','entity-8879','state-auth','generic'))
);
CREATE INDEX signature_page_rules_firm_idx ON vibetb.signature_page_rules (firm_id, form_type, sort_order);
