-- =====================================================================
-- Migration: 0105_internal_messaging.sql
--
-- Staff-to-staff direct + group messaging, built on the existing
-- thread/message tables (per-thread T-DEK encryption unchanged).
--
--   thread.kind          'client' (existing client/engagement threads) or
--                        'internal' (staff-only direct + group chat).
--   thread_member.last_read_at      per-member read cursor (unread badge).
--   thread_member.last_notified_at  debounce for email/SMS notifications.
-- =====================================================================

ALTER TABLE vibetb.thread
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'client';

DO $$ BEGIN
  ALTER TABLE vibetb.thread
    ADD CONSTRAINT thread_kind_ck CHECK (kind IN ('client', 'internal'));
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE vibetb.thread_member
  ADD COLUMN IF NOT EXISTS last_read_at timestamptz;
ALTER TABLE vibetb.thread_member
  ADD COLUMN IF NOT EXISTS last_notified_at timestamptz;

-- Internal threads are listed per-firm by kind + recency.
CREATE INDEX IF NOT EXISTS thread_firm_kind_idx ON vibetb.thread (firm_id, kind, updated_at DESC);
