-- =====================================================================
-- Migration: 0088_thread_client_id.sql
--
-- Adds a nullable client_id column to vibetb.thread so message
-- threads can be created at the client scope without being tied to a
-- specific engagement. Engagement-linked threads also get the column
-- populated (denormalized from engagement.client_id) so a single
-- WHERE client_id = ? returns every thread visible for a client —
-- both engagement-scoped and client-direct.
--
-- The existing 1:1 engagement_thread_link table is untouched; engagement
-- detail's "Messages" card keeps looking threads up by engagement id.
-- =====================================================================

ALTER TABLE vibetb.thread
  ADD COLUMN IF NOT EXISTS client_id uuid
    REFERENCES vibetb.client(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS thread_client_id_idx ON vibetb.thread(client_id);

-- Backfill: every engagement-linked thread inherits its engagement's
-- client. NULL stays NULL for legacy threads with no link (none in
-- production today, but the WHERE clause is defensive).
UPDATE vibetb.thread t
SET client_id = e.client_id
FROM vibetb.engagement_thread_link l
JOIN vibetb.engagement e ON e.id = l.engagement_id
WHERE l.thread_id = t.id
  AND t.client_id IS NULL;
