-- =====================================================================
-- Migration: 0095_cloudflare_tunnel_hostnames.sql
--
-- Adds support for an arbitrary list of Cloudflare Tunnel hostnames
-- (replacing the fixed staff + portal pair), each tagged with the realm
-- it routes to. The legacy staff_hostname / portal_hostname columns on
-- cloudflare_tunnel_config are retained and kept populated with the
-- first hostname of each realm for back-compat.
--
-- dns_record_id stores the Cloudflare DNS record id for each hostname so
-- edit-in-place can reconcile (delete the exact removed records) without
-- a lookup.
-- =====================================================================

DO $$ BEGIN
  CREATE TYPE cloudflare_tunnel_realm AS ENUM ('STAFF', 'PORTAL');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS vibetb.cloudflare_tunnel_hostname (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  hostname text NOT NULL,
  realm cloudflare_tunnel_realm NOT NULL,
  dns_record_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cf_tunnel_hostname_firm_host_uk UNIQUE (firm_id, hostname)
);

CREATE INDEX IF NOT EXISTS cf_tunnel_hostname_firm_idx
  ON vibetb.cloudflare_tunnel_hostname(firm_id);

-- Backfill: lift any existing staff/portal hostnames from the config row
-- into the new table so already-provisioned firms keep their hostnames.
INSERT INTO vibetb.cloudflare_tunnel_hostname (firm_id, hostname, realm)
SELECT firm_id, staff_hostname, 'STAFF'
FROM vibetb.cloudflare_tunnel_config
WHERE staff_hostname IS NOT NULL
ON CONFLICT (firm_id, hostname) DO NOTHING;

INSERT INTO vibetb.cloudflare_tunnel_hostname (firm_id, hostname, realm)
SELECT firm_id, portal_hostname, 'PORTAL'
FROM vibetb.cloudflare_tunnel_config
WHERE portal_hostname IS NOT NULL
ON CONFLICT (firm_id, hostname) DO NOTHING;
