-- =====================================================================
-- Migration: 0075_tax_return_module.sql  (Phase TR-1 foundation)
--
-- Tax-return module schema groundwork — implements every table required
-- by `TAX_RETURN_BUILD_PLAN.md` §2 in one structural drop. No business
-- logic, no API, no UI. Subsequent phases (TR-1 → TR-11) layer features
-- on top of this foundation.
--
-- The plan calls for a separate `tax` Postgres schema for namespace
-- hygiene. To stay consistent with the project's existing `vibetb`
-- schema (set by 0057_schema_split), tables live in `vibetb` with a
-- `tax_return_` prefix instead. Net effect on queries is identical
-- once search_path resolves.
--
-- Tables created (5 total):
--   tax_returns                  — one row per uploaded return
--   tax_return_sections          — outline tree (bookmarks + page ranges)
--   tax_return_releases          — staff-published snapshots per client
--   tax_return_shares            — client→3rd-party share tokens
--   tax_return_access_log        — append-only audit feed (every touch)
--
-- All foreign keys are explicit. Cascades are conservative: deleting a
-- firm does not auto-delete tax data — staff archives explicitly. The
-- access log is append-only at the DB role level (REVOKE UPDATE/DELETE
-- applied at end of migration to match the audit_log pattern).
-- =====================================================================

-- --- (1) enums ------------------------------------------------------

CREATE TYPE tax_return_status AS ENUM (
  'DRAFT',
  'PARSED',
  'REVIEW',
  'APPROVED',
  'RELEASED',
  'SUPERSEDED'
);

CREATE TYPE tax_release_kind AS ENUM (
  'ORIGINAL',
  'AMENDED',
  'SUPERSEDED'
);

CREATE TYPE tax_section_kind AS ENUM (
  'COVER',
  'MAIN_FORM',
  'SCHEDULE',
  'K1',
  'STATE',
  'WORKSHEET',
  'ATTACHMENT',
  'UNKNOWN'
);

CREATE TYPE tax_release_scope AS ENUM (
  'FULL',
  'SELECTED'
);

CREATE TYPE tax_share_status AS ENUM (
  'SENT',
  'VIEWED',
  'EXPIRED',
  'REVOKED'
);

CREATE TYPE tax_share_verify_channel AS ENUM (
  'SMS',
  'EMAIL',
  'NONE'
);

CREATE TYPE tax_access_actor_kind AS ENUM (
  'CLIENT',
  'STAFF',
  'RECIPIENT',
  'SYSTEM'
);

CREATE TYPE tax_access_event AS ENUM (
  'PARSED',
  'RELEASED',
  'REVOKED',
  'VIEW',
  'DOWNLOAD',
  'PAGE_RENDER',
  '2FA_SENT',
  '2FA_PASSED',
  '2FA_FAILED',
  'EXPIRED',
  'SUPERSEDED',
  'SECTION_EDITED'
);

-- --- (2) tax_returns -------------------------------------------------

CREATE TABLE tax_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firm(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES client(id) ON DELETE RESTRICT,
  engagement_id uuid REFERENCES engagement(id) ON DELETE SET NULL,
  tax_year integer NOT NULL,
  form_code text NOT NULL,
  jurisdiction text NOT NULL DEFAULT 'federal',
  title text NOT NULL,
  status tax_return_status NOT NULL DEFAULT 'DRAFT',
  release_kind tax_release_kind NOT NULL DEFAULT 'ORIGINAL',
  amends_return_id uuid REFERENCES tax_returns(id) ON DELETE SET NULL,
  filed_at timestamptz,
  refund_or_owed_cents bigint,
  source_file_id uuid REFERENCES files(id) ON DELETE RESTRICT,
  source_file_sha256 text,
  total_pages integer,
  parsed_at timestamptz,
  released_at timestamptz,
  released_by_user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  -- Per TR-11. Wrapped DEK is NULL until staff approves; key install
  -- happens at first release.
  wrapped_dek bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tax_returns_tax_year_range CHECK (tax_year BETWEEN 1900 AND 2999),
  CONSTRAINT tax_returns_total_pages_pos CHECK (total_pages IS NULL OR total_pages > 0),
  CONSTRAINT tax_returns_amends_self_distinct CHECK (amends_return_id IS NULL OR amends_return_id <> id)
);

CREATE INDEX tax_returns_firm_status_idx ON tax_returns(firm_id, status);
CREATE INDEX tax_returns_client_year_idx ON tax_returns(client_id, tax_year DESC);
CREATE INDEX tax_returns_engagement_idx ON tax_returns(engagement_id) WHERE engagement_id IS NOT NULL;
CREATE INDEX tax_returns_amends_idx ON tax_returns(amends_return_id) WHERE amends_return_id IS NOT NULL;

-- --- (3) tax_return_sections ----------------------------------------

CREATE TABLE tax_return_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id uuid NOT NULL REFERENCES tax_returns(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  parent_section_id uuid REFERENCES tax_return_sections(id) ON DELETE CASCADE,
  depth smallint NOT NULL DEFAULT 0,
  raw_title text NOT NULL,
  normalized_title text NOT NULL,
  kind tax_section_kind NOT NULL DEFAULT 'UNKNOWN',
  form_code text,
  recipient_name text,
  recipient_tin_last4 text,
  start_page integer NOT NULL,
  end_page integer NOT NULL,
  releasable boolean NOT NULL DEFAULT true,
  page_sha256 text,
  parse_confidence smallint NOT NULL DEFAULT 100,
  -- Sticky-manual flag: when staff edits, set true so reparse never
  -- clobbers the edit (per plan §3.3 DoD).
  is_manual_override boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tax_return_sections_page_range CHECK (start_page > 0 AND end_page >= start_page),
  CONSTRAINT tax_return_sections_depth_nonneg CHECK (depth >= 0),
  CONSTRAINT tax_return_sections_confidence_range CHECK (parse_confidence BETWEEN 0 AND 100),
  CONSTRAINT tax_return_sections_tin_last4 CHECK (
    recipient_tin_last4 IS NULL OR recipient_tin_last4 ~ '^[0-9]{4}$'
  )
);

CREATE UNIQUE INDEX tax_return_sections_return_ordinal_uk ON tax_return_sections(return_id, ordinal);
CREATE INDEX tax_return_sections_return_idx ON tax_return_sections(return_id, start_page);
CREATE INDEX tax_return_sections_parent_idx ON tax_return_sections(parent_section_id)
  WHERE parent_section_id IS NOT NULL;
CREATE INDEX tax_return_sections_kind_idx ON tax_return_sections(return_id, kind);

-- --- (4) tax_return_releases ----------------------------------------

CREATE TABLE tax_return_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id uuid NOT NULL REFERENCES tax_returns(id) ON DELETE CASCADE,
  released_to_client_id uuid NOT NULL REFERENCES client(id) ON DELETE RESTRICT,
  scope tax_release_scope NOT NULL DEFAULT 'FULL',
  -- ordered list of tax_return_sections.id, ordered by section.ordinal.
  section_ids uuid[] NOT NULL DEFAULT '{}',
  client_can_download boolean NOT NULL DEFAULT true,
  cover_note text,
  released_by_user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  released_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by_user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  CONSTRAINT tax_return_releases_scope_sections CHECK (
    (scope = 'FULL' AND cardinality(section_ids) = 0)
    OR (scope = 'SELECTED' AND cardinality(section_ids) > 0)
  )
);

-- One *live* (un-revoked) release per (return, client). Re-release
-- semantics: previous one is soft-revoked first.
CREATE UNIQUE INDEX tax_return_releases_live_uk
  ON tax_return_releases(return_id, released_to_client_id)
  WHERE revoked_at IS NULL;
CREATE INDEX tax_return_releases_return_idx ON tax_return_releases(return_id);
CREATE INDEX tax_return_releases_client_idx ON tax_return_releases(released_to_client_id, released_at DESC);

-- --- (5) tax_return_shares ------------------------------------------

CREATE TABLE tax_return_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id uuid NOT NULL REFERENCES tax_returns(id) ON DELETE CASCADE,
  release_id uuid NOT NULL REFERENCES tax_return_releases(id) ON DELETE CASCADE,
  -- client_access is in portal.ts; FK enforced by ALTER TABLE after
  -- the table exists. For now we keep it unbound at the column-def
  -- layer to avoid forward-ref noise.
  shared_by_access_id uuid NOT NULL,
  recipient_name text NOT NULL,
  recipient_email text NOT NULL,
  recipient_phone text,
  organization text NOT NULL DEFAULT '',
  role text NOT NULL,
  access_level text NOT NULL DEFAULT 'view_only',
  scope tax_release_scope NOT NULL DEFAULT 'SELECTED',
  section_ids uuid[] NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL,
  require_2fa boolean NOT NULL DEFAULT true,
  verify_channel tax_share_verify_channel NOT NULL DEFAULT 'EMAIL',
  watermark boolean NOT NULL DEFAULT true,
  -- Argon2id hash of the share token. Plaintext token only at
  -- issuance (email/SMS body) — never persisted or logged.
  token_hash text NOT NULL,
  -- Per-share data-encryption key wrapped under the firm KEK.
  wrapped_dek bytea,
  personal_message text NOT NULL DEFAULT '',
  status tax_share_status NOT NULL DEFAULT 'SENT',
  sent_at timestamptz NOT NULL DEFAULT now(),
  first_viewed_at timestamptz,
  last_viewed_at timestamptz,
  view_count integer NOT NULL DEFAULT 0,
  failed_2fa_count integer NOT NULL DEFAULT 0,
  revoked_at timestamptz,
  revoked_by_access_id uuid,
  CONSTRAINT tax_return_shares_access_level CHECK (access_level IN ('view_only', 'view_download')),
  CONSTRAINT tax_return_shares_scope_sections CHECK (
    (scope = 'FULL' AND cardinality(section_ids) = 0)
    OR (scope = 'SELECTED' AND cardinality(section_ids) > 0)
  ),
  CONSTRAINT tax_return_shares_view_count_nonneg CHECK (view_count >= 0),
  CONSTRAINT tax_return_shares_failed_2fa_nonneg CHECK (failed_2fa_count >= 0),
  CONSTRAINT tax_return_shares_expires_after_sent CHECK (expires_at > sent_at)
);

CREATE UNIQUE INDEX tax_return_shares_token_hash_uk ON tax_return_shares(token_hash);
CREATE INDEX tax_return_shares_return_idx ON tax_return_shares(return_id, status);
CREATE INDEX tax_return_shares_release_idx ON tax_return_shares(release_id);
CREATE INDEX tax_return_shares_expires_idx ON tax_return_shares(expires_at)
  WHERE status IN ('SENT', 'VIEWED');
CREATE INDEX tax_return_shares_recipient_email_idx ON tax_return_shares(recipient_email)
  WHERE status IN ('SENT', 'VIEWED');

-- --- (6) tax_return_access_log --------------------------------------

CREATE TABLE tax_return_access_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id uuid NOT NULL REFERENCES tax_returns(id) ON DELETE CASCADE,
  share_id uuid REFERENCES tax_return_shares(id) ON DELETE SET NULL,
  actor_kind tax_access_actor_kind NOT NULL,
  -- Free-form ref into the appropriate actor table (client_access.id,
  -- app_user.id, tax_return_shares.id). Format is enforced by code,
  -- not by FK, because actor_kind drives the resolution.
  actor_ref text,
  actor_ip text,
  actor_user_agent text,
  event tax_access_event NOT NULL,
  page_number integer,
  section_id uuid REFERENCES tax_return_sections(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tax_return_access_log_return_at_idx ON tax_return_access_log(return_id, at DESC);
CREATE INDEX tax_return_access_log_share_idx ON tax_return_access_log(share_id, at DESC)
  WHERE share_id IS NOT NULL;
CREATE INDEX tax_return_access_log_event_idx ON tax_return_access_log(event, at DESC);

-- Append-only at the role level (matches audit_log pattern). The
-- DO-block here is a no-op when the migrate runner is acting as the
-- superuser (which has implicit grants), but the production deploy
-- uses a separate `vibetb_app` role and this REVOKE locks it down.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vibetb_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON tax_return_access_log FROM vibetb_app';
  END IF;
END $$;
