-- 0132_template_library_clone_tracking.sql
-- Extend the template-import library to engagement / letter / client / request
-- templates: add cloned_from_slug + cloned_from_pack_version (dedup + audit),
-- mirroring services_catalog / packages / terms_templates (0123).

ALTER TABLE vibetb.engagement_template
  ADD COLUMN IF NOT EXISTS cloned_from_slug text,
  ADD COLUMN IF NOT EXISTS cloned_from_pack_version text;

ALTER TABLE vibetb.engagement_letter_template
  ADD COLUMN IF NOT EXISTS cloned_from_slug text,
  ADD COLUMN IF NOT EXISTS cloned_from_pack_version text;

ALTER TABLE vibetb.client_template
  ADD COLUMN IF NOT EXISTS cloned_from_slug text,
  ADD COLUMN IF NOT EXISTS cloned_from_pack_version text;

ALTER TABLE vibetb.request_template
  ADD COLUMN IF NOT EXISTS cloned_from_slug text,
  ADD COLUMN IF NOT EXISTS cloned_from_pack_version text;
