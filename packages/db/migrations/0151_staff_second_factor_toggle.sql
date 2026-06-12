-- =====================================================================
-- Migration: 0151_staff_second_factor_toggle.sql
--
-- Firm-level toggle for the staff second-factor requirement (revises
-- locked decision #5). Fully internal deployments can switch it off:
-- password sign-in then issues a session directly (no 2FA challenge,
-- no enrolled-factor prerequisite) and step-up gates on sensitive
-- actions pass without a fresh TOTP/passkey. Default ON preserves
-- current behavior for every existing firm.
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare statements only. Migrate runner wraps each file in one txn.
-- =====================================================================

ALTER TABLE vibetb.firm_settings
  ADD COLUMN IF NOT EXISTS staff_second_factor_required boolean NOT NULL DEFAULT true;
