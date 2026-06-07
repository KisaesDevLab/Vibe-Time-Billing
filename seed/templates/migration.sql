-- =============================================================================
-- Migration: 0XXX_system_template_library.sql
-- Vibe Time & Billing — System Template Library Tables
-- =============================================================================
-- These tables hold the system-shipped starter templates. They are read-only
-- to firms; firms clone selected templates into their own catalog (services_catalog,
-- packages, terms_templates) on the firm-side Templates Library import flow.
--
-- All system templates are keyed on a stable `slug` so we can ship updates
-- via ON CONFLICT (slug) DO UPDATE without disturbing firm-owned clones.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Service categories metadata
-- -----------------------------------------------------------------------------
-- The category ENUM is constrained at the application layer (build plan P01).
-- This table holds the display metadata.

CREATE TABLE IF NOT EXISTS system_service_categories (
  slug                 TEXT PRIMARY KEY,
  display_name         TEXT NOT NULL,
  short_description    TEXT NOT NULL,
  default_coa_code     TEXT NOT NULL,
  default_coa_label    TEXT NOT NULL,
  icon_hint            TEXT NOT NULL,
  position             INTEGER NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT system_service_categories_slug_chk CHECK (
    slug IN ('TAX', 'BOOKKEEPING', 'AUDIT', 'ADVISORY', 'PAYROLL', 'CFO')
  )
);

-- -----------------------------------------------------------------------------
-- System service templates
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS system_service_templates (
  slug                          TEXT PRIMARY KEY,
  category                      TEXT NOT NULL REFERENCES system_service_categories(slug),
  name                          TEXT NOT NULL,
  description_md                TEXT NOT NULL,
  billing_type                  TEXT NOT NULL,
  recurring_interval            TEXT,
  default_price_cents           BIGINT NOT NULL,
  suggested_price_low_cents     BIGINT NOT NULL,
  suggested_price_high_cents    BIGINT NOT NULL,
  is_addon                      BOOLEAN NOT NULL DEFAULT FALSE,
  tags                          TEXT[] NOT NULL DEFAULT '{}',
  import_notes                  TEXT,
  pack_version                  TEXT NOT NULL,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT system_services_billing_type_chk CHECK (
    billing_type IN ('on_acceptance', 'on_completion', 'recurring', 'variable', 'hourly')
  ),
  CONSTRAINT system_services_recurring_interval_chk CHECK (
    recurring_interval IS NULL
    OR recurring_interval IN ('weekly', 'monthly', 'quarterly', 'semi_annual', 'annual')
  ),
  CONSTRAINT system_services_price_range_chk CHECK (
    suggested_price_low_cents <= suggested_price_high_cents
  )
);

CREATE INDEX IF NOT EXISTS idx_system_services_category
  ON system_service_templates(category);
CREATE INDEX IF NOT EXISTS idx_system_services_tags
  ON system_service_templates USING GIN (tags);

-- -----------------------------------------------------------------------------
-- System package templates (3 normalized tables)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS system_package_templates (
  slug                  TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  primary_category      TEXT NOT NULL REFERENCES system_service_categories(slug),
  description_md        TEXT NOT NULL,
  format                TEXT NOT NULL,
  niche_tag             TEXT,
  tags                  TEXT[] NOT NULL DEFAULT '{}',
  import_notes          TEXT NOT NULL,
  pack_version          TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT system_packages_format_chk CHECK (format IN ('duo', 'tiered'))
);

CREATE INDEX IF NOT EXISTS idx_system_packages_category
  ON system_package_templates(primary_category);
CREATE INDEX IF NOT EXISTS idx_system_packages_tags
  ON system_package_templates USING GIN (tags);

CREATE TABLE IF NOT EXISTS system_package_template_tiers (
  id                    BIGSERIAL PRIMARY KEY,
  package_slug          TEXT NOT NULL REFERENCES system_package_templates(slug)
                          ON DELETE CASCADE,
  tier_slug             TEXT NOT NULL,
  name                  TEXT NOT NULL,
  tagline               TEXT NOT NULL,
  position              INTEGER NOT NULL,
  UNIQUE (package_slug, tier_slug)
);

CREATE INDEX IF NOT EXISTS idx_system_package_tiers_package
  ON system_package_template_tiers(package_slug, position);

CREATE TABLE IF NOT EXISTS system_package_template_items (
  id                    BIGSERIAL PRIMARY KEY,
  package_slug          TEXT NOT NULL REFERENCES system_package_templates(slug)
                          ON DELETE CASCADE,
  position              INTEGER NOT NULL,
  section               TEXT NOT NULL,
  item_type             TEXT NOT NULL,
  label                 TEXT NOT NULL,
  service_slug          TEXT REFERENCES system_service_templates(slug)
                          ON DELETE SET NULL,
  -- Per-tier values stored as JSONB: { "<tier_slug>": "<display value>", ... }
  tier_values           JSONB NOT NULL,
  CONSTRAINT system_package_items_section_chk CHECK (
    section IN ('core_deliverables', 'service_levels', 'support_and_access', 'optional_addons')
  ),
  CONSTRAINT system_package_items_type_chk CHECK (
    item_type IN ('service', 'experience')
  ),
  CONSTRAINT system_package_items_service_required_chk CHECK (
    (item_type = 'experience' AND service_slug IS NULL)
    OR (item_type = 'service'  AND service_slug IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_system_package_items_package
  ON system_package_template_items(package_slug, position);

-- -----------------------------------------------------------------------------
-- System terms (engagement-letter) templates
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS system_terms_templates (
  slug                    TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  primary_category        TEXT NOT NULL REFERENCES system_service_categories(slug),
  body_md                 TEXT NOT NULL,
  source                  TEXT NOT NULL,
  standards_referenced    TEXT[] NOT NULL DEFAULT '{}',
  import_notes            TEXT NOT NULL,
  pack_version            TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT system_terms_source_chk CHECK (
    source IN ('aicpa_aligned', 'industry_generic', 'custom')
  )
);

CREATE INDEX IF NOT EXISTS idx_system_terms_category
  ON system_terms_templates(primary_category);

-- -----------------------------------------------------------------------------
-- System email templates
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS system_email_templates (
  slug              TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,
  subject           TEXT NOT NULL,
  body_md           TEXT NOT NULL,
  plain_text_body   TEXT,
  pack_version      TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT system_emails_kind_chk CHECK (
    kind IN (
      'proposal_sent',
      'proposal_reminder_view',
      'proposal_reminder_sign',
      'proposal_accepted',
      'proposal_expired',
      'engagement_welcome',
      'invoice_receipt',
      'payment_failed',
      'mandate_invalid',
      'renewal_upcoming'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_system_emails_kind
  ON system_email_templates(kind);

-- -----------------------------------------------------------------------------
-- Pack manifest (for tracking which version of the library is loaded)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS system_template_pack_manifest (
  id                              SERIAL PRIMARY KEY,
  pack_version                    TEXT NOT NULL,
  shipped_with_appliance_version  TEXT NOT NULL,
  generated_at                    TIMESTAMPTZ NOT NULL,
  loaded_at                       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  counts                          JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pack_manifest_loaded
  ON system_template_pack_manifest(loaded_at DESC);

-- -----------------------------------------------------------------------------
-- Firm-side "cloned_from_slug" audit columns
-- -----------------------------------------------------------------------------
-- The firm-owned tables (services_catalog, packages, terms_templates) already
-- exist per P01 of the addendum build plan. We add a nullable column to track
-- which system template, if any, a firm-owned row was originally cloned from.
-- This enables future features like "see updates available for this template."

ALTER TABLE services_catalog
  ADD COLUMN IF NOT EXISTS cloned_from_slug TEXT,
  ADD COLUMN IF NOT EXISTS cloned_from_pack_version TEXT;

ALTER TABLE packages
  ADD COLUMN IF NOT EXISTS cloned_from_slug TEXT,
  ADD COLUMN IF NOT EXISTS cloned_from_pack_version TEXT;

ALTER TABLE terms_templates
  ADD COLUMN IF NOT EXISTS cloned_from_slug TEXT,
  ADD COLUMN IF NOT EXISTS cloned_from_pack_version TEXT;

CREATE INDEX IF NOT EXISTS idx_services_cloned_from
  ON services_catalog(cloned_from_slug)
  WHERE cloned_from_slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_packages_cloned_from
  ON packages(cloned_from_slug)
  WHERE cloned_from_slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_terms_cloned_from
  ON terms_templates(cloned_from_slug)
  WHERE cloned_from_slug IS NOT NULL;
