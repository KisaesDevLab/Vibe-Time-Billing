-- =====================================================================
-- Migration: 0042_drop_existing_file_manager.sql
--
-- Phase 0 of the file-manager rebuild (see FILE_MANAGER_ADDENDUM.md
-- and the master plan). Drops the v1 file-manager tables before the
-- B2-backed sentinel design ships in subsequent migrations:
--   0043 — clients ext (tax_software_id / tax_software_kind)
--   0044 — client_folders (one row per client, path-bound)
--   0045 — folder_sync_events (sync state audit)
--   0046 — files (flat, with subfolder_path)
--   0047 — file_visibility_events + firm_folder_visibility_rules
--   0048 — storage.* permission codes
--
-- DROP order is reverse of FK dependencies. ON DELETE CASCADE on the
-- existing tables means descendants get cleared automatically.
--
-- DATA LOSS: this drops any rows in client_file / client_folder /
-- client_folder_template. Per QUESTIONS.md Q31, no real production
-- data is at risk at this point; the v1 file manager shipped in this
-- session only and was used for smoke testing.
-- =====================================================================

DROP TABLE IF EXISTS client_folder_template;
DROP TABLE IF EXISTS client_file;
DROP TABLE IF EXISTS client_folder;
