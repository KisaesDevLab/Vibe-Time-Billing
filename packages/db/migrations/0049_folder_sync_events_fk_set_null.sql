-- =====================================================================
-- Migration: 0049_folder_sync_events_fk_set_null.sql
--
-- QA fix — folder_sync_events.client_folder_id had the default
-- ON DELETE NO ACTION (introduced in 0045), which made every
-- /admin/storage/unbind call FK-fail with "still referenced from
-- table folder_sync_events" whenever the row had any prior sync
-- event. The unhandled rejection crashed the api container.
--
-- ON DELETE SET NULL preserves the audit-trail rows in
-- folder_sync_events (so the "who saw what when" history survives a
-- rebinding) but lets the parent client_folders row be deleted
-- cleanly. The folder_id field becomes nullable in the event row,
-- which the schema already permits.
-- =====================================================================

ALTER TABLE folder_sync_events
  DROP CONSTRAINT folder_sync_events_client_folder_id_fkey;

ALTER TABLE folder_sync_events
  ADD CONSTRAINT folder_sync_events_client_folder_id_fkey
  FOREIGN KEY (client_folder_id)
  REFERENCES client_folders(id)
  ON DELETE SET NULL;
