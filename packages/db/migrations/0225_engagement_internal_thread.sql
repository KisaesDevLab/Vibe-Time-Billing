-- =====================================================================
-- Migration: 0225_engagement_internal_thread.sql
--
-- Engagement-scoped team (internal) conversations. Each engagement may
-- have at most one staff-only thread (thread.kind = 'internal') in
-- addition to its client thread. Kept as a separate link table rather
-- than widening engagement_thread_link because every consumer of that
-- table assumes exactly one (client) thread per engagement.
--
-- Team threads are provisioned lazily — the first time a staff member
-- starts the discussion — so untouched engagements never surface in the
-- Team messages list.
-- =====================================================================

CREATE TABLE vibetb.engagement_internal_thread_link (
  engagement_id uuid PRIMARY KEY REFERENCES vibetb.engagement(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL UNIQUE REFERENCES vibetb.thread(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
