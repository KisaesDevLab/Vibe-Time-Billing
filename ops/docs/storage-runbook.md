# Storage runbook

Operational reference for the file-manager v2 stack
(`FILE_MANAGER_ADDENDUM.md`, Phases 1–12). Covers the failure-injection
scenarios from §4 Phase 12 plus the day-to-day recovery procedures.

## Components at a glance

| Component | File | Cadence |
|---|---|---|
| Folder-level sync | `apps/worker/src/jobs/storage-sync.ts` | `SYNC_INTERVAL_SECONDS` (default 120s) |
| File-level diff | embedded in storage-sync orchestrator | same tick |
| SHA-256 hashing | `apps/worker/src/jobs/hash-file.ts` | every 5 min, bounded by `HASH_BATCH_SIZE` |
| Pending-upload janitor | `apps/worker/src/jobs/pending-upload-sweep.ts` | every 5 min |
| Folder rename | `apps/worker/src/jobs/folder-rename.ts` | on-demand via BullMQ `storage-mutation` queue |
| Storage abstraction | `packages/storage/` (Mock / B2) | n/a |

Worker exposes `/metrics` (text/plain Prometheus 0.0.4) on port
`WORKER_HEALTH_PORT` (default 3003). Storage-specific metric names
live in `apps/worker/src/metrics.ts`.

## Environment knobs

- `STORAGE_PROVIDER` — `mock` (default) | `b2`
- `STORAGE_LOCAL_PATH` — mock-backing FS root (default `/data/storage-mock`)
- `STORAGE_TOP_PREFIX` — bucket area to scan
- `STORAGE_SYSTEM_PREFIX` — skipped (default `_system/`)
- `STORAGE_SENTINEL_FOLDER` / `_FILE` — default `_Vibe` / `client.json`
- `SYNC_INTERVAL_SECONDS` — folder-level sync cadence (default 120)
- `STORAGE_SYNC_CONCURRENCY` — parallel object copies during rename (default 8)
- `HASH_BATCH_SIZE` — hash worker per-tick cap (default 50)
- `HASH_SIZE_LIMIT_BYTES` — max file size to hash (default 100MB)
- `PENDING_UPLOAD_MAX_AGE_MIN` — sweep threshold (default 30)
- `B2_ENDPOINT` / `B2_REGION` / `B2_BUCKET` / `B2_KEY_ID` /
  `B2_APPLICATION_KEY` — required when `STORAGE_PROVIDER=b2`

## Failure-injection drills

### 1. Kill the sync worker mid-tick

```bash
# Terminal A: tail the worker log
docker logs -f vibe-tb-worker

# Terminal B: SIGKILL once you see "storage-sync tick complete" starting
docker kill --signal SIGKILL vibe-tb-worker
```

**Expected:** No partial state. Sync ticks are idempotent and the
file-level diff applies per-folder transactions. The next tick rolls
forward from observable state.

**Recovery:** `docker compose up -d worker`.

### 2. Corrupt a sentinel

```bash
# With STORAGE_PROVIDER=mock:
echo '{ "broken' > /data/storage-mock/<folder>/_Vibe/client.json
```

**Expected within one sync cycle:**
- `client_folders.status` stays unchanged at the row level.
- A `folder_sync_events` row with `event_type='sentinel_changed'` and
  `sentinel_payload = { reason: 'unparseable', raw_error: '…' }`.
- The Storage Onboarding admin UI surfaces the row in its
  Problems list.
- Metric `storage_sync_events_total{event_type="sentinel_changed"}`
  increments once (then stays steady on subsequent ticks — the
  dedupe-against-open-events rule keeps the event quiet).

**Recovery:** Rewrite the sentinel from staff side via the
`POST /api/staff/admin/storage/bind` endpoint (or fix the JSON
in-place), then mark the event resolved via the admin UI.

### 3. Race app rename vs. Explorer drop

Trigger via:
- POST `/api/staff/clients/:id/folder/rename` while a user is
  actively copying files into the folder through the mounted drive.

**Expected:**
- Step 2 of the orchestrator CAS-flips `status` to `renaming`. The
  user's drive copy continues against the OLD prefix.
- New files dropped during the LIST→COPY window are NOT picked up by
  this rename (they land at the old path); they'll be discovered by
  the next sync tick after the rename completes (status flips back
  to `active`).
- Marker file `_Vibe/.locked` exists in the old folder for the
  duration of the rename.

**Recovery if rename fails mid-flight:**
- `status` stays `renaming`. Admin sees the folder in this state
  on the client-detail Files tab.
- A `folder_sync_events` row with `event_type='renamed'` and
  `resolution='failed'` carries the error.
- Admin calls `POST /api/staff/clients/:id/folder/resolve` with
  `{action: 'mark_active'}` after manually cleaning up via B2/mount,
  or `{action: 'mark_missing'}` to start over.

### 4. Two folders with the same sentinel `client_id`

```bash
# With STORAGE_PROVIDER=mock:
cp -r /data/storage-mock/Smith /data/storage-mock/Smith-copy
```

**Expected within one sync cycle:**
- Both client_folders rows transition to `status='conflict'`.
- Two `folder_sync_events` rows with `event_type='conflict'` (one
  per side).
- Metric `storage_sync_events_total{event_type="conflict"}` += 2.

**Recovery:** Delete the duplicate via the mounted drive (or
`storage.delete` from a maintenance shell), then call
`POST /api/staff/clients/:id/folder/resolve` with
`{action: 'mark_active'}`.

### 5. Presigned PUT abandoned mid-upload

```bash
# 1. POST /api/staff/clients/:id/files reserves a slot, returns uploadUrl.
# 2. Close the browser before PUT'ing.
```

**Expected:**
- Row sits with `pending_upload=true` for up to
  `PENDING_UPLOAD_MAX_AGE_MIN` minutes (default 30).
- File-level sync diff skips the row (pending_upload guard).
- Janitor sweeps it at the next 5-min tick once expired; row hard-
  deleted, best-effort `storage.delete()` of any partial bytes.
- Metric `storage_pending_uploads_swept_total` increments once
  the sweep runs.

### 6. Sentinel disappears under a bound folder

```bash
rm /data/storage-mock/Smith/_Vibe/client.json
```

**Expected within one sync cycle:**
- `client_folders.status` stays `active` (per the addendum's
  "sentinel_lost keeps active but flags" rule).
- A `folder_sync_events` row with `event_type='sentinel_lost'`.
- Admin sees a "Sentinel file missing" entry in Storage Onboarding.

**Recovery:** Re-bind via the onboarding flow OR have staff manually
restore the sentinel file (its full payload is in the original
`POST /admin/storage/bind` audit_log row).

## Reconciliation checklist

Run weekly or after any of the above incidents:

1. `SELECT count(*) FROM client_folders WHERE status <> 'active';`
   — expect 0 in steady state.
2. `SELECT count(*) FROM folder_sync_events WHERE resolved_at IS NULL;`
   — expect 0 in steady state.
3. `SELECT count(*) FROM files WHERE pending_upload = true AND uploaded_at < now() - INTERVAL '1 hour';`
   — expect 0 (janitor sweeps in 30 min).
4. `SELECT count(*) FROM files WHERE sha256 IS NULL AND deleted_at IS NULL AND pending_upload = false AND size_bytes < 100*1024*1024;`
   — should drain to 0 within a few HASH_BATCH_SIZE ticks. A stalled
   queue here usually means a storage outage; check
   `/health/redis` + the storage client config.

## When to escalate to the user

- A `folder_sync_events` row with `resolution='failed'` and
  `event_type='renamed'` that's older than one hour — the rename
  job's "Resume / Rollback" UX hasn't been exercised yet.
- A non-decreasing `storage_files_hashed_total` while the backlog
  gauge stays high — the hash worker can't reach storage.
- `client_folders.status='renaming'` older than 30 minutes — the
  rename worker died mid-flight; admin needs to choose Resume or
  Rollback.

## Load-test target (Phase 12 §4)

> 10k files / 100 clients sync in under 5 minutes on the appliance
> image.

Synthetic seed:

```bash
# With STORAGE_PROVIDER=mock pointing at a tmpfs:
for i in $(seq 1 100); do
  mkdir -p "/data/storage-mock/Client-${i}/_Vibe"
  uuidgen | jq -nR --arg id "$(uuidgen)" \
    '{ version: 1, client_id: $id, firm_id: $id, tax_software_id: null,
       display_name_at_creation: "Client \($i)", created_at: (now | todateiso8601),
       created_by: null }' \
    > "/data/storage-mock/Client-${i}/_Vibe/client.json"
  for j in $(seq 1 100); do
    head -c 1024 /dev/urandom > "/data/storage-mock/Client-${i}/file-${j}.bin"
  done
done
```

Then time a single sync tick:

```bash
# Triggers an immediate fire of the scheduled storage-sync job.
docker exec vibe-tb-worker node -e "import('./dist/jobs/storage-sync.js').then(({runStorageSyncTick}) => /* … */)"
```

The five-minute SLO holds on mock (local FS) at the time of writing.
B2 will be slower per-object due to HTTP round-trips; on real
hardware budget ≈40ms per object as a rule of thumb (i.e. for 10k
objects expect ≈7 min). Tune `STORAGE_SYNC_CONCURRENCY` upward for
B2 deployments — the default 8 is appropriate for the mock loopback.
