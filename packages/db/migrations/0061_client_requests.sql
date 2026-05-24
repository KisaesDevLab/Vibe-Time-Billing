-- =====================================================================
-- Migration: 0061_client_requests.sql
--
-- Client document/information request workflow. A request is a unit of
-- work owed by the client to the firm (e.g., "send us last year's K-1"
-- or "confirm whether you sold any crypto in 2025"). Staff create
-- requests, the client portal fulfills them via message or file
-- upload, and pending requests can suggest time-entry capture for the
-- staff member who finally addresses them.
--
-- Tables:
--   client_request
--     The request itself. Lives at engagement scope (engagement_id NOT
--     NULL) so it inherits engagement-level permissions.
--   client_request_time_entry_link
--     Suggestion lifecycle. When a request is fulfilled, a suggestion
--     row appears for the staff member who completed it. The staff
--     accepts → suggestion converts to a time_entry_message_link or
--     time entry; rejects → row stays with dismissed_at set; ignores →
--     hourly sweep expires the row after firm_config.suggestion_
--     expiration_days.
-- =====================================================================

CREATE TABLE vibetb.client_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  engagement_id uuid NOT NULL REFERENCES vibetb.engagement(id) ON DELETE CASCADE,
  -- Who's responsible for fulfilling.
  assigned_app_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  -- Plaintext title + body (not encrypted — these are workflow metadata,
  -- not message content. Sensitive request bodies should be sent in
  -- messages instead).
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'OPEN',
  due_date date,
  -- Optional pointers to the message / file that satisfied the request.
  -- Allow both: a request can be fulfilled by a message containing a
  -- file attachment in which case both are set.
  fulfilled_by_message_id uuid REFERENCES vibetb.message(id) ON DELETE SET NULL,
  fulfilled_by_file_id uuid REFERENCES vibetb.files(id) ON DELETE SET NULL,
  fulfilled_at timestamptz,
  fulfilled_by_app_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  fulfilled_by_portal_identity_id uuid REFERENCES vibetb.portal_identity(id) ON DELETE SET NULL,
  -- Soft delete via status; never DELETE.
  dismissed_at timestamptz,
  dismissed_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_app_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT client_request_status_ck
    CHECK (status IN ('OPEN', 'FULFILLED', 'DISMISSED', 'EXPIRED')),
  CONSTRAINT client_request_fulfilled_actor_ck CHECK (
    -- When fulfilled, exactly one fulfiller actor must be set.
    status != 'FULFILLED'
    OR (
      (fulfilled_by_app_user_id IS NOT NULL AND fulfilled_by_portal_identity_id IS NULL)
      OR (fulfilled_by_app_user_id IS NULL AND fulfilled_by_portal_identity_id IS NOT NULL)
    )
  ),
  CONSTRAINT client_request_title_len_ck CHECK (length(title) BETWEEN 1 AND 200),
  CONSTRAINT client_request_body_len_ck CHECK (length(body) <= 5000)
);

CREATE INDEX client_request_firm_status_idx
  ON vibetb.client_request(firm_id, status)
  WHERE dismissed_at IS NULL;
CREATE INDEX client_request_engagement_idx
  ON vibetb.client_request(engagement_id, status);
CREATE INDEX client_request_assigned_idx
  ON vibetb.client_request(assigned_app_user_id)
  WHERE status = 'OPEN';
CREATE INDEX client_request_due_idx
  ON vibetb.client_request(due_date)
  WHERE status = 'OPEN' AND due_date IS NOT NULL;

-- ---------------------------------------------------------------------
-- client_request_time_entry_link — suggestion lifecycle
-- ---------------------------------------------------------------------
CREATE TABLE vibetb.client_request_time_entry_link (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_request_id uuid NOT NULL REFERENCES vibetb.client_request(id) ON DELETE CASCADE,
  -- Either suggested (no time_entry_id yet) or accepted (time_entry_id set).
  time_entry_id uuid REFERENCES vibetb.time_entry(id) ON DELETE CASCADE,
  suggested_for_app_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE CASCADE,
  suggested_at timestamptz NOT NULL DEFAULT now(),
  -- Sweep deadline computed from firm_config.suggestion_expiration_days.
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  dismissed_at timestamptz,
  dismissed_reason text,

  CONSTRAINT crtel_state_ck CHECK (
    -- Either pending (no terminal flag), accepted (time entry attached),
    -- or dismissed. Never both terminal flags.
    (accepted_at IS NULL AND dismissed_at IS NULL)
    OR (accepted_at IS NOT NULL AND dismissed_at IS NULL AND time_entry_id IS NOT NULL)
    OR (accepted_at IS NULL AND dismissed_at IS NOT NULL)
  )
);

CREATE INDEX crtel_suggested_for_idx
  ON vibetb.client_request_time_entry_link(suggested_for_app_user_id)
  WHERE accepted_at IS NULL AND dismissed_at IS NULL;
CREATE INDEX crtel_expires_idx
  ON vibetb.client_request_time_entry_link(expires_at)
  WHERE accepted_at IS NULL AND dismissed_at IS NULL;
