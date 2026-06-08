-- 0135 — add a `kind` discriminator to client requests.
--
-- Distinguishes an engagement "drop-off" (a dated ask for the client to
-- drop off / upload information, with its own reminder semantics) from a
-- general request. Modeling drop-offs as a specialized client_request lets
-- them reuse the existing portal upload-to-fulfill flow, fulfillment
-- tracking, and reminder plumbing rather than a parallel mechanism.
--
-- Values: 'GENERAL' | 'DROP_OFF'. Defaults to 'GENERAL' so existing rows
-- and untyped creates keep current behavior.
--
-- Note: the table is vibetb.client_request (singular), qualified like
-- migrations 0069/0134.

ALTER TABLE vibetb.client_request
  ADD COLUMN kind text NOT NULL DEFAULT 'GENERAL';

ALTER TABLE vibetb.client_request
  ADD CONSTRAINT client_request_kind_ck CHECK (kind IN ('GENERAL', 'DROP_OFF'));
