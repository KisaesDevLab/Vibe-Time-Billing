-- =====================================================================
-- Migration: 0086_billing_batch_multi_engagement.sql
--
-- One billing batch → N engagements (for the same client). The original
-- `engagement_id` column stays NOT NULL as the "primary" pointer so
-- existing readers (pre-bill review, invoice generation, recurring
-- billing) keep working unchanged. New code that needs the full set
-- joins `billing_batch_engagement` — the join table holds every
-- picked engagement, including the primary (so a count query +
-- iteration is trivial and consistent).
--
-- Invoice tables already support consolidation:
--   - invoice.primary_engagement_id is nullable
--   - invoice_line_items.engagement_id is nullable + per-line
-- so this migration only widens the batch surface.
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.billing_batch_engagement (
  billing_batch_id uuid NOT NULL
    REFERENCES vibetb.billing_batch(id) ON DELETE CASCADE,
  engagement_id uuid NOT NULL
    REFERENCES vibetb.engagement(id) ON DELETE RESTRICT,
  ordinal smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (billing_batch_id, engagement_id)
);

CREATE INDEX IF NOT EXISTS billing_batch_engagement_engagement_idx
  ON vibetb.billing_batch_engagement(engagement_id);

-- Backfill: every existing batch becomes a 1-engagement multi-batch by
-- copying its primary engagement into the join. Re-runnable via the
-- composite PK + ON CONFLICT.
INSERT INTO vibetb.billing_batch_engagement (billing_batch_id, engagement_id, ordinal)
SELECT id, engagement_id, 0
FROM vibetb.billing_batch
ON CONFLICT DO NOTHING;
