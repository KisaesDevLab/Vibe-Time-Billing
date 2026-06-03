# Vibe Filer — Document Inbox & Routing

### Integration Spec for Vibe Time & Billing (`KisaesDevLab/Vibe-Time-Billing`)

**Status:** Design locked, pending build plan
**Author:** Kurt / KisaesDevLab
**License:** PolyForm Internal Use 1.0.0

---

## 1. Purpose

A document-intake and routing feature built **inside** Vibe Time & Billing (not a standalone app). A batch export from tax software / a portal drops PDFs into a Backblaze B2 `Inbox/` prefix. Staff review a queue that parses each filename, matches it to a TB client, and proposes a destination folder. On commit, the file is relocated in B2 to the client's folder tree, with an option to flag a file as a tax return and hand it to the Tax Return module's processing pipeline.

This is the cloud/web evolution of the original Windows `CPAFileManager` concept: the UI and decision logic carry over; the local-filesystem backend is replaced by B2 + Postgres.

---

## 2. Locked decisions

| Area                 | Decision                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| Host                 | Module inside Vibe Time & Billing (React 18 + TS, Node 20, Express, Drizzle, PG 16, Redis 7, BullMQ) |
| Object store         | Backblaze B2, single bucket per env, firm-level prefix scoping, **customer-owned credentials**       |
| Desktop sync         | MSP360 Drive, **read-write** (staff may move/rename in Explorer)                                     |
| Source of truth      | **B2** for filed documents; Postgres tracks workflow only, never a full file mirror                  |
| Key style            | **Human-readable paths** (Explorer-synced), not UUIDs                                                |
| Inbox feeder         | Batch export → writes to `Inbox/` prefix; app discovers by **listing** (no API contract)             |
| Filename convention  | `ClientName_123456_rest.ext`, **best-effort** (not enforced)                                         |
| Embedded ID          | The **TB client ID** — direct `clients` lookup, no crosswalk                                         |
| Other signals        | **None** — filename is the only signal                                                               |
| Matching             | ID hit (green) → strict name fuzzy ≥95% (yellow) → red / manual                                      |
| Year detection       | Rolling window `current_year − 50` … `current_year + 10`                                             |
| ID pattern           | `\d{4,}` default, configurable per profile                                                           |
| Filename after route | **Strip the ID segment** → `ClientName_rest.ext`                                                     |
| Inactive clients     | Yellow warn, included by default                                                                     |
| Routing target       | Per-client skeleton folders by default; rules may define deeper subfolders                           |
| Rules                | Ordered list, first-match-wins, drag-reorder in UI                                                   |
| Profiles             | Switch **rule sets only**; folders/client master global                                              |
| Human review         | **Always** — every file lands in the queue                                                           |
| Route op             | B2 copy → Postgres log → B2 delete (idempotent BullMQ job)                                           |
| Safety / undo        | **B2 versioning**; undo = restore prior version + reverse log; batch default, per-file expand        |
| Conflict policy      | Suffix-rename `(1)`, `(2)`… default; per-row override                                                |
| Commit               | Always-on confirmation modal                                                                         |
| Tax return flag      | Per-row flag; submit → file to client tax-return folder **and** enqueue Tax Return processing job    |
| Reconciliation       | Poll-based B2 listing + SHA1 match to detect Explorer-side moves                                     |
| Telemetry / LLM      | None; deterministic                                                                                  |

---

## 3. Storage model

### 3.1 Why human-readable keys

Because B2 is mounted into Windows Explorer via MSP360 Drive (read-write), the **B2 object key path is the folder a staffer sees in Explorer**. Keys must therefore be human-readable, and moving a file out of the inbox is a real B2 relocation, not a metadata-only change.

### 3.2 Key scheme

```
firms/{firm_id}/Inbox/{original_filename}
firms/{firm_id}/Clients/{ClientFolderName}/{rule_path}/{year?}/{filename}
```

- `firm_id` — tenant scoping; B2 application keys can be scoped to `firms/{firm_id}/*`.
- `ClientFolderName` — canonical client name from the `clients` table (sanitized for path safety).
- `rule_path` — skeleton folder (e.g. `Tax Returns`) or a deeper rule-defined path (e.g. `Tax Returns\Federal`).
- `year` — present only when the matched rule's `year_behavior` calls for it.
- `filename` — original filename with the `_{ID}_` segment stripped.

### 3.3 Source of truth

B2 is canonical for filed documents. Postgres does **not** mirror the filed-document tree. The TB file browser lists B2 prefixes live (short-TTL cache). Postgres owns only: the inbox workqueue, routing rules/profiles, the immutable routing log, and (optionally) a lightweight search index that is a cache, never truth.

---

## 4. Data model (new)

Assumes existing `clients`, `folders`, `users`, `firms` tables.

### 4.1 `inbox_items` — workqueue cache

Rebuilt/upserted on each inbox scan; rows are transient and removed once routed.

```
id              uuid pk
firm_id         uuid fk firms
object_key      text            -- full B2 key under Inbox/
original_name   text
size_bytes      bigint
sha1            text            -- from B2 object metadata
discovered_at   timestamptz
-- parse + match (recomputed on scan)
parsed_name     text
parsed_id       text
parsed_year     int
match_status    text            -- matched | fuzzy | inactive | name_mismatch | year_needed | unparseable
matched_client  uuid fk clients null
suggested_rule  uuid fk inbox_routing_rules null
suggested_path  text
-- review state (persists across reloads)
review_action   text            -- file | flag_tax | skip   (null = untouched)
override_folder text null
override_year   int null
included        boolean default true
reviewed_by     uuid fk users null
UNIQUE (firm_id, object_key)
```

### 4.2 `inbox_routing_profiles`

```
id          uuid pk
firm_id     uuid fk firms
name        text            -- "1040 Season", "Audit Prep"
is_active   boolean
created_at  timestamptz
```

### 4.3 `inbox_routing_rules`

```
id              uuid pk
profile_id      uuid fk inbox_routing_profiles
sort_order      int             -- first-match-wins, drag-reorder
name            text
identifier      text            -- substring/pattern to match in filename
match_mode      text            -- contains | starts_with | regex
case_sensitive  boolean default false
target_path     text            -- skeleton folder or deeper path
year_behavior   text            -- none | current_only | current_and_next | previous
is_tax_return   boolean default false   -- pre-flags matches as tax returns
enabled         boolean default true
notes           text null
```

### 4.4 `inbox_routing_log` — immutable history / undo source

```
id                uuid pk
batch_id          uuid
firm_id           uuid fk firms
object_key_from   text
object_key_to     text null       -- null for skipped
client_id         uuid fk clients null
folder_path       text null
action            text            -- filed | tax_flagged | skipped | failed
rule_id           uuid null
b2_version_deleted text null       -- version id of the deleted inbox original (for undo)
tax_job_id        uuid null        -- BullMQ job id if flagged
user_id           uuid fk users
status            text            -- success | reversed | error
error             text null
created_at        timestamptz
```

---

## 5. Filename parsing

Format: `ClientName_NNNNNN_rest.ext`. Best-effort, so parsing degrades gracefully.

- Regex: `^(?P<name>.+?)_(?P<id>\d{4,})_(?P<rest>.+)\.(?P<ext>[^.]+)$`
  - `name` non-greedy so it anchors on the first `_\d{4,}_` boundary (handles `Smith & Co_...`).
  - `id` is `\d{4,}` by default; configurable per profile.
- Year: scan `rest` for `\d{4}` within `current_year − 50 … current_year + 10`; first in-range hit wins.
- Convention published to the export owner: client names must not contain `_`.
- Parse outcomes:
  - Clean parse → ID + name + (maybe) year.
  - Missing/short ID, name present → name-only path (fuzzy match).
  - No usable name or ID → `unparseable`.

---

## 6. Client matching

1. **ID hit** — `parsed_id` exists in `clients` → deterministic match → `matched` (green).
2. **Name fuzzy** — no ID hit but `parsed_name` matches a client at ≥95% similarity → `fuzzy` (yellow), show filename-vs-canonical diff.
3. **No match** — `unparseable` / `unknown` → red, blocked until manual assignment.

Modifiers:

- Matched client flagged inactive in `clients` → `inactive` (yellow), still included by default.
- ID matched but `parsed_name` differs materially from canonical → `name_mismatch` (yellow), surfaced inline.

(Duplicate-ID handling is largely moot since the ID is the TB client PK, but the per-row picker remains as a guard for any non-unique external mapping later.)

---

## 7. Routing rules

- Evaluated in `sort_order`, **first enabled match wins**.
- `match_mode`: `contains` (default), `starts_with`, or `regex`, against the filename.
- `target_path` resolves to a skeleton folder by default; rules may specify deeper nested paths.
- `year_behavior`:
  - `none` — no year subfolder.
  - `current_only` — one year subfolder from the parsed year.
  - `current_and_next` — parsed year and parsed year + 1.
  - `previous` — parsed year − 1.
- If a rule needs a year but the file has none → row enters `year_needed`; reviewer types the year inline before commit.
- No rule matches → default folder (per profile).
- `is_tax_return = true` rules pre-set the row's flag (reviewer can still override).

---

## 8. The route operation

Each included row is processed as an **idempotent BullMQ job**, in this order so a failure never loses the original:

1. **B2 server-side copy** `Inbox/...` → resolved `Clients/...` key (`b2_copy_file`; no egress; byte-exact + integrity-checked by B2 — no manual hash step needed).
2. **Postgres**: write `inbox_routing_log` row (capturing the inbox object's current version id), remove the `inbox_items` row — one transaction.
3. **B2 delete** the inbox original (leaves a hidden version thanks to bucket versioning).

Conflict at destination key → apply conflict policy (suffix-rename default) before step 1.
Source already gone (staffer pulled it in Explorer first) → mark `skipped`, no error.

**Undo** (batch default, per-file expand): for each log row, copy the routed object back to its inbox key (or restore the deleted inbox version) and mark the log row `reversed`. B2 versioning makes this safe.

---

## 9. Tax return flag & hand-off

- A row's `review_action` can be `flag_tax`.
- On commit, a flagged row does **both**:
  1. Routes the PDF to the client's tax-return folder (same copy→log→delete as any file).
  2. Enqueues a Tax Return processing job (bookmark extraction, selective release) referencing the **final** `object_key_to`; the tax module operates on the file in place.
- `inbox_routing_log.action = tax_flagged`, `tax_job_id` set.
- The inbox is the **shared intake** for both plain filing and tax processing — one review surface, one queue.

---

## 10. Reconciliation (Explorer-side moves)

MSP360 issues its own B2 copy+delete when a staffer moves/renames in Explorer, with no notification to the app. Since Postgres isn't a file mirror, filed-document moves need no reconciliation — the next live listing simply reflects reality.

Where reconciliation _is_ wanted (optional lightweight search index, or re-linking app-held metadata after an Explorer move): a periodic sweep lists B2, matches objects by stored **SHA1**, and updates the index. This is always a cache, never the source of truth. Conflicts/ambiguities are flagged, never auto-resolved destructively.

---

## 11. Review queue UI

Reuses the mocked Vibe Filer preview surface, adapted:

- **Context bar**: source = `Inbox/` (live count), client master = `clients` (count), active profile, refresh.
- **Row**: include checkbox · status icon · canonical client (with filename-diff when mismatched) · TB client ID · source filename + size · → resolved target (use-existing vs will-create badge, inline editable year when needed, folder override) · rule applied · status/warnings · open-in-browser.
- **Per-row action**: `File` (default) or `Flag for tax processing`.
- **Bulk**: select rows → assign folder, flag for tax, or send to a quarantine folder.
- **Statuses**: matched / fuzzy / name-mismatch / inactive / year-needed (all yellow), unparseable (red, checkbox disabled until manual assign).
- **Commit**: always-on modal — "Route N files to M folders (P flagged for tax processing)?" — notes new-folder creation and the B2-versioned, undoable safety model.
- **History**: batches from `inbox_routing_log`, expandable to per-file detail, with batch and per-file undo within the version-retention window.

---

## 12. Permissions

Inbox review/route is a **staff-only** function (firm users with a documents/filing role). Client-portal users never see the inbox. All routes carry `user_id` in the log.

---

## 13. Edge cases & failure handling

- **Source vanished pre-route** → `skipped`, surfaced in result summary.
- **Destination key collision** → conflict policy resolves before copy.
- **B2 copy succeeds, Postgres fails** → original intact; job retries idempotently.
- **Postgres succeeds, delete fails** → reconciliation/retry removes the orphan inbox object; log already correct.
- **Best-effort naming failures** → `unparseable`, blocked, manual assignment in queue.
- **Concurrent reviewers** → row-level claim (`reviewed_by`) prevents double-routing; second reviewer sees the row as taken.

---

## 14. Out of scope (v1.1+)

- Auto-routing high-confidence matches (v1 is always-human-review).
- Fiscal-year-end-aware folder naming.
- Entity-type rule scoping.
- Watch-mode / event-driven inbox processing (v1 is list-on-open + manual refresh).
- Cross-client document search index (the optional cache above).

---

## 15. To seed the build plan (needs repo specifics)

1. Existing `clients` schema — confirm the column that holds the TB client ID used in filenames, plus the active/inactive flag and canonical-name field.
2. Existing `folders` skeleton — confirm the default per-client folder names and which one is the tax-return folder.
3. The `@vibe/storage` `BlobStore` interface — confirm `copy`, `delete`, `list`, and version-aware operations exist or need adding for B2.
4. BullMQ queue/worker conventions in TB (queue names, job options, concurrency).
5. Where Tax Return processing jobs are enqueued today (queue name + payload shape) for the hand-off.
6. Auth/role model — the role gate for inbox access.
