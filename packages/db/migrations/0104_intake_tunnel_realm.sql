-- =====================================================================
-- Migration: 0104_intake_tunnel_realm.sql
--
-- Adds an INTAKE realm to cloudflare_tunnel_realm so the in-app tunnel
-- provisioner can publish the public document-intake SPA (e.g.
-- intake.<zone>) alongside the STAFF + PORTAL + ESIGN hostnames. Like
-- STAFF/PORTAL, an INTAKE rule routes to the appliance Caddy and rewrites
-- the origin Host header to a realm-canonical host (intake.<zone>) so
-- Caddy serves the intake SPA and exposes ONLY /api/public/intake/*.
--
-- Single statement on purpose: ALTER TYPE ... ADD VALUE commits cleanly
-- and the value is not used elsewhere in this migration.
-- =====================================================================

ALTER TYPE cloudflare_tunnel_realm ADD VALUE IF NOT EXISTS 'INTAKE';
