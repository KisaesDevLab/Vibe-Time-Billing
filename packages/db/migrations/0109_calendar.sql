-- =====================================================================
-- Migration: 0109_calendar.sql  (Calendar Integration Addendum, CAL-1)
--
-- Per-staff OAuth into Microsoft 365 / Google Calendar with poll-only
-- read ingest of appointments, two-tier client matching, RSVP, and
-- time-entry suggestions. Provider secrets + OAuth tokens are stored as
-- bytea ciphertext under a per-row DEK wrapped by the firm MFK
-- (`t_dek_wrapped`), mirroring intake/messaging at-rest crypto.
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.calendar_provider_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('microsoft','google')),
  t_dek_wrapped bytea NOT NULL,
  client_id_enc bytea NOT NULL,
  client_secret_enc bytea NOT NULL,
  tenant_id_enc bytea,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_provider_config_firm_provider_uk
  ON vibetb.calendar_provider_config (firm_id, provider);

CREATE TABLE IF NOT EXISTS vibetb.staff_calendar_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES vibetb.app_user(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('microsoft','google')),
  t_dek_wrapped bytea NOT NULL,
  access_token_enc bytea NOT NULL,
  refresh_token_enc bytea,
  token_expiry timestamptz,
  scope text,
  provider_user_id text,
  provider_email text,
  connected_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz,
  sync_error text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS staff_calendar_connections_staff_provider_uk
  ON vibetb.staff_calendar_connections (staff_id, provider);
CREATE INDEX IF NOT EXISTS staff_calendar_connections_firm_idx
  ON vibetb.staff_calendar_connections (firm_id);

CREATE TABLE IF NOT EXISTS vibetb.staff_calendar_selections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES vibetb.staff_calendar_connections(id) ON DELETE CASCADE,
  calendar_id text NOT NULL,
  calendar_name text NOT NULL,
  color text,
  is_primary boolean NOT NULL DEFAULT false,
  sync_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS staff_calendar_selections_conn_cal_uk
  ON vibetb.staff_calendar_selections (connection_id, calendar_id);

CREATE TABLE IF NOT EXISTS vibetb.calendar_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  staff_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  connection_id uuid REFERENCES vibetb.staff_calendar_connections(id) ON DELETE SET NULL,
  provider_event_id text NOT NULL,
  calendar_id text,
  subject text,
  body_preview text,
  start_at timestamptz,
  end_at timestamptz,
  location text,
  is_all_day boolean NOT NULL DEFAULT false,
  organizer_email text,
  organizer_name text,
  attendees jsonb,
  ical_uid text,
  web_link text,
  raw_etag text,
  tb_origin boolean NOT NULL DEFAULT false,
  soft_deleted_at timestamptz,
  sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_events_conn_event_uk
  ON vibetb.calendar_events (connection_id, provider_event_id);
CREATE INDEX IF NOT EXISTS calendar_events_staff_start_idx
  ON vibetb.calendar_events (staff_id, start_at);
CREATE INDEX IF NOT EXISTS calendar_events_firm_start_idx
  ON vibetb.calendar_events (firm_id, start_at);

CREATE TABLE IF NOT EXISTS vibetb.calendar_event_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES vibetb.calendar_events(id) ON DELETE CASCADE,
  client_id uuid REFERENCES vibetb.client(id) ON DELETE SET NULL,
  match_tier text NOT NULL
    CHECK (match_tier IN ('exact_email','fuzzy_name','llm','manual','unmatched')),
  match_score double precision,
  match_status text NOT NULL DEFAULT 'pending'
    CHECK (match_status IN ('confirmed','dismissed','pending')),
  matched_by uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  matched_at timestamptz,
  dismissed_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calendar_event_matches_event_idx
  ON vibetb.calendar_event_matches (event_id);
CREATE INDEX IF NOT EXISTS calendar_event_matches_client_status_idx
  ON vibetb.calendar_event_matches (client_id, match_status);

CREATE TABLE IF NOT EXISTS vibetb.calendar_rsvp_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES vibetb.calendar_events(id) ON DELETE CASCADE,
  client_contact_id uuid REFERENCES vibetb.client_contact(id) ON DELETE CASCADE,
  token uuid NOT NULL DEFAULT gen_random_uuid(),
  response text CHECK (response IS NULL OR response IN ('confirmed','declined')),
  responded_at timestamptz,
  reminder_id uuid,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_rsvp_tokens_token_uk
  ON vibetb.calendar_rsvp_tokens (token);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_rsvp_tokens_event_contact_uk
  ON vibetb.calendar_rsvp_tokens (event_id, client_contact_id);
