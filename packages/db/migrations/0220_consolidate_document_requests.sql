-- 0220 — consolidate document collection into the 0084 client_request
-- system. The 0219 document_requests tables shipped hours earlier and
-- duplicated what client_request + client_request_item (itemKind
-- DOCUMENT) already model; the one capability they added — direct
-- portal upload routed to a target subfolder — moves onto
-- client_request instead. Tables are dropped (no production rows
-- existed before this migration's release).

ALTER TABLE client_request
  ADD COLUMN IF NOT EXISTS target_subfolder_path text NOT NULL DEFAULT '';

DROP TABLE IF EXISTS document_request_items;
DROP TABLE IF EXISTS document_requests;
