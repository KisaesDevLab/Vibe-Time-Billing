-- =====================================================================
-- Migration: 0029_client_file.sql
--
-- v2 Sprint C — per-client file storage (workstream 1.4). The blob
-- itself lives outside Postgres (local FS in dev, MinIO/S3 in prod per
-- locked decision); this table is the metadata catalog.
--
-- storage_path is the storage adapter's opaque key. The format is up to
-- the adapter (LocalFsAdapter writes "<firm>/<client>/<uuid>", S3Adapter
-- writes the same key in the S3 bucket).
--
-- soft-delete: status enum like other tables. Archive sets status =
-- ARCHIVED and leaves the row + blob in place for retention windows.
-- =====================================================================

CREATE TABLE IF NOT EXISTS client_file (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID NOT NULL REFERENCES firm(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  engagement_id UUID REFERENCES engagement(id) ON DELETE SET NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  storage_path TEXT NOT NULL,
  uploaded_by_id UUID REFERENCES app_user(id) ON DELETE SET NULL,
  status entity_status NOT NULL DEFAULT 'ACTIVE',
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_file_client_idx
  ON client_file (client_id, status, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS client_file_engagement_idx
  ON client_file (engagement_id)
  WHERE engagement_id IS NOT NULL;
