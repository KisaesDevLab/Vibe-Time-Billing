-- =====================================================================
-- Migration: 0157_provider_write_status_updated.sql
--
-- Adds the 'updated' value to provider_write_status so a successful
-- reschedule write-back can be distinguished from the original create
-- ('written') and can clear a previously 'failed' staff row. ADD VALUE
-- must live in its own migration file (cannot run in the same txn as
-- DDL that uses the new value — see 0040/0091 precedent).
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare statements only.
-- =====================================================================

ALTER TYPE vibetb.provider_write_status ADD VALUE IF NOT EXISTS 'updated';
