-- 0197 — track whether a client's reply on a request has been seen by staff, so
-- the Requests nav only highlights on an UNREAD client response. Cleared (null)
-- when a client replies via the portal; stamped when staff opens the request
-- detail (or authors a needs-info note themselves).
ALTER TABLE vibetb.client_request
  ADD COLUMN IF NOT EXISTS client_reply_seen_at timestamptz;
