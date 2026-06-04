-- =====================================================================
-- Migration: 0099_cloudflare_tunnel_esign_realm.sql
--
-- Adds an ESIGN realm to cloudflare_tunnel_realm so the in-app tunnel
-- provisioner can publish the OpenSign signing UI (e.g. esign.<zone>)
-- alongside the STAFF + PORTAL hostnames. Unlike those realms, an ESIGN
-- rule routes to the OpenSign sidecar (opensign-caddy:4001) WITHOUT a
-- Host-header rewrite — OpenSign's Caddy is host-agnostic on :4001.
--
-- Single statement on purpose: ALTER TYPE ... ADD VALUE commits cleanly
-- and the value is not used elsewhere in this migration.
-- =====================================================================

ALTER TYPE cloudflare_tunnel_realm ADD VALUE IF NOT EXISTS 'ESIGN';
