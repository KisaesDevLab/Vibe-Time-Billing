-- Re-lock categories to the service_category enum. Values outside the
-- enum can't survive the cast — coerce them to ADVISORY first (lossy;
-- forward data with firm-defined categories has no exact enum home).
ALTER TABLE vibetb.services_catalog
  DROP CONSTRAINT IF EXISTS services_catalog_category_nonempty_ck;
UPDATE vibetb.services_catalog SET category = 'ADVISORY'
WHERE category NOT IN ('TAX', 'BOOKKEEPING', 'AUDIT', 'ADVISORY', 'PAYROLL', 'CFO');
ALTER TABLE vibetb.services_catalog
  ALTER COLUMN category TYPE vibetb.service_category
  USING category::vibetb.service_category;

ALTER TABLE vibetb.terms_templates
  DROP CONSTRAINT IF EXISTS terms_templates_category_nonempty_ck;
UPDATE vibetb.terms_templates SET category = 'ADVISORY'
WHERE category NOT IN ('TAX', 'BOOKKEEPING', 'AUDIT', 'ADVISORY', 'PAYROLL', 'CFO');
ALTER TABLE vibetb.terms_templates
  ALTER COLUMN category TYPE vibetb.service_category
  USING category::vibetb.service_category;
