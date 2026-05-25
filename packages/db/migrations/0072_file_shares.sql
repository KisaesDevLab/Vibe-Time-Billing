-- =====================================================================
-- Migration: 0072_file_shares.sql  (Stage CP11)
--
-- Per-file share links (Build Plan §2.4, share half). A portal client
-- generates a token that they can forward to a CPA, bank, or attorney.
-- The recipient hits /shared/:token (no portal account required) and
-- gets the file body served via a fresh presigned URL.
--
-- Token storage: we store sha256(token) only. The raw token is shown
-- to the creator exactly once at creation time. A DB dump alone never
-- yields live access — matching the session-cookie convention from
-- session-store.ts.
--
-- Lifecycle:
--   ACTIVE       — revoked_at IS NULL AND (expires_at IS NULL OR > now())
--   EXPIRED      — expires_at < now()
--   REVOKED      — revoked_at IS NOT NULL
--
-- Per-share encryption-wrapped key (mentioned in build-plan §2.4) is
-- deferred — relying on token unguessability + token_hash at rest is
-- a reasonable v1 stance. Can layer encryption later without schema
-- change (add encryption_key_wrapped column then).
-- =====================================================================

CREATE TABLE vibetb.file_share (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES vibetb.client(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES vibetb.files(id) ON DELETE CASCADE,
  -- Optional — the identity row may have been deleted between creation
  -- and any later inspection. Audit trail in file_share_event keeps the
  -- IP / UA history regardless.
  created_by_portal_identity_id uuid REFERENCES vibetb.portal_identity(id) ON DELETE SET NULL,
  token_hash text NOT NULL UNIQUE,
  access_level text NOT NULL DEFAULT 'view',
  expires_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  access_count integer NOT NULL DEFAULT 0,
  last_accessed_at timestamptz,

  CONSTRAINT file_share_access_level_ck
    CHECK (access_level IN ('view', 'download')),
  CONSTRAINT file_share_access_count_nonneg
    CHECK (access_count >= 0)
);

CREATE INDEX file_share_file_idx ON vibetb.file_share (file_id);
CREATE INDEX file_share_client_idx ON vibetb.file_share (client_id);
CREATE INDEX file_share_expires_idx ON vibetb.file_share (expires_at)
  WHERE expires_at IS NOT NULL;

-- Append-only access log. One row per /shared/:token GET, allowed or
-- denied. Indexed for the firm's "who has been accessing my client's
-- shared files?" admin report.
CREATE TABLE vibetb.file_share_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_share_id uuid NOT NULL REFERENCES vibetb.file_share(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  ip text,
  user_agent text,
  outcome text NOT NULL,

  CONSTRAINT file_share_event_outcome_ck
    CHECK (outcome IN ('allowed', 'denied_revoked', 'denied_expired', 'denied_file_gone'))
);

CREATE INDEX file_share_event_share_idx
  ON vibetb.file_share_event (file_share_id, occurred_at);
