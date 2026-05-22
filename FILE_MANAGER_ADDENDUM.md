# Vibe Time & Billing — File Manager Addendum (v1)

> **Purpose:** Add a file manager to Vibe T&B that coexists with a B2-mounted virtual drive (rclone / Mountain Duck / ExpanDrive / CloudMounter) browsed via Windows File Explorer. The app must read, write, and govern files in the same client folder structure that staff currently manage by hand, without breaking when humans rename, move, or restructure folders in Explorer.
>
> **Audience:** Claude Code, autonomous execution. Follow the [Execution Protocol](#execution-protocol) at the bottom. Where this addendum is silent or ambiguous, append to `QUESTIONS.md` and continue with the documented default.

---

## 1. Context & Principles

### Why

Firms already organize client work in a folder structure (one folder per client, named after the client, mirroring their tax software layout) accessed through a virtual S3 drive backed by Backblaze B2. The T&B app must (a) bind each folder to a `clients` row durably, (b) survive user-driven renames and restructures, (c) allow the app to write files into the same structure, and (d) govern which files are visible to clients via the portal.

### Three architectural principles

1. **Sentinel as identity.** A `_Vibe/client.json` file inside each client folder carries the immutable `client_id`. Folder paths are mutable display strings; sentinels are the durable binding. Sentinels travel with renames because they are ordinary files that participate in the underlying S3 copy-then-delete.
2. **Permission, not role.** Every gated capability is a discrete permission code (`storage.folder.rename`, `storage.file.publish`, etc.). Firms assign permissions to their own roles via an admin UI. No capability is hardcoded to "admin only."
3. **Fail closed on visibility.** Any file whose `visibility` is unknown, NULL, or unparseable is private. The portal returns only files with `visibility = 'client_visible'`, evaluated at request time. Default for all newly discovered files is `private`.

### Stack alignment

React 18, TypeScript, Node.js 20, Express, **Drizzle ORM**, PostgreSQL 16, Redis 7, BullMQ, pnpm workspaces, distroless multi-stage Docker, GHCR. B2 access via the AWS SDK v3 S3 client pointed at the B2 S3-compatible endpoint.

### Out of scope for v1 (record in `BACKLOG.md`)

Watermarked PDFs, expiring shares, multi-recipient portal visibility (one client → multiple portal users), e-signature integration, client merge/split, file versioning UI, mobile uploads. Schema must not preclude these.

---

## 2. Configuration (env vars)

Add to `.env.example` and the appliance manifest. All optional values shown as defaults.

```
# Backblaze B2 (S3-compatible)
B2_ENDPOINT=https://s3.us-west-002.backblazeb2.com
B2_REGION=us-west-002
B2_BUCKET=                        # required, e.g. vibe-tb-prod
B2_KEY_ID=                        # required
B2_APPLICATION_KEY=               # required

# Storage layout
STORAGE_TOP_PREFIX=               # optional; if multi-tenant on shared bucket
STORAGE_SYSTEM_PREFIX=_system/    # for app-internal artifacts (thumbnails, OCR caches)
STORAGE_SENTINEL_FOLDER=_Vibe     # subfolder name inside each client folder
STORAGE_SENTINEL_FILE=client.json # filename inside the sentinel folder

# Sync worker
SYNC_INTERVAL_SECONDS=120
SYNC_GRACE_PERIOD_SECONDS=60      # ignore brand-new folders this fresh
SYNC_BATCH_SIZE=500
SYNC_CONCURRENCY=4

# Virtual drive (informational only — used by docs/UX copy, not by code)
VDRIVE_HINT=rclone                # rclone | mountain_duck | expandrive | cloudmounter
```

---

## 3. Schema Migrations

Migrations are numbered sequentially and reversible. Drizzle migration files in `db/migrations/`.

### 3.1 `clients` extension

```sql
ALTER TABLE clients
  ADD COLUMN tax_software_id TEXT,
  ADD COLUMN tax_software_kind TEXT;  -- 'ultratax','lacerte','gosystem','axcess','manual'

CREATE INDEX IF NOT EXISTS idx_clients_tax_software_id
  ON clients (firm_id, tax_software_id) WHERE tax_software_id IS NOT NULL;
```

### 3.2 `client_folders`

```sql
CREATE TABLE client_folders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id         UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  storage_path    TEXT NOT NULL,           -- 'Smith, John & Mary/'  (always trailing slash)
  sentinel_etag   TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
                  -- 'active','renaming','missing','conflict','orphan'
  last_synced_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, storage_path),
  UNIQUE (client_id)
);

CREATE INDEX idx_client_folders_status ON client_folders (firm_id, status)
  WHERE status <> 'active';
```

### 3.3 `folder_sync_events`

```sql
CREATE TABLE folder_sync_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id         UUID NOT NULL REFERENCES firms(id),
  client_folder_id UUID REFERENCES client_folders(id),
  event_type      TEXT NOT NULL,
                  -- 'discovered','renamed','missing','sentinel_changed',
                  -- 'sentinel_lost','conflict','orphan','restored'
  path_before     TEXT,
  path_after      TEXT,
  sentinel_payload JSONB,
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  resolved_by     UUID REFERENCES users(id),
  resolution      TEXT,
  notes           TEXT
);

CREATE INDEX idx_folder_sync_events_open
  ON folder_sync_events (firm_id, detected_at)
  WHERE resolved_at IS NULL;
```

### 3.4 `files`

```sql
CREATE TABLE files (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id           UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  client_id         UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  client_folder_id  UUID NOT NULL REFERENCES client_folders(id) ON DELETE CASCADE,
  subfolder_path    TEXT NOT NULL DEFAULT '',     -- '' or 'Invoices/' or '2024/Returns/'
  original_filename TEXT NOT NULL,
  storage_key       TEXT NOT NULL,                 -- full B2 key
  mime_type         TEXT,
  size_bytes        BIGINT NOT NULL,
  sha256            TEXT,                          -- nullable, computed lazily
  etag              TEXT,                          -- B2 ETag, for change detection
  category          TEXT,                          -- 'invoice','engagement_letter','receipt',
                                                    -- 'time_entry_support','correspondence','other'
  source            TEXT NOT NULL DEFAULT 'explorer',
                                                    -- 'app','explorer','generated'
  visibility        TEXT NOT NULL DEFAULT 'private'
                    CHECK (visibility IN ('private','client_visible')),
  uploaded_by       UUID REFERENCES users(id),
  uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ,
  UNIQUE (firm_id, storage_key)
);

CREATE INDEX idx_files_client_visibility
  ON files (client_id, visibility)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_files_folder_subfolder
  ON files (client_folder_id, subfolder_path)
  WHERE deleted_at IS NULL;
```

### 3.5 `file_visibility_events`

```sql
CREATE TABLE file_visibility_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id      UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  firm_id      UUID NOT NULL REFERENCES firms(id),
  old_value    TEXT NOT NULL,
  new_value    TEXT NOT NULL,
  changed_by   UUID REFERENCES users(id),
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason       TEXT
);

CREATE INDEX idx_file_visibility_events_file
  ON file_visibility_events (file_id, changed_at DESC);
```

### 3.6 `firm_folder_visibility_rules`

```sql
CREATE TABLE firm_folder_visibility_rules (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id             UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  subfolder_pattern   TEXT NOT NULL,    -- SQL LIKE pattern; 'Invoices', '%Client Copy%'
  default_visibility  TEXT NOT NULL CHECK (default_visibility IN ('private','client_visible')),
  priority            INT NOT NULL DEFAULT 0,
  enabled             BOOLEAN NOT NULL DEFAULT true,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_firm_visibility_rules_lookup
  ON firm_folder_visibility_rules (firm_id, enabled, priority DESC);
```

Seed default rules per firm at firm-creation time and via a backfill migration for existing firms:

| Pattern              | default_visibility | priority |
| -------------------- | ------------------ | -------- |
| `Invoices`           | `client_visible`   | 100      |
| `Engagement Letters` | `client_visible`   | 100      |
| `Client Copy%`       | `client_visible`   | 100      |
| `Workpapers`         | `private`          | 100      |
| `Internal%`          | `private`          | 100      |
| `%` (catchall)       | `private`          | 0        |

### 3.7 Permissions

```sql
INSERT INTO permissions (code, description) VALUES
  ('storage.folder.view',      'View file listings and download files'),
  ('storage.folder.edit',      'Upload, delete files; create subfolders inside bound folder'),
  ('storage.folder.rename',    'Rename or move a client''s root folder'),
  ('storage.folder.bind',      'Bind unbound folders to clients; unbind folders'),
  ('storage.folder.reconcile', 'Resolve sync conflicts (duplicates, missing, orphans)'),
  ('storage.file.publish',     'Set file visibility to client_visible'),
  ('storage.file.unpublish',   'Set file visibility from client_visible to private')
ON CONFLICT (code) DO NOTHING;
```

Default role template assignments (firm admin may override):

|                            | Owner | Manager | Staff | Bookkeeper |
| -------------------------- | :---: | :-----: | :---: | :--------: |
| `storage.folder.view`      |   ✓   |    ✓    |   ✓   |     ✓      |
| `storage.folder.edit`      |   ✓   |    ✓    |   ✓   |     ✓      |
| `storage.folder.rename`    |   ✓   |    ✓    |       |            |
| `storage.folder.bind`      |   ✓   |    ✓    |       |            |
| `storage.folder.reconcile` |   ✓   |         |       |            |
| `storage.file.publish`     |   ✓   |    ✓    |       |            |
| `storage.file.unpublish`   |   ✓   |    ✓    |   ✓   |            |

---

## 4. Phases

Each phase: tasks → success criteria → tests. Phases are sequential; do not start phase N+1 until N's success criteria pass.

### Phase 1 — Storage Abstraction & B2 Client

**Tasks**

- Create `packages/storage/` workspace package.
- Implement `StorageClient` interface: `list(prefix)`, `head(key)`, `get(key)`, `put(key, body, opts)`, `delete(key)`, `copy(srcKey, destKey)`, `presignGet(key, ttl)`, `presignPut(key, opts, ttl)`.
- Concrete implementation `B2StorageClient` using `@aws-sdk/client-s3` against B2's S3-compatible endpoint.
- Retry policy: exponential backoff, jitter, max 5 attempts. Distinguish 4xx (no retry) from 5xx / network (retry).
- Configuration from env, validated at boot via zod.
- Helpful path utilities in `packages/storage/paths.ts`: `joinPath`, `splitClientFolder`, `isSentinelPath`, `sanitizeForWindows`, `resolveCollision`.

**Success criteria**

- Unit tests pass for path utilities with edge cases (trailing slashes, embedded slashes, unicode names, reserved Windows names).
- Integration test against a real B2 test bucket (gated by env): put, head, get, copy, delete round-trip.
- Boot fails fast with a clear error if any required B2 env var is missing.

**Tests**

- `paths.test.ts` — 30+ cases for sanitize/collision/join.
- `b2.integration.test.ts` — skipped unless `B2_INTEGRATION=1`.

---

### Phase 2 — Sentinel Schema & Helpers

**Tasks**

- Define `SentinelV1` zod schema in `packages/storage/sentinel.ts`:
  ```ts
  const SentinelV1 = z.object({
    version: z.literal(1),
    client_id: z.string().uuid(),
    firm_id: z.string().uuid(),
    tax_software_id: z.string().nullable(),
    display_name_at_creation: z.string(),
    created_at: z.string().datetime(),
    created_by: z.string().uuid().nullable(),
  });
  ```
- `readSentinel(folderPath)` — returns parsed sentinel or `{ status: 'missing'|'unparseable'|'wrong_firm' }`.
- `writeSentinel(folderPath, payload)` — writes JSON, returns ETag.
- `updateSentinel(folderPath, partial)` — read, merge, write; preserves `client_id`.
- Run all migrations from §3.1–§3.3.
- Drizzle schema files for `clients` (extended), `client_folders`, `folder_sync_events`.

**Success criteria**

- Sentinel round-trip works against B2 test bucket.
- `wrong_firm` is correctly detected when sentinel's `firm_id` doesn't match the operating firm.
- `updateSentinel` cannot mutate `client_id` (assert via test).

---

### Phase 3 — Sync Worker (Folder-Level)

**Tasks**

- BullMQ queue `storage-sync` with two job types: `sync-firm` (periodic) and `sync-folder` (targeted).
- Scheduler enqueues `sync-firm` for every firm every `SYNC_INTERVAL_SECONDS`.
- `sync-firm` handler:
  1. List top-level prefixes in the firm's bucket area (delimit on `/`).
  2. For each prefix, enqueue `sync-folder` with the prefix.
  3. Mark `client_folders` rows whose paths no longer appear as `missing`.
- `sync-folder` handler:
  1. Read sentinel.
  2. Apply state machine (see below).
  3. Update `client_folders` and write `folder_sync_events` rows as appropriate.
  4. Touch `last_synced_at`.
- State machine:

  | Sentinel                 | Path matches existing row | Action                                                         |
  | ------------------------ | ------------------------- | -------------------------------------------------------------- |
  | valid, client_id known   | yes, same path            | no-op                                                          |
  | valid, client_id known   | yes, different path       | rename detected → update `storage_path`, log `renamed`         |
  | valid, client_id known   | no                        | log `restored` if client_id has a row elsewhere, else conflict |
  | valid, client_id unknown | n/a                       | log `discovered` (orphan from another firm or restored backup) |
  | missing                  | yes, path matches         | log `sentinel_lost`, status stays `active` but flag            |
  | missing                  | no match                  | log `discovered` (new unbound folder)                          |
  | unparseable              | n/a                       | log `sentinel_changed` with payload, do not auto-bind          |

- Conflict detection: if two folders share a sentinel `client_id`, set both to `conflict` and log.

**Success criteria**

- Drop a fresh folder with a valid sentinel into the test bucket → row created within one sync cycle, event logged.
- Rename a folder via direct S3 copy+delete (simulate File Explorer rename) → `storage_path` updates, status remains `active`.
- Delete sentinel → row keeps `active`, event `sentinel_lost` raised.
- Copy a folder (duplicate sentinel) → both rows go to `conflict`.
- Worker is idempotent: re-running the same sync produces no new events.

---

### Phase 4 — Onboarding / Matching Tool

**Tasks**

- Admin route `/admin/storage/onboarding` (gated by `storage.folder.bind`).
- Backend endpoint `GET /api/storage/onboarding/scan`:
  - Lists all top-level prefixes in the firm's bucket area.
  - Excludes anything matching `STORAGE_SYSTEM_PREFIX`.
  - For each, reads sentinel state.
  - For unbound folders, computes match candidates against `clients`:
    - Exact match on `tax_software_id` if the folder name contains a parseable ID (e.g. `0042 - Smith, John/` → `0042`). Confidence 1.0.
    - Normalized name match: lowercase, strip punctuation, normalize "Last, First" ↔ "First Last", strip "& spouse" variants. Confidence 0.6–0.95 depending on edit distance.
    - Returns top 3 candidates with scores.
  - Returns also: list of `clients` rows with no `client_folders` binding (unmatched clients).
- Frontend three-column UI: **Unmatched folders** | **Match preview** | **Unmatched clients**.
  - Drag-drop a folder onto a client to propose a binding.
  - Bulk "Auto-bind high confidence (≥ 0.9)" button.
  - On confirm: write sentinel, create `client_folders` row, log `discovered` resolved.

**Success criteria**

- 100-folder, 100-client test fixture: tool produces correct auto-matches when `tax_software_id` is encoded in folder names.
- Manual binding writes the sentinel and creates the row in a single transaction (failure → no partial state).
- Re-running the scan after binding shows zero unmatched folders.

---

### Phase 5 — File-Level Sync

**Tasks**

- Extend `sync-folder` handler:
  1. After folder-level reconciliation, list all objects under the folder prefix (excluding `_Vibe/`).
  2. Diff against `files` rows for that `client_folder_id`.
  3. New objects → INSERT with `source = 'explorer'`, `visibility` resolved by `firm_folder_visibility_rules`, `subfolder_path` derived from key minus folder prefix and filename.
  4. Missing objects → set `deleted_at`.
  5. ETag/size mismatch → update row, set `modified_at`.
- SHA-256 computation runs as a separate background job (`hash-file`) enqueued for newly indexed files where `sha256 IS NULL` and `size_bytes < 100MB`.
- Migrations from §3.4.

**Success criteria**

- Drop a file into a bound folder via direct S3 PUT → row appears within one cycle with correct subfolder_path.
- Delete a file → row marked deleted within one cycle.
- Replace a file (same key, different content) → ETag change detected, modified_at updated.
- File listing for a client folder with 10k files paginates correctly and completes under 2s for cached listings.

---

### Phase 6 — Visibility Model

**Tasks**

- Migrations from §3.5 and §3.6.
- Seed default `firm_folder_visibility_rules` for existing firms (one-time backfill).
- New firm creation hook seeds the same defaults.
- Rule evaluator `resolveDefaultVisibility(firmId, subfolderPath) → 'private' | 'client_visible'`:
  - Loads enabled rules ordered by priority desc.
  - First `LIKE` match wins. If none match, return `'private'`.
- Sync worker uses this when inserting new `files` rows.
- API endpoints:
  - `PATCH /api/files/:id/visibility` body `{ visibility, reason? }`
    - Requires `storage.file.publish` for `private → client_visible`.
    - Requires `storage.file.unpublish` for `client_visible → private`.
    - Writes `file_visibility_events` row.
  - `POST /api/files/bulk-visibility` body `{ file_ids[], visibility, reason? }`
  - `GET /api/firms/:id/visibility-rules` and `PUT` for managing rules (firm admin only — `firm.settings.edit`).

**Success criteria**

- Unit test: `visibility = 'martian'` is rejected by check constraint.
- Unit test: portal query never returns rows where visibility ≠ `'client_visible'`.
- Permission test: a user with `publish` but not `unpublish` can only set to client_visible, not back.
- Audit row is created on every successful change; never on a no-op.

---

### Phase 7 — Permission Wiring

**Tasks**

- Migration from §3.7. Seed permission codes.
- Update role templates with the default matrix in §3.7.
- Express middleware `requirePermission(code)` reading the user's effective permission set from `user_roles` × `role_permissions`.
- Apply to all storage endpoints (see route table below).
- Frontend `usePermission(code)` hook that returns boolean from the session payload (permissions are loaded once at login, refreshed on role change).
- All buttons/menu items gated by permission render disabled (with tooltip) or hidden based on a `gateMode` setting per UI element. Default for destructive actions: **disabled with tooltip**, so users discover what they can't do.

**Route → permission map**

| Method | Path                                    | Permission                 |
| ------ | --------------------------------------- | -------------------------- |
| GET    | `/api/clients/:id/files`                | `storage.folder.view`      |
| GET    | `/api/files/:id/download-url`           | `storage.folder.view`      |
| POST   | `/api/clients/:id/files` (upload)       | `storage.folder.edit`      |
| DELETE | `/api/files/:id`                        | `storage.folder.edit`      |
| POST   | `/api/clients/:id/folder/rename`        | `storage.folder.rename`    |
| POST   | `/api/clients/:id/folder/move`          | `storage.folder.rename`    |
| POST   | `/api/storage/onboarding/bind`          | `storage.folder.bind`      |
| POST   | `/api/storage/onboarding/unbind`        | `storage.folder.bind`      |
| POST   | `/api/storage/conflicts/:id/resolve`    | `storage.folder.reconcile` |
| PATCH  | `/api/files/:id/visibility` → publish   | `storage.file.publish`     |
| PATCH  | `/api/files/:id/visibility` → unpublish | `storage.file.unpublish`   |

**Success criteria**

- API responds 403 with a structured `{code, missing_permission}` body when permission is absent.
- Frontend hides or disables the right controls under each default role.
- Firm admin can grant `storage.folder.rename` to a custom "Senior Staff" role and that role gains the capability without an app restart.

---

### Phase 8 — App Upload Path

**Tasks**

- `POST /api/clients/:id/files`:
  1. Resolve `client_folders.storage_path` for the client (404 if unbound).
  2. Read body params: `category`, `subfolder_path` (optional), `visibility` (optional), `original_filename`, `size_bytes`, `mime_type`.
  3. If `subfolder_path` not provided, auto-route by category:
     - `invoice` → `Invoices/`
     - `engagement_letter` → `Engagement Letters/`
     - `time_entry_support` → `Time Entry Support/`
     - `receipt` → `Receipts/`
     - other → `''` (folder root)
  4. Sanitize filename: strip `<>:"|?*\\/`, replace control chars, reject reserved Windows names, strip trailing periods/spaces, enforce `len(key) ≤ 1024` and basename ≤ 240.
  5. Resolve collision: if `{key}` exists, append ` (2)`, ` (3)`, … to basename pre-extension until free.
  6. If `visibility` not provided, resolve via `firm_folder_visibility_rules`.
  7. Issue presigned PUT URL valid for 15 minutes.
  8. Insert `files` row with `source = 'app'` and a `pending_upload` flag (add column if missing or use a separate `pending_uploads` table — pick one and document).
  9. Client uploads directly to B2.
  10. Client POSTs `/api/files/:id/complete` → server HEADs the object, sets ETag/size, clears pending flag.
- `POST /api/clients/:id/files/generated`: same as above but server-side PUT directly (for invoices/letters generated inside the app). Skip presigned URL.

**Success criteria**

- Upload of `Invoice <draft>.pdf` sanitizes to `Invoice draft.pdf` and lands at `{clientFolder}/Invoices/Invoice draft.pdf`.
- Duplicate name uploads resolve to ` (2)`, ` (3)`.
- Upload completes successfully then file is visible in File Explorer (via mounted drive) at the same path.
- A failed `complete` step leaves the `pending_upload` row, swept by a janitor job that deletes orphaned pending entries after 30 minutes.

---

### Phase 9 — Folder Modification Jobs

**Tasks**

- BullMQ queue `storage-mutation` with job `folder-rename`:
  ```
  1. SELECT pg_advisory_xact_lock(hashtext(client_folder_id::text))
  2. UPDATE client_folders SET status='renaming'
  3. Write _Vibe/.locked marker file
  4. LIST objects under old prefix
  5. For each: COPY to new prefix (parallel, max SYNC_CONCURRENCY)
  6. Verify count, size, ETag of each copy
  7. UPDATE sentinel: display_name_at_creation (preserve client_id)
  8. DELETE originals
  9. UPDATE files.storage_key, subfolder_path for all rows
  10. UPDATE client_folders.storage_path
  11. Write _Vibe/.locked removal
  12. Insert audit row in folder_sync_events (event_type='renamed')
  13. UPDATE client_folders SET status='active'
  ```
- Job `folder-move`: identical mechanics with new parent prefix.
- Both jobs emit progress events to a `storage-progress:{client_folder_id}` Redis channel; the UI subscribes via Server-Sent Events.
- On failure: leave a `folder_sync_events` row with `event_type='renamed'`, `resolution='failed'`, error in notes. Run a manual cleanup job to reconcile partial state.

**Success criteria**

- Rename of a 500-file folder completes in under 90s on the appliance hardware.
- Concurrent rename attempts: second one fails fast with "Operation in progress."
- Mid-rename crash (kill the worker) leaves the system in a recoverable state — `status='renaming'` flagged in admin UI, with a "Resume / Rollback" action.
- Sentinel after rename has the same `client_id` and updated `display_name_at_creation`.

---

### Phase 10 — Client Detail UI

**Tasks**

- New tab on the client detail page: **Files**.
- Sub-sections:
  - **Storage folder** card: shows current path, status, last synced. Buttons: Rename (gated), Move (gated), Refresh from storage. Status badges for `missing`, `conflict`, `renaming`.
  - **File browser**: subfolder tree on the left, file table on the right.
  - **File table columns**: name, subfolder, size, modified, uploader, visibility (icon toggle), download.
  - **Toolbar**: filter (all / visible / private), search by name, bulk select + actions (set visibility, delete, move to subfolder).
  - **Upload button**: opens dialog with subfolder picker (populated from listing), visibility default preview, file picker.
- Use React Query for file listings with optimistic UI on visibility toggles.
- Connect to SSE channel during rename operations to show progress bar.

**Success criteria**

- File browser renders 5,000-file folder in under 1s after data load.
- Visibility toggle reflects in the UI before the API responds (optimistic), and rolls back on error.
- Upload dialog defaults match the firm's visibility rules.
- Rename progress bar updates live during a folder rename.

---

### Phase 11 — Client Portal File Listing

**Tasks**

- Portal endpoint `GET /portal/files`:
  ```sql
  SELECT id, original_filename, subfolder_path, size_bytes, uploaded_at
  FROM files
  WHERE client_id = $1
    AND visibility = 'client_visible'
    AND deleted_at IS NULL
  ORDER BY uploaded_at DESC
  LIMIT 200;
  ```
- Portal endpoint `GET /portal/files/:id/download`:
  - Re-check `visibility = 'client_visible'` AND `client_id = session.client_id` AND `deleted_at IS NULL`.
  - Issue presigned GET URL valid for 5 minutes.
  - Log download in `file_access_log` (new table — add it).
- Rate limit: 60 downloads per portal user per hour (config).
- The portal UI lists files grouped by subfolder, with file-type icons.

**Success criteria**

- Manual test: flipping a file from `client_visible → private` in the staff app removes it from portal listing on next refresh (no stale URLs work either — pre-signed URL endpoint re-checks).
- Negative test: a portal user cannot download a file from a different client (forced ID guess returns 403).
- Audit row in `file_access_log` exists for every download.

---

### Phase 12 — Testing, Hardening, Observability

**Tasks**

- **Unit tests**: sanitizer, collision resolver, sentinel parse, visibility resolver, permission middleware, rule evaluator. Target ≥ 90% coverage on these modules.
- **Integration tests** against B2 test bucket: full sentinel round-trip; rename preserves binding; orphan detection; conflict detection.
- **End-to-end tests** (Playwright):
  1. User uploads a file via the app → it appears at the right path in a separately-mounted virtual drive.
  2. User drops a file into the mounted drive → it appears in the app within one sync cycle.
  3. Staff rename a client folder via app → portal user still sees the same visible files.
  4. Staff publish then unpublish a file → audit log records both events.
- **Failure injection**:
  - Kill sync worker mid-pass → restart, no duplicates created.
  - Corrupt a sentinel JSON → folder shows `sentinel_changed`, no auto-rebinding.
  - Race app rename vs Explorer drop → late-arriving file in old prefix is picked up by post-rename sweep.
- **Load test**: 10k files, 100 clients, sync completes in under 5 minutes on appliance hardware. Memory stays under 512MB.
- **Observability**:
  - Structured logs (pino) with `firm_id`, `client_id`, `client_folder_id`, `job_id` correlation.
  - Prometheus metrics: `storage_sync_duration_seconds`, `storage_sync_events_total{event_type}`, `storage_files_indexed_total`, `storage_upload_bytes_total`, `storage_permission_denials_total`.
  - Health endpoint reports sync worker last-heartbeat.
- **Backup verification**: documented procedure for restoring a bucket from B2 lifecycle rules; sentinel design ensures restored folders self-rebind.

**Success criteria**

- All test suites green in CI.
- Manual failure injection runbook passes.
- Load test target met.
- Metrics visible in the appliance's Grafana panel.

---

## 5. Data & Migration Order

Migrations must run in this order; each is reversible.

1. `0001_files_storage_clients_ext` — §3.1
2. `0002_files_storage_client_folders` — §3.2
3. `0003_files_storage_folder_sync_events` — §3.3
4. `0004_files_storage_files` — §3.4
5. `0005_files_storage_visibility_events` — §3.5
6. `0006_files_storage_visibility_rules` — §3.6 (+ seed step for existing firms)
7. `0007_files_storage_permissions` — §3.7 (+ seed step for existing roles)

Each migration ships with a corresponding `down` migration. On rollback of `0007`, role assignments persist (only the permission rows are dropped via `ON DELETE CASCADE` on `role_permissions`).

---

## 6. Operational Notes

**Virtual drive `_system/` hiding.** Document in the appliance setup guide how to exclude `_system/` from the mount:

- rclone: `--exclude "_system/**"`
- Mountain Duck: filter rule on bookmark
- ExpanDrive: hidden item pattern
- CloudMounter: filter

**Sentinel folder visibility.** The `_Vibe/` folder will be visible to users in Explorer by design. Its presence is the documentation: it sorts to the top alphabetically and its name signals "system folder, do not modify." Do not attempt to hide it; the cross-platform story for hidden-file attributes via S3 mounts is not reliable.

**B2 lifecycle rules.** Configure on the bucket:

- Versioning: ON (recover from accidental deletes / overwrites).
- Hide older versions after 30 days; delete after 7 years (CPA retention).
- No object-level encryption keys controlled by Kisaes — bucket uses B2's server-side encryption with B2-managed keys, customer-owned bucket.

**Sentinel `client_id` reuse caution.** Never let the same `client_id` appear in two active sentinels. The sync worker enforces this by marking both as `conflict` and refusing to auto-resolve.

---

## 7. UI/UX Strings (placeholders)

Centralize all user-facing strings in `i18n/en.json` under the `files.` namespace. The implementer may use these defaults; copy is non-final:

- `files.folder.missing` — "This client's folder isn't in cloud storage. It may have been moved or deleted. Refresh from storage or rebind in Onboarding."
- `files.folder.conflict` — "More than one folder claims this client. Resolve in the Storage Conflicts panel."
- `files.folder.renaming` — "Renaming in progress — {{count}} of {{total}} files copied."
- `files.visibility.private` — "Private (staff only)"
- `files.visibility.client_visible` — "Visible in client portal"
- `files.visibility.cannot_publish` — "You don't have permission to publish files to the client portal."
- `files.upload.subfolder_picker_hint` — "Saved here unless you choose another folder."

---

## 8. Acceptance Criteria for v1 Complete

- [ ] All twelve phases pass their success criteria.
- [ ] A fresh appliance install can: connect to B2, scan an existing bucket of unmanaged client folders, walk through onboarding, bind every folder.
- [ ] After onboarding, a user can drag a file into Explorer and see it in the app; upload a file in the app and see it in Explorer; rename a client via the app and have files follow.
- [ ] A file's visibility can be toggled with permission gating; portal honors visibility strictly.
- [ ] All migrations are reversible; rollback to schema before this addendum is clean.
- [ ] CI green; failure-injection runbook executed once successfully.

---

## 9. Execution Protocol

You are Claude Code executing this addendum autonomously. Follow this protocol throughout:

1. **Start by creating `QUESTIONS.md`** at the repo root. Append entries here whenever an instruction is silent or ambiguous, using this format:

   ```
   ## Q{n} — {short title} [{phase}]
   Context: ...
   Assumed default: ...
   Implication if wrong: ...
   ```

   Continue working with the documented default. Do not stop to ask.

2. **One phase at a time.** Do not start phase N+1 until phase N's success criteria pass. Commit after each phase with message `feat(files): phase N — {title}`.

3. **Tests are not optional.** Each phase ends with a green test suite for that phase's scope before you proceed.

4. **Migrations are append-only.** Never edit a migration after it has been applied. Add a new migration to fix mistakes.

5. **Schema as source of truth.** If you find a conflict between this document and the actual Drizzle schema files (e.g. column already exists with different type), prefer the schema and add a `Q` entry.

6. **Use existing patterns.** Match the existing T&B codebase's conventions for routing, middleware, error formatting, logging, and frontend component structure. Do not introduce new libraries without recording the decision in `QUESTIONS.md`.

7. **Stop conditions.** Stop and surface to the user only if:
   - A migration would be destructive to existing data (e.g. dropping a column with rows).
   - A required env var has no reasonable default.
   - You discover the existing app already has a partial implementation of this feature in a non-compatible direction.

8. **Final deliverable.** When all twelve phases are complete and `Acceptance Criteria` is checked, produce `IMPLEMENTATION_REPORT.md` summarizing what was built, what's in `QUESTIONS.md`, and any items deferred to `BACKLOG.md`.

---

_End of addendum. Version 1._
