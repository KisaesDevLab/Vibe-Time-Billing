-- =====================================================================
-- Down migration: 0074_proposal_module.down.sql
--
-- Reverses 0074_proposal_module.sql. Drops every table + enum created
-- in the forward migration and removes the columns added to the
-- existing engagement table. Order matters: tables with FKs onto
-- others go first; the engagement column FK is dropped before the
-- proposals table; enums go last.
--
-- This file is NOT auto-applied by migrate.ts. Operators invoke it
-- manually for the addendum P01 acceptance criterion
-- (`migrate up && migrate down && migrate up` clean on empty DB).
-- =====================================================================

-- Drop the constraint that points proposals.renewed_from_engagement_id
-- at engagement BEFORE dropping the engagement columns, otherwise the
-- ALTER below complains.
ALTER TABLE vibetb.proposals
  DROP CONSTRAINT IF EXISTS proposals_renewed_from_engagement_fk;

-- Engagement column extensions (added by forward §19).
ALTER TABLE vibetb.engagement
  DROP COLUMN IF EXISTS from_proposal_id,
  DROP COLUMN IF EXISTS renewed_from_engagement_id;

-- Tables — drop in reverse-FK-dependency order so CASCADE doesn't get
-- creative. proposal_activity / proposal_section_views / signatures
-- / payment_mandates all FK onto proposals; engagement_scope FKs onto
-- proposal_versions; stripe_* FKs onto engagement (already disposed
-- of from this surface).

DROP TABLE IF EXISTS vibetb.renewals;
DROP TABLE IF EXISTS vibetb.quick_bill_line_items;
DROP TABLE IF EXISTS vibetb.quick_bills;
DROP TABLE IF EXISTS vibetb.proposal_section_views;
DROP TABLE IF EXISTS vibetb.proposal_activity;
DROP TABLE IF EXISTS vibetb.stripe_invoices;
DROP TABLE IF EXISTS vibetb.stripe_subscriptions;
DROP TABLE IF EXISTS vibetb.stripe_customers;
DROP TABLE IF EXISTS vibetb.engagement_deliverables;
DROP TABLE IF EXISTS vibetb.engagement_scope;
DROP TABLE IF EXISTS vibetb.client_accounts;
DROP TABLE IF EXISTS vibetb.magic_links;
DROP TABLE IF EXISTS vibetb.webhook_events;
DROP TABLE IF EXISTS vibetb.payment_mandates;
DROP TABLE IF EXISTS vibetb.signatures;
DROP TABLE IF EXISTS vibetb.proposal_terms_snapshot;
DROP TABLE IF EXISTS vibetb.proposal_packages;
DROP TABLE IF EXISTS vibetb.proposal_line_items;
DROP TABLE IF EXISTS vibetb.proposal_versions;
DROP TABLE IF EXISTS vibetb.proposals;
DROP TABLE IF EXISTS vibetb.firm_settings_proposals;
DROP TABLE IF EXISTS vibetb.terms_templates;
DROP TABLE IF EXISTS vibetb.package_services;
DROP TABLE IF EXISTS vibetb.packages;
DROP TABLE IF EXISTS vibetb.service_tag_assignments;
DROP TABLE IF EXISTS vibetb.service_tags;
DROP TABLE IF EXISTS vibetb.services_catalog;

-- Enums.
DROP TYPE IF EXISTS engagement_deliverable_state;
DROP TYPE IF EXISTS uplift_mode;
DROP TYPE IF EXISTS renewal_state;
DROP TYPE IF EXISTS quick_bill_state;
DROP TYPE IF EXISTS proposal_activity_kind;
DROP TYPE IF EXISTS magic_link_purpose;
DROP TYPE IF EXISTS webhook_event_state;
DROP TYPE IF EXISTS payment_mandate_state;
DROP TYPE IF EXISTS payment_mandate_kind;
DROP TYPE IF EXISTS signature_state;
DROP TYPE IF EXISTS signature_method;
DROP TYPE IF EXISTS signature_role;
DROP TYPE IF EXISTS proposal_recurring_interval;
DROP TYPE IF EXISTS proposal_billing_type;
DROP TYPE IF EXISTS service_category;
DROP TYPE IF EXISTS proposal_status;

-- Bookkeeping: remove the schema_migrations row so a re-apply will
-- run the forward migration again.
DELETE FROM schema_migrations WHERE filename = '0074_proposal_module.sql';
