-- 0198 — PENDING request status + activation date. A PENDING request (e.g. one
-- rolled forward from a prior year) is hidden from the client and the staff work
-- queue until activation_date, when the daily worker flips it PENDING→OPEN and
-- submits it to the client.
ALTER TABLE vibetb.client_request
  DROP CONSTRAINT IF EXISTS client_request_status_ck;
ALTER TABLE vibetb.client_request
  ADD CONSTRAINT client_request_status_ck
  CHECK (status IN ('OPEN', 'FULFILLED', 'DISMISSED', 'EXPIRED', 'NEEDS_INFO', 'PENDING'));

ALTER TABLE vibetb.client_request
  ADD COLUMN IF NOT EXISTS activation_date date,
  ADD COLUMN IF NOT EXISTS activated_at timestamptz;

CREATE INDEX IF NOT EXISTS client_request_pending_activation_idx
  ON vibetb.client_request (activation_date)
  WHERE status = 'PENDING';
