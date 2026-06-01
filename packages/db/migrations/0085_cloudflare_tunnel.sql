-- =====================================================================
-- Migration: 0085_cloudflare_tunnel.sql
--
-- Adds in-app provisioning state for Cloudflare Tunnel.
--
-- One row per firm (single-firm appliance, FK kept for convention).
-- Both the firm's Cloudflare API token and the per-tunnel run-token
-- are stored encrypted via the firm MFK envelope (bytea, AEAD).
-- A 4-char hint of the API token is stored separately so the admin
-- UI can show "ends in ...abcd" without decrypt.
--
-- The cloudflared sidecar runs in "remotely managed" mode: it only
-- needs the run-token (passed via /run/cloudflared/token file or env
-- var). Ingress changes go through the Cloudflare API, not local
-- config — so editing hostnames in the admin UI does not require
-- restarting the sidecar.
-- =====================================================================

CREATE TYPE cloudflare_tunnel_status AS ENUM (
  'INACTIVE',     -- no row, or row exists but never provisioned
  'PROVISIONING', -- API call in flight (transient; lock kept short)
  'ACTIVE',       -- tunnel created, DNS up, sidecar should be running
  'ERROR'         -- last operation failed; see last_error
);

CREATE TABLE IF NOT EXISTS vibetb.cloudflare_tunnel_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  -- Cloudflare account / zone the firm owns.
  account_id text,
  zone_id text,
  zone_name text,                       -- "firm.com"
  -- Hostnames the firm picks. Always FQDNs (e.g. "app.firm.com").
  staff_hostname text,
  portal_hostname text,
  -- Created tunnel.
  tunnel_id text,
  tunnel_name text,
  -- Firm's Cloudflare API token (Tunnel:Edit + DNS:Edit). Used by the
  -- API service when the firm changes hostnames or rotates the tunnel.
  api_token_encrypted bytea,
  api_token_hint text,                  -- last 4 chars, plaintext
  -- Per-tunnel run-token written to the sidecar volume. cloudflared
  -- uses it to connect to Cloudflare's edge.
  tunnel_token_encrypted bytea,
  -- Provisioning state.
  status cloudflare_tunnel_status NOT NULL DEFAULT 'INACTIVE',
  last_error text,
  last_provisioned_at timestamptz,
  -- Live status snapshot from the worker's metrics poll.
  last_status_check_at timestamptz,
  metrics_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cf_tunnel_one_per_firm UNIQUE (firm_id),
  CONSTRAINT cf_tunnel_token_hint_short CHECK (
    api_token_hint IS NULL OR length(api_token_hint) <= 8
  )
);

CREATE INDEX IF NOT EXISTS cloudflare_tunnel_status_idx
  ON vibetb.cloudflare_tunnel_config(status);
