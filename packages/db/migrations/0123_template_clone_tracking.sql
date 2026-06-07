-- 0123_template_clone_tracking.sql
-- Track which shipped system template (if any) a firm-owned catalog row was
-- cloned from, so the "Import defaults from library" flow is idempotent and we
-- can show an "already imported" indicator. See
-- packages/db/src/seed-helpers/system-templates + apps/api/src/template-library.

ALTER TABLE vibetb.services_catalog
  ADD COLUMN IF NOT EXISTS cloned_from_slug text,
  ADD COLUMN IF NOT EXISTS cloned_from_pack_version text;

ALTER TABLE vibetb.packages
  ADD COLUMN IF NOT EXISTS cloned_from_slug text,
  ADD COLUMN IF NOT EXISTS cloned_from_pack_version text;

ALTER TABLE vibetb.terms_templates
  ADD COLUMN IF NOT EXISTS cloned_from_slug text,
  ADD COLUMN IF NOT EXISTS cloned_from_pack_version text;

-- One import per (firm, source slug). Partial so hand-created rows (NULL slug)
-- are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS services_catalog_firm_cloned_from_uk
  ON vibetb.services_catalog (firm_id, cloned_from_slug)
  WHERE cloned_from_slug IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS packages_firm_cloned_from_uk
  ON vibetb.packages (firm_id, cloned_from_slug)
  WHERE cloned_from_slug IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS terms_templates_firm_cloned_from_uk
  ON vibetb.terms_templates (firm_id, cloned_from_slug)
  WHERE cloned_from_slug IS NOT NULL;
