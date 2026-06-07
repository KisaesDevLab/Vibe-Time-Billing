-- 0129_terminal.sql
-- Stripe Terminal (in-person) — Location + Reader pointers per firm. The
-- Location and Reader objects live on the firm's connected account; we persist
-- the ids + display metadata + reader health.

CREATE TABLE IF NOT EXISTS vibetb.terminal_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  stripe_location_id text NOT NULL,
  display_name text NOT NULL,
  address_line1 text,
  address_city text,
  address_state text,
  address_postal text,
  address_country text NOT NULL DEFAULT 'US',
  cellular_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS terminal_locations_firm_idx ON vibetb.terminal_locations (firm_id);

CREATE TABLE IF NOT EXISTS vibetb.terminal_readers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES vibetb.terminal_locations(id) ON DELETE CASCADE,
  stripe_reader_id text NOT NULL,
  label text NOT NULL,
  device_type text,
  serial_number text,
  status text NOT NULL DEFAULT 'offline',
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS terminal_readers_firm_idx ON vibetb.terminal_readers (firm_id);
CREATE INDEX IF NOT EXISTS terminal_readers_stripe_idx ON vibetb.terminal_readers (stripe_reader_id);
