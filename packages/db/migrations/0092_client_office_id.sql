-- =====================================================================
-- Migration: 0092_client_office_id.sql
--
-- Every client now belongs to an office. Until now there was no link
-- between client and office at the row level, so multi-office firms
-- couldn't filter / report / route work by office. This migration:
--
--   1. Ensures every firm has at least one office (any firm seeded
--      pre-bootstrap-fix may have zero — we backfill a "Headquarters"
--      row before doing anything else).
--   2. Adds vibetb.client.office_id, initially nullable.
--   3. Backfills every existing client with its firm's default office
--      (is_default=true wins; ties broken by earliest created_at).
--   4. Adds the NOT NULL constraint and an index on (firm_id, office_id)
--      so filter queries hit it.
--
-- Restoration note: this migration is forward-only because backfilling
-- a NULL into office_id wouldn't be meaningful. Down migration drops
-- the column unconditionally.
-- =====================================================================

-- (1) Safety net — any firm without an office gets a Headquarters row.
INSERT INTO vibetb.office (firm_id, name, timezone, is_default)
SELECT f.id, 'Headquarters', 'America/Chicago', true
FROM vibetb.firm f
WHERE NOT EXISTS (
  SELECT 1 FROM vibetb.office o WHERE o.firm_id = f.id
);

-- (2) Add the column nullable so the backfill can run.
ALTER TABLE vibetb.client
  ADD COLUMN IF NOT EXISTS office_id uuid
    REFERENCES vibetb.office(id) ON DELETE RESTRICT;

-- (3) Backfill — prefer the firm's default office, fall back to the
-- earliest-created office for that firm.
UPDATE vibetb.client c
SET office_id = (
  SELECT o.id
  FROM vibetb.office o
  WHERE o.firm_id = c.firm_id
  ORDER BY o.is_default DESC, o.created_at ASC
  LIMIT 1
)
WHERE c.office_id IS NULL;

-- (4) Lock it in.
ALTER TABLE vibetb.client
  ALTER COLUMN office_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS client_office_idx
  ON vibetb.client (firm_id, office_id);
