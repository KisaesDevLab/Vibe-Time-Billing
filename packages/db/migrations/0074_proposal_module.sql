-- =====================================================================
-- Migration: 0074_proposal_module.sql  (Phase P01)
--
-- Proposal Module schema groundwork — implements every table required
-- by `ADDENDUM-PROPOSAL-MODULE.md` §P01 in one structural drop. No
-- business logic, no API, no UI. Subsequent phases (P02 → P30) layer
-- features on top of this foundation.
--
-- Locked decisions captured (see QUESTIONS.md Q34–Q37):
--   • signatures is a PLURAL table — no inline signature_* columns
--     on proposal. Schema supports multi-signer; UI ships single-signer.
--   • OpenSign integration is a sidecar reached over the network.
--     Tables hold envelope / certificate references only.
--   • Stripe Connect Standard (not Setup Intents on a firm-owned key).
--     The firm onboards Stripe via OAuth; we store stripe_account_id.
--   • No CSV import / no QBO sync in v1.
--
-- Tables created (27 total):
--   services_catalog               • service_tags / service_tag_assignments
--   packages / package_services
--   proposals                      • proposal_versions
--   proposal_line_items            • proposal_packages
--   proposal_terms_snapshot
--   terms_templates
--   signatures                     • payment_mandates
--   webhook_events                 • magic_links
--   client_accounts
--   engagement_scope               • engagement_deliverables
--   stripe_customers / stripe_subscriptions / stripe_invoices
--   proposal_activity              • proposal_section_views
--   firm_settings_proposals
--   quick_bills / quick_bill_line_items
--   renewals
--
-- Columns added to existing engagement:
--   from_proposal_id (FK proposals)         — engagement born from
--                                             accepted proposal
--   renewed_from_engagement_id (FK self)    — set on renewals
--
-- Down-migration script lives at 0074_proposal_module.down.sql for the
-- P01 acceptance criterion (`migrate up && down && up` clean on empty
-- DB). The forward migration is idempotent in the sense that all
-- CREATE TYPE / CREATE TABLE statements would fail on re-application
-- without dropping the old objects first — the migrate.ts runner
-- gates by schema_migrations bookkeeping, so re-apply isn't possible.
-- =====================================================================

-- --- (1) enums ------------------------------------------------------

CREATE TYPE proposal_status AS ENUM (
  'DRAFT',
  'SENT',
  'VIEWED',
  'IN_PROGRESS',
  'ACCEPTED',
  'DECLINED',
  'EXPIRED',
  'CANCELLED',
  'COUNTERED'
);

CREATE TYPE service_category AS ENUM (
  'TAX',
  'BOOKKEEPING',
  'AUDIT',
  'ADVISORY',
  'PAYROLL',
  'CFO'
);

CREATE TYPE proposal_billing_type AS ENUM (
  'ONE_TIME',
  'RECURRING',
  'ON_COMPLETION',
  'SPLIT_DEPOSIT_RECURRING'
);

CREATE TYPE proposal_recurring_interval AS ENUM (
  'MONTHLY',
  'QUARTERLY',
  'SEMIANNUALLY',
  'ANNUALLY'
);

CREATE TYPE signature_role AS ENUM (
  'PRIMARY',
  'COSIGNER',
  'WITNESS'
);

CREATE TYPE signature_method AS ENUM (
  'TYPED_NAME',
  'DRAWN_SVG',
  'OPENSIGN'
);

CREATE TYPE signature_state AS ENUM (
  'PENDING',
  'SIGNED',
  'DECLINED'
);

CREATE TYPE payment_mandate_kind AS ENUM (
  'CARD',
  'ACH',
  'LINK',
  'WALLET'
);

CREATE TYPE payment_mandate_state AS ENUM (
  'PENDING_VERIFICATION',
  'ACTIVE',
  'INVALID',
  'REVOKED'
);

CREATE TYPE webhook_event_state AS ENUM (
  'PENDING',
  'PROCESSED',
  'FAILED',
  'IGNORED'
);

CREATE TYPE magic_link_purpose AS ENUM (
  'PROPOSAL',
  'ENGAGEMENT',
  'PASSWORD_RESET',
  'INVOICE'
);

CREATE TYPE proposal_activity_kind AS ENUM (
  'CREATED',
  'SENT',
  'OPENED',
  'SECTION_VIEWED',
  'TIER_SELECTED',
  'SIGNATURE_STARTED',
  'SIGNATURE_COMPLETED',
  'PAYMENT_STARTED',
  'PAYMENT_COMPLETED',
  'ACCEPTED',
  'DECLINED',
  'EXPIRED',
  'CANCELLED',
  'COUNTERED'
);

CREATE TYPE quick_bill_state AS ENUM (
  'DRAFT',
  'SENT',
  'PAID',
  'VOID'
);

CREATE TYPE renewal_state AS ENUM (
  'CANDIDATE',
  'PROPOSED',
  'ACCEPTED',
  'DECLINED',
  'LAPSED'
);

CREATE TYPE uplift_mode AS ENUM (
  'MANUAL_PERCENT',
  'REALIZATION_BASED',
  'CPI_INDEXED'
);

CREATE TYPE engagement_deliverable_state AS ENUM (
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED'
);

-- --- (2) services catalog + tags -----------------------------------
--
-- Flat service list per firm. Categories are hard-coded to 6 values
-- (§0.1 decision). Tags are firm-defined and m2m via assignments.
-- Soft delete via archived_at; services in use by an active proposal
-- or engagement_scope row cannot be hard-deleted (enforced by P02
-- route logic, not DB).

CREATE TABLE vibetb.services_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  category service_category NOT NULL,
  default_price_cents bigint NOT NULL DEFAULT 0,
  billing_type proposal_billing_type NOT NULL DEFAULT 'ONE_TIME',
  recurring_interval proposal_recurring_interval,
  is_addon boolean NOT NULL DEFAULT false,
  parent_service_id uuid REFERENCES vibetb.services_catalog(id) ON DELETE SET NULL,
  coa_code text,
  archived_at timestamptz,
  created_by_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT services_catalog_price_nonneg CHECK (default_price_cents >= 0),
  CONSTRAINT services_catalog_recurring_consistency CHECK (
    (billing_type IN ('RECURRING', 'SPLIT_DEPOSIT_RECURRING') AND recurring_interval IS NOT NULL)
    OR (billing_type NOT IN ('RECURRING', 'SPLIT_DEPOSIT_RECURRING') AND recurring_interval IS NULL)
  )
);

CREATE INDEX services_catalog_firm_category_idx
  ON vibetb.services_catalog (firm_id, category)
  WHERE archived_at IS NULL;
CREATE INDEX services_catalog_parent_idx
  ON vibetb.services_catalog (parent_service_id)
  WHERE parent_service_id IS NOT NULL;

CREATE TABLE vibetb.service_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX service_tags_firm_name_uk
  ON vibetb.service_tags (firm_id, lower(name));

CREATE TABLE vibetb.service_tag_assignments (
  service_id uuid NOT NULL REFERENCES vibetb.services_catalog(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES vibetb.service_tags(id) ON DELETE CASCADE,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (service_id, tag_id)
);

-- --- (3) packages (Bronze/Silver/Gold) -----------------------------
--
-- A package is a reusable bundle of services with optional per-tier
-- price overrides. Proposals reference packages via proposal_packages
-- (junction). package_services is the inclusion map.

CREATE TABLE vibetb.packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  name text NOT NULL,
  -- Free-text tier label (defaults to Bronze/Silver/Gold but firm
  -- can rename to "Starter / Pro / Premier" etc.). NOT an enum to
  -- avoid migration churn when firms rename.
  tier_label text NOT NULL DEFAULT 'Standard',
  position integer NOT NULL DEFAULT 0,
  description text NOT NULL DEFAULT '',
  archived_at timestamptz,
  created_by_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX packages_firm_position_idx
  ON vibetb.packages (firm_id, position)
  WHERE archived_at IS NULL;

CREATE TABLE vibetb.package_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id uuid NOT NULL REFERENCES vibetb.packages(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES vibetb.services_catalog(id) ON DELETE RESTRICT,
  -- NULL = use service's default_price_cents
  override_price_cents bigint,
  -- included = this service is part of the tier; otherwise it is
  -- offered as an add-on within the package context.
  included boolean NOT NULL DEFAULT true,
  sequence integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT package_services_override_nonneg CHECK (
    override_price_cents IS NULL OR override_price_cents >= 0
  )
);

CREATE UNIQUE INDEX package_services_pkg_svc_uk
  ON vibetb.package_services (package_id, service_id);
CREATE INDEX package_services_pkg_seq_idx
  ON vibetb.package_services (package_id, sequence);

-- --- (4) terms templates -------------------------------------------
--
-- Markdown engagement-letter templates per category. version
-- increments on every save. is_default flags the category default
-- (at most one per (firm, category) — enforced application-side and
-- via a partial unique index).

CREATE TABLE vibetb.terms_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  category service_category NOT NULL,
  name text NOT NULL,
  content_md text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1,
  is_default boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_by_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT terms_templates_version_positive CHECK (version > 0)
);

CREATE INDEX terms_templates_firm_category_idx
  ON vibetb.terms_templates (firm_id, category)
  WHERE archived_at IS NULL;
CREATE UNIQUE INDEX terms_templates_firm_category_default_uk
  ON vibetb.terms_templates (firm_id, category)
  WHERE is_default = true AND archived_at IS NULL;

-- --- (5) firm settings (proposal module) ---------------------------
--
-- Per-firm Stripe / branding / portal config keyed on firm_id. One
-- row per firm. hmac_secret_encrypted holds the per-firm signature
-- HMAC key (P16) wrapped by the appliance master key.

CREATE TABLE vibetb.firm_settings_proposals (
  firm_id uuid PRIMARY KEY REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  stripe_account_id text,
  stripe_publishable_key text,
  stripe_account_capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  stripe_connected_at timestamptz,
  stripe_disconnected_at timestamptz,

  -- Per-firm HMAC key for signature tamper-evidence (P16). Stored
  -- encrypted by the appliance master key (`@vibe/crypto`). NULL
  -- until first proposal is sent.
  hmac_secret_encrypted bytea,

  branding_logo_url text,
  branding_primary_color text,
  branding_accent_color text,

  -- Custom CNAME for portal domain (P19). NULL = use appliance
  -- default subdomain. verified_at gates Caddy's `caddy-ask` check.
  custom_domain text,
  custom_domain_verified_at timestamptz,

  -- Notification config (which events trigger which channel).
  -- Schema defined per template in P26/P27 — held as opaque JSON
  -- so we don't migrate every time a new template lands.
  notifications_config jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX firm_settings_proposals_custom_domain_uk
  ON vibetb.firm_settings_proposals (lower(custom_domain))
  WHERE custom_domain IS NOT NULL;

-- --- (6) proposals + versions --------------------------------------
--
-- The proposal table holds the working draft. The block-tree content
-- lives in brochure_jsonb (P04 visual editor). On send/accept, a
-- snapshot row lands in proposal_versions with a SHA-256 content hash
-- so the firm cannot retroactively alter what the client saw.

CREATE TABLE vibetb.proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES vibetb.client(id) ON DELETE RESTRICT,
  status proposal_status NOT NULL DEFAULT 'DRAFT',
  title text NOT NULL,
  -- Block-tree authoring data (P04). Opaque on the DB side; the API
  -- knows the block schema.
  brochure_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Sum of accepted-tier + accepted line items, materialized on
  -- save for dashboard queries. Recomputed from line_items on
  -- every edit.
  total_one_time_cents bigint NOT NULL DEFAULT 0,
  total_recurring_cents bigint NOT NULL DEFAULT 0,
  recurring_interval proposal_recurring_interval,

  -- Lifecycle timestamps. sent_at and accepted_at are the contractual
  -- moments; the addendum requires expires_at to be after sent_at.
  sent_at timestamptz,
  expires_at timestamptz,
  first_viewed_at timestamptz,
  accepted_at timestamptz,
  declined_at timestamptz,
  declined_reason text,
  countered_at timestamptz,
  countered_note text,
  cancelled_at timestamptz,
  cancelled_by_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,

  -- Renewal linkage (set when this proposal is generated by P25).
  renewed_from_engagement_id uuid,

  -- Block-tree autosave version counter (P04 #8). Bumps on every
  -- structural save. Distinct from proposal_versions.version which
  -- only bumps on send/accept.
  draft_revision integer NOT NULL DEFAULT 0,

  created_by_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT proposals_total_one_time_nonneg CHECK (total_one_time_cents >= 0),
  CONSTRAINT proposals_total_recurring_nonneg CHECK (total_recurring_cents >= 0),
  CONSTRAINT proposals_expires_after_sent CHECK (
    expires_at IS NULL OR sent_at IS NULL OR expires_at > sent_at
  ),
  CONSTRAINT proposals_recurring_consistency CHECK (
    (total_recurring_cents > 0 AND recurring_interval IS NOT NULL)
    OR (total_recurring_cents = 0)
  )
);

CREATE INDEX proposals_firm_status_idx
  ON vibetb.proposals (firm_id, status);
CREATE INDEX proposals_client_status_idx
  ON vibetb.proposals (client_id, status);
CREATE INDEX proposals_expires_sweep_idx
  ON vibetb.proposals (status, expires_at)
  WHERE status IN ('SENT', 'VIEWED', 'IN_PROGRESS') AND expires_at IS NOT NULL;

CREATE TABLE vibetb.proposal_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES vibetb.proposals(id) ON DELETE CASCADE,
  version integer NOT NULL,
  -- Immutable canonical JSON snapshot of the proposal (header +
  -- brochure + line items + packages + terms). Sorted-key canonical
  -- form so content_hash is deterministic.
  content_jsonb jsonb NOT NULL,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  -- Why this snapshot was taken (SENT, ACCEPTED, COUNTERED, etc.).
  reason proposal_activity_kind NOT NULL,

  CONSTRAINT proposal_versions_version_positive CHECK (version > 0),
  CONSTRAINT proposal_versions_hash_format CHECK (content_hash ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX proposal_versions_proposal_version_uk
  ON vibetb.proposal_versions (proposal_id, version);

-- --- (7) proposal line items + package junction --------------------
--
-- proposal_line_items is the working list (mutable until accepted).
-- proposal_packages is the junction telling the portal "this proposal
-- offers these packages." On acceptance, line items materialize from
-- the selected package(s) plus loose line items into engagement_scope.

CREATE TABLE vibetb.proposal_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES vibetb.proposals(id) ON DELETE CASCADE,
  -- NULL = ad-hoc line item not bound to a catalog entry. P04 services
  -- block creates these via the catalog; markdown block creates
  -- nothing here.
  service_id uuid REFERENCES vibetb.services_catalog(id) ON DELETE SET NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  qty numeric(12, 4) NOT NULL DEFAULT 1,
  unit_price_cents bigint NOT NULL,
  billing_type proposal_billing_type NOT NULL,
  recurring_interval proposal_recurring_interval,
  -- "optional" line items are offered to the client at acceptance
  -- time but not required.
  optional boolean NOT NULL DEFAULT false,
  sequence integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT proposal_line_items_price_nonneg CHECK (unit_price_cents >= 0),
  CONSTRAINT proposal_line_items_qty_positive CHECK (qty > 0),
  CONSTRAINT proposal_line_items_recurring_consistency CHECK (
    (billing_type IN ('RECURRING', 'SPLIT_DEPOSIT_RECURRING') AND recurring_interval IS NOT NULL)
    OR (billing_type NOT IN ('RECURRING', 'SPLIT_DEPOSIT_RECURRING') AND recurring_interval IS NULL)
  )
);

CREATE INDEX proposal_line_items_proposal_seq_idx
  ON vibetb.proposal_line_items (proposal_id, sequence);

CREATE TABLE vibetb.proposal_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES vibetb.proposals(id) ON DELETE CASCADE,
  package_id uuid NOT NULL REFERENCES vibetb.packages(id) ON DELETE RESTRICT,
  -- Allow overriding the package label per proposal (e.g. "Bronze"
  -- → "Essentials"). NULL = use package.tier_label.
  override_label text,
  sequence integer NOT NULL DEFAULT 0,
  -- The client selects exactly one of the offered packages on
  -- acceptance. NULL until accepted.
  selected boolean NOT NULL DEFAULT false,
  selected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX proposal_packages_proposal_package_uk
  ON vibetb.proposal_packages (proposal_id, package_id);
CREATE INDEX proposal_packages_proposal_seq_idx
  ON vibetb.proposal_packages (proposal_id, sequence);
CREATE UNIQUE INDEX proposal_packages_one_selected_uk
  ON vibetb.proposal_packages (proposal_id)
  WHERE selected = true;

-- --- (8) terms snapshot --------------------------------------------
--
-- On send (and again on accept) the rendered terms are frozen — merge
-- tokens resolved with concrete values and the result hashed. Future
-- template edits never change what the client signed.

CREATE TABLE vibetb.proposal_terms_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES vibetb.proposals(id) ON DELETE CASCADE,
  terms_template_id uuid REFERENCES vibetb.terms_templates(id) ON DELETE RESTRICT,
  template_version integer NOT NULL,
  content_md_rendered text NOT NULL,
  content_hash text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT proposal_terms_snapshot_hash_format CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT proposal_terms_snapshot_version_positive CHECK (template_version > 0)
);

CREATE INDEX proposal_terms_snapshot_proposal_idx
  ON vibetb.proposal_terms_snapshot (proposal_id, captured_at DESC);

-- --- (9) signatures (PLURAL — §0.3 #1) -----------------------------
--
-- Locked decision: schema is plural from day one. v1 UI exposes one
-- signer slot; v1.5 will add multi-signer UI without schema migration.
-- One row per signer per proposal. Status starts PENDING; transitions
-- to SIGNED or DECLINED.

CREATE TABLE vibetb.signatures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES vibetb.proposals(id) ON DELETE CASCADE,
  -- The plural-design flexibility: v1 inserts one PRIMARY row; v1.5
  -- can add COSIGNER and WITNESS rows. Sequence orders the signing
  -- workflow.
  role signature_role NOT NULL DEFAULT 'PRIMARY',
  sequence integer NOT NULL DEFAULT 0,

  -- Signer identity. Captured from the magic-link or
  -- client_account session; not necessarily a portal_identity row
  -- (v1 doesn't require account creation to sign).
  signer_name text NOT NULL,
  signer_email text NOT NULL,
  signer_phone text,
  signer_ip text,
  signer_ua text,
  client_account_id uuid,

  method signature_method NOT NULL,
  state signature_state NOT NULL DEFAULT 'PENDING',

  -- Method-specific payload. Exactly one of typed_name / svg /
  -- opensign_* is meaningful per row.
  typed_name text,
  signature_svg text,
  opensign_envelope_id text,
  opensign_certificate_object_key text,

  -- payload_hash = SHA-256(canonical(proposal_version + terms_snapshot
  --   + mandate + signer)). Persists for tamper-evidence.
  payload_hash text,
  -- HMAC of payload_hash using firm_settings_proposals.hmac_secret.
  hmac_signature text,

  signed_at timestamptz,
  declined_at timestamptz,
  declined_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT signatures_payload_hash_format CHECK (
    payload_hash IS NULL OR payload_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT signatures_signed_state_consistency CHECK (
    (state = 'SIGNED' AND signed_at IS NOT NULL AND payload_hash IS NOT NULL)
    OR state <> 'SIGNED'
  ),
  CONSTRAINT signatures_method_payload CHECK (
    (method = 'TYPED_NAME' AND typed_name IS NOT NULL)
    OR (method = 'DRAWN_SVG' AND signature_svg IS NOT NULL)
    OR (method = 'OPENSIGN' AND opensign_envelope_id IS NOT NULL)
    OR state = 'PENDING'
  )
);

CREATE INDEX signatures_proposal_idx
  ON vibetb.signatures (proposal_id, sequence);
CREATE INDEX signatures_state_idx
  ON vibetb.signatures (state);
CREATE UNIQUE INDEX signatures_opensign_envelope_uk
  ON vibetb.signatures (opensign_envelope_id)
  WHERE opensign_envelope_id IS NOT NULL;

-- --- (10) payment mandates -----------------------------------------
--
-- Stripe payment-method authorizations. ACH mandates carry verbatim
-- mandate text + SHA-256 hash for Nacha compliance. Card mandates
-- store the Stripe mandate_id only.

CREATE TABLE vibetb.payment_mandates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  proposal_id uuid REFERENCES vibetb.proposals(id) ON DELETE SET NULL,
  engagement_id uuid,
  client_id uuid NOT NULL REFERENCES vibetb.client(id) ON DELETE RESTRICT,

  -- Loose FK to portal.payment_method to avoid the circular schema
  -- import (same pattern as engagement.autopay_method_id).
  payment_method_id uuid,

  kind payment_mandate_kind NOT NULL,

  -- Stripe identifiers. account is the connected firm account;
  -- customer/payment_method/mandate are scoped to that account.
  stripe_account_id text NOT NULL,
  stripe_customer_id text,
  stripe_payment_method_id text,
  stripe_mandate_id text,

  -- ACH (Nacha) — verbatim mandate text + canonical hash.
  mandate_text_rendered text,
  mandate_text_hash text,

  state payment_mandate_state NOT NULL DEFAULT 'PENDING_VERIFICATION',
  activated_at timestamptz,
  invalidated_at timestamptz,
  invalidated_reason text,
  revoked_at timestamptz,
  revoked_by_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payment_mandates_text_hash_format CHECK (
    mandate_text_hash IS NULL OR mandate_text_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT payment_mandates_ach_text_required CHECK (
    kind <> 'ACH'
    OR (mandate_text_rendered IS NOT NULL AND mandate_text_hash IS NOT NULL)
  )
);

CREATE INDEX payment_mandates_firm_state_idx
  ON vibetb.payment_mandates (firm_id, state);
CREATE INDEX payment_mandates_client_idx
  ON vibetb.payment_mandates (client_id);
CREATE INDEX payment_mandates_engagement_idx
  ON vibetb.payment_mandates (engagement_id)
  WHERE engagement_id IS NOT NULL;
CREATE UNIQUE INDEX payment_mandates_stripe_mandate_uk
  ON vibetb.payment_mandates (stripe_mandate_id)
  WHERE stripe_mandate_id IS NOT NULL;

-- --- (11) webhook events (Stripe idempotency) ----------------------
--
-- PK is the Stripe event ID — duplicate deliveries collide on insert.
-- Worker processes the row and stamps processed_at + state.

CREATE TABLE vibetb.webhook_events (
  stripe_event_id text PRIMARY KEY,
  firm_id uuid REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  stripe_account_id text NOT NULL,
  event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  state webhook_event_state NOT NULL DEFAULT 'PENDING',
  retry_count integer NOT NULL DEFAULT 0,
  last_error text,
  payload jsonb NOT NULL,
  CONSTRAINT webhook_events_retry_nonneg CHECK (retry_count >= 0)
);

CREATE INDEX webhook_events_account_received_idx
  ON vibetb.webhook_events (stripe_account_id, received_at DESC);
CREATE INDEX webhook_events_state_idx
  ON vibetb.webhook_events (state)
  WHERE state IN ('PENDING', 'FAILED');

-- --- (12) magic links ----------------------------------------------
--
-- Short-lived single-use tokens for portal access. Stored as SHA-256
-- hashes (never raw) so a DB leak cannot replay.

CREATE TABLE vibetb.magic_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  purpose magic_link_purpose NOT NULL,
  client_id uuid REFERENCES vibetb.client(id) ON DELETE CASCADE,
  proposal_id uuid REFERENCES vibetb.proposals(id) ON DELETE CASCADE,
  engagement_id uuid,
  client_account_id uuid,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_from_ip text,
  used_from_ua text,
  -- Replacement chain: when firm resends, the new link supersedes
  -- the prior one; superseded_at is stamped on the prior row.
  superseded_at timestamptz,
  superseded_by_id uuid REFERENCES vibetb.magic_links(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,

  CONSTRAINT magic_links_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX magic_links_token_hash_uk
  ON vibetb.magic_links (token_hash);
CREATE INDEX magic_links_proposal_idx
  ON vibetb.magic_links (proposal_id)
  WHERE proposal_id IS NOT NULL;
CREATE INDEX magic_links_active_idx
  ON vibetb.magic_links (firm_id, expires_at)
  WHERE used_at IS NULL AND superseded_at IS NULL;

-- --- (13) client accounts (optional password) ----------------------
--
-- Optional persistent portal account. password_hash is Argon2id
-- (matches Vibe Connect's convention). One row per (firm, email).

CREATE TABLE vibetb.client_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES vibetb.client(id) ON DELETE CASCADE,
  email text NOT NULL,
  password_hash text NOT NULL,
  email_verified_at timestamptz,
  last_login_at timestamptz,
  mfa_secret_encrypted bytea,
  -- 5-failed-login lockout (P18 acceptance criterion).
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT client_accounts_failed_login_nonneg CHECK (failed_login_count >= 0)
);

CREATE UNIQUE INDEX client_accounts_firm_email_uk
  ON vibetb.client_accounts (firm_id, lower(email));
CREATE INDEX client_accounts_client_idx
  ON vibetb.client_accounts (client_id);

-- --- (14) engagement scope + deliverables --------------------------
--
-- engagement_scope is the frozen line-item copy materialized at
-- proposal acceptance. Immutable after creation — changes flow via
-- amendments (v1.5). engagement_deliverables tracks the work to do.

CREATE TABLE vibetb.engagement_scope (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id uuid NOT NULL REFERENCES vibetb.engagement(id) ON DELETE CASCADE,
  -- Source pointers for traceability — never mutated.
  service_id uuid REFERENCES vibetb.services_catalog(id) ON DELETE SET NULL,
  proposal_line_item_id uuid REFERENCES vibetb.proposal_line_items(id) ON DELETE SET NULL,
  frozen_from_version_id uuid NOT NULL REFERENCES vibetb.proposal_versions(id) ON DELETE RESTRICT,

  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  qty numeric(12, 4) NOT NULL,
  unit_price_cents bigint NOT NULL,
  billing_type proposal_billing_type NOT NULL,
  recurring_interval proposal_recurring_interval,
  sequence integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT engagement_scope_price_nonneg CHECK (unit_price_cents >= 0),
  CONSTRAINT engagement_scope_qty_positive CHECK (qty > 0)
);

CREATE INDEX engagement_scope_engagement_seq_idx
  ON vibetb.engagement_scope (engagement_id, sequence);

CREATE TABLE vibetb.engagement_deliverables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id uuid NOT NULL REFERENCES vibetb.engagement(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  due_date date,
  state engagement_deliverable_state NOT NULL DEFAULT 'PENDING',
  completed_at timestamptz,
  sequence integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX engagement_deliverables_engagement_idx
  ON vibetb.engagement_deliverables (engagement_id, sequence);
CREATE INDEX engagement_deliverables_due_idx
  ON vibetb.engagement_deliverables (due_date)
  WHERE due_date IS NOT NULL AND state IN ('PENDING', 'IN_PROGRESS');

-- --- (15) Stripe mapping tables ------------------------------------
--
-- One-to-one local↔Stripe identity maps. Stripe IDs are kept
-- separate from the proposal/engagement tables so a firm can
-- disconnect Stripe without leaving orphaned typed columns.

CREATE TABLE vibetb.stripe_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES vibetb.client(id) ON DELETE CASCADE,
  stripe_account_id text NOT NULL,
  stripe_customer_id text NOT NULL,
  email_at_creation text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX stripe_customers_account_customer_uk
  ON vibetb.stripe_customers (stripe_account_id, stripe_customer_id);
CREATE UNIQUE INDEX stripe_customers_firm_client_uk
  ON vibetb.stripe_customers (firm_id, client_id);

CREATE TABLE vibetb.stripe_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  engagement_id uuid NOT NULL REFERENCES vibetb.engagement(id) ON DELETE CASCADE,
  stripe_account_id text NOT NULL,
  stripe_customer_id text NOT NULL,
  stripe_subscription_id text NOT NULL,
  stripe_status text NOT NULL,
  current_period_start timestamptz,
  current_period_end timestamptz,
  billing_cycle_anchor timestamptz,
  cancel_at timestamptz,
  cancelled_at timestamptz,
  pause_collection_behavior text,
  paused_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX stripe_subscriptions_stripe_uk
  ON vibetb.stripe_subscriptions (stripe_subscription_id);
CREATE INDEX stripe_subscriptions_engagement_idx
  ON vibetb.stripe_subscriptions (engagement_id);
CREATE INDEX stripe_subscriptions_firm_status_idx
  ON vibetb.stripe_subscriptions (firm_id, stripe_status);

CREATE TABLE vibetb.stripe_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  engagement_id uuid REFERENCES vibetb.engagement(id) ON DELETE SET NULL,
  stripe_account_id text NOT NULL,
  stripe_customer_id text NOT NULL,
  stripe_subscription_id text,
  stripe_invoice_id text NOT NULL,
  stripe_status text NOT NULL,
  amount_due_cents bigint NOT NULL DEFAULT 0,
  amount_paid_cents bigint NOT NULL DEFAULT 0,
  amount_remaining_cents bigint NOT NULL DEFAULT 0,
  due_at timestamptz,
  paid_at timestamptz,
  hosted_invoice_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT stripe_invoices_amount_due_nonneg CHECK (amount_due_cents >= 0),
  CONSTRAINT stripe_invoices_amount_paid_nonneg CHECK (amount_paid_cents >= 0)
);

CREATE UNIQUE INDEX stripe_invoices_stripe_uk
  ON vibetb.stripe_invoices (stripe_invoice_id);
CREATE INDEX stripe_invoices_engagement_idx
  ON vibetb.stripe_invoices (engagement_id)
  WHERE engagement_id IS NOT NULL;
CREATE INDEX stripe_invoices_firm_status_idx
  ON vibetb.stripe_invoices (firm_id, stripe_status);

-- --- (16) proposal activity + per-section views --------------------
--
-- proposal_activity is the event log (CREATED/SENT/VIEWED/etc).
-- proposal_section_views is the aggregated dwell-time tracker keyed
-- on (proposal_id, section_block_id, session_id) for the funnel /
-- dashboard work in P28.

CREATE TABLE vibetb.proposal_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES vibetb.proposals(id) ON DELETE CASCADE,
  kind proposal_activity_kind NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  occurred_from_ip text,
  occurred_from_ua text,
  magic_link_id uuid REFERENCES vibetb.magic_links(id) ON DELETE SET NULL,
  client_account_id uuid,
  -- Free-form per-event payload (e.g. for SECTION_VIEWED: the block
  -- id and dwell_ms; for TIER_SELECTED: the package id).
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX proposal_activity_proposal_occurred_idx
  ON vibetb.proposal_activity (proposal_id, occurred_at DESC);
CREATE INDEX proposal_activity_kind_idx
  ON vibetb.proposal_activity (kind);

CREATE TABLE vibetb.proposal_section_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES vibetb.proposals(id) ON DELETE CASCADE,
  section_block_id text NOT NULL,
  -- Anonymous session correlator (cookie or query token). Allows
  -- distinguishing "Alice viewed 5 sections" from "Alice viewed
  -- section 3 five times."
  session_id text NOT NULL,
  client_account_id uuid,
  first_viewed_at timestamptz NOT NULL DEFAULT now(),
  last_viewed_at timestamptz NOT NULL DEFAULT now(),
  view_count integer NOT NULL DEFAULT 1,
  total_dwell_ms bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT proposal_section_views_count_positive CHECK (view_count > 0),
  CONSTRAINT proposal_section_views_dwell_nonneg CHECK (total_dwell_ms >= 0)
);

CREATE UNIQUE INDEX proposal_section_views_proposal_section_session_uk
  ON vibetb.proposal_section_views (proposal_id, section_block_id, session_id);
CREATE INDEX proposal_section_views_proposal_idx
  ON vibetb.proposal_section_views (proposal_id, last_viewed_at DESC);

-- --- (17) quick bills (ad-hoc invoices) ----------------------------

CREATE TABLE vibetb.quick_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES vibetb.client(id) ON DELETE RESTRICT,
  state quick_bill_state NOT NULL DEFAULT 'DRAFT',
  total_cents bigint NOT NULL DEFAULT 0,
  description text NOT NULL DEFAULT '',
  -- Either we charge an existing PaymentMethod (immediate) or we mint
  -- a portal link for the client to pay (deferred).
  payment_method_id uuid,
  stripe_invoice_id text,
  sent_at timestamptz,
  paid_at timestamptz,
  void_at timestamptz,
  void_reason text,
  created_by_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT quick_bills_total_nonneg CHECK (total_cents >= 0)
);

CREATE INDEX quick_bills_firm_state_idx
  ON vibetb.quick_bills (firm_id, state);
CREATE INDEX quick_bills_client_idx
  ON vibetb.quick_bills (client_id, created_at DESC);

CREATE TABLE vibetb.quick_bill_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quick_bill_id uuid NOT NULL REFERENCES vibetb.quick_bills(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  qty numeric(12, 4) NOT NULL DEFAULT 1,
  unit_price_cents bigint NOT NULL,
  sequence integer NOT NULL DEFAULT 0,

  CONSTRAINT quick_bill_line_items_qty_positive CHECK (qty > 0),
  CONSTRAINT quick_bill_line_items_price_nonneg CHECK (unit_price_cents >= 0)
);

CREATE INDEX quick_bill_line_items_qb_seq_idx
  ON vibetb.quick_bill_line_items (quick_bill_id, sequence);

-- --- (18) renewals -------------------------------------------------

CREATE TABLE vibetb.renewals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  current_engagement_id uuid NOT NULL REFERENCES vibetb.engagement(id) ON DELETE CASCADE,
  uplift_mode uplift_mode NOT NULL DEFAULT 'MANUAL_PERCENT',
  -- Stored in basis points. 500 = 5% uplift; -500 = 5% reduction.
  uplift_bps integer NOT NULL DEFAULT 0,
  -- Suggested next-period total. Materialized by the renewal-engine
  -- worker; null until calculated.
  suggested_total_cents bigint,
  candidate_at timestamptz NOT NULL DEFAULT now(),
  -- The window during which the renewal should be sent. Engine
  -- surfaces engagements with ends_on inside this window.
  send_window_start date,
  send_window_end date,
  state renewal_state NOT NULL DEFAULT 'CANDIDATE',
  -- The proposal created from this renewal candidate (P25).
  proposal_id uuid REFERENCES vibetb.proposals(id) ON DELETE SET NULL,
  -- Auto-renewal sidesteps the proposal step (gated by client's prior
  -- consent in original engagement letter).
  auto_renew boolean NOT NULL DEFAULT false,
  -- BLS CPI-U snapshot used for the uplift math; cached at decide
  -- time so the suggestion is reproducible.
  cpi_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT renewals_uplift_bps_range CHECK (uplift_bps BETWEEN -10000 AND 100000),
  CONSTRAINT renewals_suggested_nonneg CHECK (
    suggested_total_cents IS NULL OR suggested_total_cents >= 0
  )
);

CREATE INDEX renewals_firm_state_idx
  ON vibetb.renewals (firm_id, state);
CREATE INDEX renewals_engagement_idx
  ON vibetb.renewals (current_engagement_id);
CREATE INDEX renewals_window_idx
  ON vibetb.renewals (send_window_start, send_window_end)
  WHERE state = 'CANDIDATE';

-- --- (19) engagement column extensions -----------------------------
--
-- Two columns added: from_proposal_id (which proposal birthed this
-- engagement) and renewed_from_engagement_id (set when this is a
-- renewal). The existing engagement.status enum and workflow_state
-- stay untouched — proposals don't dictate engagement lifecycle here.

ALTER TABLE vibetb.engagement
  ADD COLUMN from_proposal_id uuid REFERENCES vibetb.proposals(id) ON DELETE SET NULL,
  ADD COLUMN renewed_from_engagement_id uuid REFERENCES vibetb.engagement(id) ON DELETE SET NULL;

CREATE INDEX engagement_from_proposal_idx
  ON vibetb.engagement (from_proposal_id)
  WHERE from_proposal_id IS NOT NULL;
CREATE INDEX engagement_renewed_from_idx
  ON vibetb.engagement (renewed_from_engagement_id)
  WHERE renewed_from_engagement_id IS NOT NULL;

-- --- (20) back-references that need post-creation FKs --------------
--
-- proposals.renewed_from_engagement_id couldn't reference engagement
-- in the same statement because the column was added later in this
-- migration. Wire it up here.

ALTER TABLE vibetb.proposals
  ADD CONSTRAINT proposals_renewed_from_engagement_fk
    FOREIGN KEY (renewed_from_engagement_id)
    REFERENCES vibetb.engagement(id) ON DELETE SET NULL;

CREATE INDEX proposals_renewed_from_engagement_idx
  ON vibetb.proposals (renewed_from_engagement_id)
  WHERE renewed_from_engagement_id IS NOT NULL;

-- Default grants apply (no special REVOKE — none of these tables
-- carry the audit_log/time_entry_version append-only invariant).
