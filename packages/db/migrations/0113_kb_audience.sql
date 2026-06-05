-- =====================================================================
-- Migration: 0113_kb_audience.sql
--
-- Knowledge-base article audience. Existing articles are staff-facing;
-- the portal-facing AI support chat (and a client help center) must only
-- ever surface client-safe content. `audience` gates which realm can see
-- an article:
--   staff  — staff app only (default; nothing leaks to clients)
--   client — client portal only
--   both   — visible in both realms
--
-- Default 'staff' so every pre-existing (and future un-tagged) article
-- stays internal unless an admin deliberately exposes it.
-- =====================================================================

DO $$ BEGIN
  CREATE TYPE kb_audience AS ENUM ('staff', 'client', 'both');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE vibetb.kb_article
  ADD COLUMN IF NOT EXISTS audience kb_audience NOT NULL DEFAULT 'staff';

CREATE INDEX IF NOT EXISTS kb_article_firm_audience_idx
  ON vibetb.kb_article (firm_id, audience);
