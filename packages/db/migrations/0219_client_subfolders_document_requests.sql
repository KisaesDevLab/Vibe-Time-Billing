-- 0219 — Files tab v3: persisted ad-hoc subfolders + client document requests.
--
-- client_subfolders: registry of staff-created subfolders inside a client's
-- bound storage folder. Folders were previously derived purely from the
-- paths files occupy (plus the template skeleton), so an EMPTY folder could
-- not exist and moving the last file out of an ad-hoc folder made it vanish.
-- Paths use the same trailing-slash key format as files.subfolder_path.
CREATE TABLE IF NOT EXISTS client_subfolders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firm(id) ON DELETE CASCADE,
  client_folder_id uuid NOT NULL REFERENCES client_folders(id) ON DELETE CASCADE,
  path text NOT NULL,
  created_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS client_subfolders_folder_path_uk
  ON client_subfolders(client_folder_id, path);

-- document_requests: staff ask a client for a list of documents; the client
-- uploads against each item from the portal (no staff chasing by email).
CREATE TABLE IF NOT EXISTS document_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firm(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  title text NOT NULL,
  note text,
  -- Destination subfolder for uploads (trailing-slash key; '' = folder root).
  target_subfolder_path text NOT NULL DEFAULT '',
  -- OPEN | COMPLETED | CANCELLED
  status text NOT NULL DEFAULT 'OPEN',
  created_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS document_requests_client_idx
  ON document_requests(client_id, status);

CREATE TABLE IF NOT EXISTS document_request_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES document_requests(id) ON DELETE CASCADE,
  label text NOT NULL,
  -- PENDING | UPLOADED
  status text NOT NULL DEFAULT 'PENDING',
  file_id uuid REFERENCES files(id) ON DELETE SET NULL,
  uploaded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS document_request_items_request_idx
  ON document_request_items(request_id);
