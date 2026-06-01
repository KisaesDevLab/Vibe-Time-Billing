# Vibe Time & Billing — File Manager Addendum v2: Per-Client Linking & Conflict Resolution

> **Reads after:** `FILE_MANAGER_ADDENDUM.md` (v1). This document assumes the storage abstraction, sentinel schema, sync worker, file model, visibility model, and permission system from v1 are already built or being built. Where v1 specified _infrastructure_ (data, sync, S3 client, file uploads), this v2 specifies the _four end-user flows_ that turn that infrastructure into a usable feature: linking a single client to a folder, watching the index complete, and resolving binding conflicts when they arise.
>
> **Audience:** Claude Code, autonomous execution. Use the same execution protocol as v1 (`QUESTIONS.md`, one phase at a time, commit per phase, etc.). Where this addendum is silent or ambiguous, append to `QUESTIONS.md` and continue with the documented default.
>
> **Mockup references in this document** point to four specific UI states agreed on with the user. The visual specifications come from those mockups; this document captures the behavioral and structural requirements.

---

## 1. Scope

This addendum adds **four user-facing states** to the Files tab and admin area:

1. **Empty state** — Files tab when a client has no `client_folders` row. Centered card with primary "Link folder…" and secondary "Create new folder" actions, plus three small feature explainer cards.
2. **Link modal** — fuzzy-match dialog launched from the empty state (or from a per-client "Re-link" action). Shows candidate folders with confidence scores, match reasons, and conflict indicators. Allows linking to an existing folder or creating a new one.
3. **Post-link indexing state** — Files tab immediately after a successful link. Shows a success toast, the storage folder card in an `Indexing` substatus, a progress bar, partial stats, and files appearing in the table as the sync worker discovers them.
4. **Admin conflict resolution screen** — single-conflict detail view reached from "Open in admin" when a user tries to link to a folder already bound to another client. Side-by-side comparison of currently-bound client and challenger, with a recommended resolution and required reason field.

This addendum also introduces:

- A **match engine** (fuzzy matching service) that scores candidate folders for any given client. Used by both the per-client link modal and the bulk onboarding tool from v1 Phase 4 (which is now refactored to share this engine).
- A **conflict workflow** — what happens when `bind` is attempted on a folder that already has a sentinel pointing at a different client.
- A **firm-level Storage Conflicts dashboard** — parent list view of all open conflicts, missing folders, orphan sentinels, and discovered unbound folders. The single-conflict detail view (mockup 4) is its child.

### Out of scope for this addendum

Auto-resolution of conflicts (always human-approved). Conflict resolution via the client portal (clients have no role in resolution). Bulk reassignment (one conflict resolved at a time in v1; bulk reassignment is in `BACKLOG.md`).

---

## 2. Schema additions

These are net-new on top of v1. Migrations are numbered continuing from v1's sequence.

### 2.1 `folder_link_attempts`

Records every attempt to link a client to a folder — both successful and contested. The contested ones become the work queue for admins with `storage.folder.reconcile`.

```sql
CREATE TABLE folder_link_attempts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id             UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  client_id           UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  storage_path        TEXT NOT NULL,
  attempted_by        UUID NOT NULL REFERENCES users(id),
  attempted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  match_confidence    NUMERIC(4,3),       -- 0.000 to 1.000
  match_reason_code   TEXT,               -- 'tax_id_in_folder_name', etc. (see §3.3)
  outcome             TEXT NOT NULL DEFAULT 'pending',
                      -- 'pending','linked','contested','denied','reassigned','aborted'
  resolved_at         TIMESTAMPTZ,
  resolved_by         UUID REFERENCES users(id),
  resolution_reason   TEXT,
  notes               TEXT
);

CREATE INDEX idx_folder_link_attempts_open
  ON folder_link_attempts (firm_id, outcome)
  WHERE outcome IN ('pending','contested');

CREATE INDEX idx_folder_link_attempts_client
  ON folder_link_attempts (client_id, attempted_at DESC);
```

### 2.2 New event types in `folder_sync_events`

The `event_type` enum from v1 gains three values:

- `link_attempted` — a user successfully linked a client to an unbound folder
- `link_contested` — a user attempted to link to a folder already bound; admin review required
- `link_reassigned` — admin reassigned a contested folder from one client to another

No schema change to the column (it's `TEXT`), just a code update in the enum check or, if there's a CHECK constraint, a migration to expand it.

### 2.3 Indexing progress (no schema; transient state in Redis)

Indexing progress is broadcast over Redis pub/sub on the channel `storage:index:{client_folder_id}` and pulled by the client over Server-Sent Events. The latest snapshot per channel is also stored in a Redis hash `storage:index:state:{client_folder_id}` with TTL 1 hour, so a page refresh during indexing still shows progress without waiting for the next event tick.

Hash fields:

```
status              "queued" | "running" | "completed" | "failed"
files_total         number
files_indexed       number
bytes_indexed       number
visible_count       number
private_count       number
started_at          ISO timestamp
estimated_completion ISO timestamp
last_file_name      string (most recently indexed; for UI flavor)
```

---

## 3. Match engine

The match engine is the algorithmic core of the link modal (mockup 2) and is also called by the bulk onboarding tool (v1 Phase 4). Implementation lives in `packages/storage/match-engine.ts`.

### 3.1 Inputs

```ts
interface MatchInput {
  client: {
    id: string;
    name: string; // 'Smith, John & Mary'
    tax_software_id?: string; // '0042'
    tax_software_kind?: string; // 'ultratax' | 'lacerte' | ...
    aliases?: string[]; // alternate names entered manually
  };
  folders: FolderCandidate[]; // every top-level prefix in the firm's bucket area
  options?: {
    min_confidence?: number; // default 0.50
    max_results?: number; // default 10 for link modal, 1 for auto-bind
  };
}

interface FolderCandidate {
  storage_path: string; // 'Smith Family/'
  file_count: number;
  size_bytes: number;
  last_modified: string;
  sentinel?: {
    // present if folder has a sentinel
    client_id: string;
    display_name_at_creation: string;
  };
  bound_to?: {
    // present if sentinel resolves to a known client
    client_id: string;
    client_name: string;
  };
}
```

### 3.2 Output

```ts
interface MatchOutput {
  candidates: MatchCandidate[]; // sorted: unbound first, then by confidence desc
  unbound_count: number; // total unbound folders in firm's bucket
}

interface MatchCandidate {
  storage_path: string;
  confidence: number; // 0.0 to 1.0
  reason_code: string; // see §3.3
  reason_text: string; // user-facing string
  status: 'unbound' | 'bound_to_other' | 'bound_to_self';
  bound_to?: { client_id: string; client_name: string };
  file_count: number;
  size_bytes: number;
  last_modified: string;
}
```

### 3.3 Match reason taxonomy

| `reason_code`           | Triggered when                                                     | Confidence floor        | `reason_text` template                     |
| ----------------------- | ------------------------------------------------------------------ | ----------------------- | ------------------------------------------ |
| `tax_id_in_folder_name` | folder name contains `client.tax_software_id` as a token           | 1.000                   | `UltraTax CS ID {id} found in folder name` |
| `exact_name_match`      | normalized folder name == normalized client name                   | 0.950                   | `Exact name match`                         |
| `name_substring_match`  | normalized folder name contains all major tokens of client name    | 0.850                   | `Name match — missing "{missing}"`         |
| `name_swap_match`       | folder is "First Last" and client is "Last, First" (or vice versa) | 0.900                   | `Name match — Last/First order swapped`    |
| `fuzzy_name_match`      | Jaro-Winkler similarity ≥ 0.85 on normalized names                 | proportional, 0.65–0.84 | `Approximate name match`                   |
| `partial_token_match`   | at least one significant token (≥3 chars) shared                   | proportional, 0.50–0.64 | `Some name parts match`                    |
| `alias_match`           | normalized folder name matches one of `client.aliases`             | 0.950                   | `Matches known alias "{alias}"`            |

The engine evaluates each folder against all reason codes and keeps the highest-scoring one. A folder with both `tax_id_in_folder_name` (1.0) and `name_substring_match` (0.85) is shown with the higher reason.

### 3.4 Normalization rules

Applied to both folder name and client name before string comparison:

1. Strip trailing slash and `_Vibe/` references.
2. Strip leading IDs like `0042 - ` or `[0042] ` (recorded separately for `tax_id_in_folder_name`).
3. Lowercase.
4. Remove punctuation: `, . ' " & ( )` etc., collapse multiple spaces.
5. Strip spouse markers at end: ` and {name}`, ` & {name}`, ` plus spouse`.
6. Strip business suffixes: `llc`, `inc`, `corp`, `co`, `ltd`, `pllc`, `pa`, `ps`, `the`.
7. Split on whitespace into tokens. Tokens of length < 2 are dropped (one-letter middle initials).

After normalization, "Smith, John & Mary" → `['smith', 'john']`. "Smith Family" → `['smith', 'family']`. Match: shared token `smith`, plus `family` is a low-signal stopword (add to a `LOW_SIGNAL_TOKENS` constant: `family`, `personal`, `taxes`, `tax`, `clients`).

### 3.5 Conflict overlay

After scoring, every candidate's `status` is set based on its sentinel:

- `unbound` — no sentinel or sentinel parse failed
- `bound_to_self` — sentinel's `client_id` equals input `client.id` (already linked; idempotent)
- `bound_to_other` — sentinel's `client_id` is another known client in the firm

`bound_to_other` candidates remain in the result list (the link modal shows them with the amber treatment from mockup 2), but their Link button is disabled in the UI and they cannot be auto-bound.

### 3.6 Performance budget

For a firm with up to 5,000 unbound folders and one client query:

- Folder listing (from B2 or cache): single LIST call, < 500ms (or cache hit).
- Per-folder scoring: O(1) work, ≤ 0.1ms per folder. Total scoring step ≤ 500ms.
- Total match call: < 1s for the link modal use case.

Cache the bucket listing in Redis (`storage:listing:{firm_id}`) with TTL 5 minutes; invalidate on sync worker completion or explicit refresh.

---

## 4. API contracts

All endpoints under `/api`. JSON bodies. Permission gates noted; all are subject to firm-scoping.

### 4.1 `POST /api/clients/:id/folder/match`

Returns candidate folders for the link modal. Permission: `storage.folder.bind`.

**Response:**

```json
{
  "client": { "id": "...", "name": "Smith, John & Mary", "tax_software_id": "0042" },
  "candidates": [
    {
      "storage_path": "0042 - Smith, John/",
      "confidence": 1.0,
      "reason_code": "tax_id_in_folder_name",
      "reason_text": "UltraTax CS ID 0042 found in folder name",
      "status": "unbound",
      "file_count": 47,
      "size_bytes": 71303168,
      "last_modified": "2026-05-25T13:43:00Z"
    },
    {
      "storage_path": "Smith, John/",
      "confidence": 0.78,
      "reason_code": "name_substring_match",
      "reason_text": "Name match — missing \"& Mary\"",
      "status": "unbound",
      "file_count": 12,
      "size_bytes": 8388608,
      "last_modified": "2026-04-22T10:11:00Z"
    },
    {
      "storage_path": "Smith Family/",
      "confidence": 0.62,
      "reason_code": "partial_token_match",
      "reason_text": "Some name parts match",
      "status": "bound_to_other",
      "bound_to": { "client_id": "a7f2...", "client_name": "Smith, Sarah" },
      "file_count": 8,
      "size_bytes": 4404019,
      "last_modified": "2026-03-14T09:22:00Z"
    }
  ],
  "unbound_count": 47,
  "suggested_queries": ["0042", "Smith", "John & Mary", "Smith Family"]
}
```

`suggested_queries` powers the suggestion chips under the search input. Built from: tax_software_id, last name, first name(s), aliases.

### 4.2 `POST /api/clients/:id/folder/match/search`

Same as `match` but with a `query` parameter that filters and re-scores. Permission: `storage.folder.bind`.

**Request body:** `{ "query": "smith" }`

**Behavior:** filter candidates by substring match on `storage_path` (case-insensitive), boost confidence proportionally to query relevance, return same shape. If the bucket has been cached, this is a pure server-side operation with no B2 round-trip.

### 4.3 `POST /api/clients/:id/folder/link`

Link a client to a specific folder. Permission: `storage.folder.bind`.

**Request body:** `{ "storage_path": "0042 - Smith, John/" }`

**Logic:**

1. Verify caller has `storage.folder.bind` for this client's firm.
2. Verify client has no existing `client_folders` row, OR caller has `storage.folder.reconcile` (re-linking after unbind).
3. Read sentinel at `{storage_path}/_Vibe/client.json`.
4. **Branch:**
   - **No sentinel**: write new sentinel (client_id = this client). Create `client_folders` row with `status='active'`. Insert `folder_link_attempts` row with `outcome='linked'`. Insert `folder_sync_events` row with `event_type='link_attempted'`. Enqueue `sync-folder` job. Return 201 with `client_folder_id` and `index_channel`.
   - **Sentinel matches this client**: idempotent success. Update `client_folders.last_synced_at`. Return 200.
   - **Sentinel matches another client**: create `folder_link_attempts` row with `outcome='contested'`. Create `folder_sync_events` row with `event_type='link_contested'`. **Do not** write sentinel. **Do not** create `client_folders` row. Return 409 with body:
     ```json
     {
       "code": "folder_already_bound",
       "bound_to": { "client_id": "...", "client_name": "Smith, Sarah" },
       "attempt_id": "...",
       "admin_url": "/admin/storage/conflicts/{attempt_id}"
     }
     ```
   - **Sentinel unparseable**: return 409 with `code: "sentinel_invalid"` and admin URL.

**Response on success (201):**

```json
{
  "client_folder_id": "...",
  "storage_path": "0042 - Smith, John/",
  "status": "indexing",
  "index_channel": "storage:index:abc-123-uuid",
  "estimated_file_count": 47
}
```

### 4.4 `POST /api/clients/:id/folder/create`

Create a new folder for a client. Permission: `storage.folder.bind` plus `storage.folder.edit`.

**Request body:** `{ "folder_name": "Smith, John & Mary" }`

**Logic:**

1. Sanitize the folder name (Windows-safe; see v1 §Phase 8 sanitization).
2. Verify no existing folder with that path in the bucket.
3. Write a placeholder file `{folder_name}/_Vibe/client.json` containing the sentinel.
4. Create `client_folders` row.
5. Insert `folder_link_attempts` row with `outcome='linked'`, `match_reason_code=null`.
6. Return 201 with the same shape as `link`.

### 4.5 `GET /api/clients/:id/folder/index-status`

Server-Sent Events stream for indexing progress. Permission: `storage.folder.view`.

**Stream events:**

```
event: progress
data: {"files_indexed": 23, "files_total": 47, "visible_count": 9, "private_count": 14, "bytes_indexed": 32505856, "last_file_name": "K-1 Smith Holdings LLC.pdf"}

event: progress
data: {"files_indexed": 30, ...}

event: completed
data: {"files_total": 47, "visible_count": 18, "private_count": 29, "bytes_indexed": 71303168, "duration_ms": 28341}
```

The client (mockup 3) subscribes on link success and unsubscribes on `completed` or `failed`. UI degrades to polling every 5s if SSE fails.

### 4.6 `GET /api/storage/conflicts`

List all open conflicts and other reconciliation work for a firm. Permission: `storage.folder.reconcile`.

**Response:**

```json
{
  "conflicts": [
    {
      "id": "...",
      "type": "link_contested",
      "storage_path": "Smith Family/",
      "bound_to": { "client_id": "...", "client_name": "Smith, Sarah" },
      "challenger": { "client_id": "...", "client_name": "Smith, John & Mary" },
      "attempted_by": { "user_id": "...", "user_name": "kurt" },
      "attempted_at": "2026-05-25T13:42:00Z",
      "match_confidence": 0.62
    }
  ],
  "other_events": [
    {
      "id": "...",
      "type": "discovered",
      "storage_path": "Anderson Construction/",
      "detected_at": "..."
    },
    { "id": "...", "type": "missing", "storage_path": "Old Client X/", "detected_at": "..." },
    { "id": "...", "type": "sentinel_lost", "storage_path": "Brown, Lisa/", "detected_at": "..." }
  ],
  "counts": { "contested": 1, "discovered": 4, "missing": 1, "sentinel_lost": 1, "orphan": 0 }
}
```

### 4.7 `GET /api/storage/conflicts/:attempt_id`

Single conflict detail view (mockup 4). Permission: `storage.folder.reconcile`.

**Response:**

```json
{
  "attempt": {
    "id": "...",
    "storage_path": "Smith Family/",
    "attempted_by": "kurt",
    "attempted_at": "2026-05-25T13:42:00Z",
    "match_confidence": 0.62,
    "outcome": "contested"
  },
  "folder": {
    "storage_path": "Smith Family/",
    "file_count": 8,
    "size_bytes": 4404019,
    "last_modified": "2026-03-14T09:22:00Z",
    "sample_files": ["1099-DIV Vanguard.pdf", "Property Tax 2023.pdf", "Charitable 2023.xlsx"],
    "sentinel": {
      "version": 1,
      "client_id": "a7f2...e8c1",
      "created_at": "2024-01-12T15:30:00Z",
      "created_by_user_id": "...",
      "created_by_name": "jdoe",
      "display_name_at_creation": "Smith Family"
    }
  },
  "currently_bound": {
    "client_id": "...",
    "client_name": "Smith, Sarah",
    "tax_software_id": "0038",
    "client_status": "1040 active",
    "name_fuzzy_score": 0.94,
    "binding_age_days": 502,
    "other_folder_count": 1
  },
  "challenger": {
    "client_id": "...",
    "client_name": "Smith, John & Mary",
    "tax_software_id": "0042",
    "client_status": "1040 active",
    "name_fuzzy_score": 0.62,
    "other_folder_count": 0
  },
  "recommendation": {
    "action": "keep_current",
    "rationale": "Sentinel was written 16 months ago and the embedded client_id matches the currently bound client exactly. The challenger has a lower name match and no sentinel claim."
  },
  "audit_trail": [
    {
      "ts": "2024-01-12T15:30:00Z",
      "actor": "jdoe",
      "event": "folder_bound",
      "detail": "via Onboarding (confidence 0.98)"
    },
    {
      "ts": "2026-03-14T09:22:00Z",
      "actor": "system",
      "event": "files_added",
      "detail": "3 files via virtual drive"
    },
    {
      "ts": "2026-05-25T13:42:00Z",
      "actor": "kurt",
      "event": "link_contested",
      "detail": "Challenger: Smith, John & Mary"
    }
  ]
}
```

### 4.8 `POST /api/storage/conflicts/:attempt_id/resolve`

Apply a resolution. Permission: `storage.folder.reconcile`. Body validation: `reason` required and ≥ 10 chars if `action != 'keep_current'`.

**Request body:**

```json
{ "action": "keep_current" | "reassign" | "unbind_both", "reason": "..." }
```

**Logic per action:**

- `keep_current`: update `folder_link_attempts.outcome='denied'`, write `folder_sync_events.resolution='kept_current'`, send in-app notification to challenger user ("Your link request for Smith Family/ was denied — folder is bound to Smith, Sarah").
- `reassign`: enqueue `folder-reassign` BullMQ job (see §5). Update `folder_link_attempts.outcome='reassigned'`. Send notifications to both clients' assigned users.
- `unbind_both`: delete sentinel, soft-delete `client_folders` row for currently-bound client, update `folder_link_attempts.outcome='aborted'`. Both clients become unbound; challenger can retry linking.

All actions write to `folder_sync_events.resolution`, `resolved_by`, `resolved_at`, and `notes` (= the reason).

---

## 5. Background jobs

New BullMQ jobs on top of v1.

### 5.1 `folder-reassign`

Triggered by `reassign` resolution. Atomically transfers folder ownership.

```
1. Acquire advisory lock on storage_path
2. Read current sentinel
3. Write new sentinel with new client_id (preserve display_name_at_creation as history)
4. Soft-delete old client_folders row for previously-bound client
5. Insert new client_folders row for challenger client
6. Move/copy file rows: update files.client_id, files.client_folder_id en masse
7. Recompute visibility for all files using firm_folder_visibility_rules
8. Insert folder_sync_events row (event_type='link_reassigned')
9. Notify both clients' users
10. Release lock
```

Failure handling: on any step failure after step 3, roll back sentinel write. If file row updates fail mid-batch, mark `client_folders.status='reassigning_failed'` and require admin manual cleanup.

### 5.2 Index progress publisher

When `sync-folder` runs after a fresh link, after each batch of files indexed:

- Update Redis hash `storage:index:state:{client_folder_id}`
- Publish a `progress` event to `storage:index:{client_folder_id}` Redis channel

When indexing completes:

- Publish `completed` event
- Clear the state hash after 1 hour TTL

---

## 6. Phases

### Phase A — Match engine

**Tasks**

- `packages/storage/match-engine.ts`: implement `match(input: MatchInput): MatchOutput`.
- Normalization functions in `packages/storage/normalize.ts`: `normalizeName`, `extractTaxId`, `stripSpouseMarkers`, `tokenize`.
- Jaro-Winkler implementation (or use `natural` package if its license is acceptable — check before adding).
- `suggestedQueries(client)` helper that produces the chip queries.
- Match reason taxonomy as exported constants.
- Refactor v1 Phase 4 (bulk onboarding) to consume this engine — both flows now share scoring.

**Success criteria**

- Unit tests: 50+ cases covering the full reason taxonomy, normalization edge cases (spousal variants, business suffixes, low-signal tokens, swap order, alias matches).
- Property test: same client × same folder always yields identical score.
- Performance test: 5,000 folders × 1 client completes in < 1s on appliance hardware.
- Two real-world fixtures: a small firm with 50 clients and a large firm with 2,000 clients, verifying expected top-1 matches.

**Tests**

- `match-engine.test.ts`, `normalize.test.ts` in `packages/storage/__tests__/`.

---

### Phase B — Empty state + link modal

**Tasks**

- New React route/component: `Files` tab on client detail page detects missing `client_folders` row and renders `<UnlinkedEmptyState client={client} />`.
- `<UnlinkedEmptyState>` component matches **mockup 1**:
  - Centered card with unlinked-folder icon
  - Headline, description (uses client display name)
  - Primary `Link folder…` button — opens `<LinkFolderModal>`
  - Secondary `Create new folder` button — opens `<CreateFolderDialog>`
  - Three feature explainer cards
  - Help anchor link "How storage linking works"
  - All buttons gated by `storage.folder.bind` and `storage.folder.edit` respectively
- `<LinkFolderModal>` component matches **mockup 2**:
  - On open, fires `POST /api/clients/:id/folder/match`.
  - Loading skeleton during initial fetch.
  - Header: title, client subtitle (name + tax software ID).
  - Info bar with total unbound folder count.
  - Search input with suggestion chips (from `suggested_queries`).
  - Search input is debounced 300ms, fires `POST /api/clients/:id/folder/match/search`.
  - "Suggested matches" section with up to N candidate cards.
  - Best match (highest confidence, unbound) gets the 2px info border + "Best match" badge.
  - Each card shows: folder icon, path (mono font), reason text, confidence bar + percentage, file count, modified date, status indicator.
  - `bound_to_other` candidates: amber background, disabled Link button, "Open in admin" button (opens `/admin/storage/conflicts/...` in new tab) — visible only if user has `storage.folder.reconcile`.
  - "Browse all N other unbound folders" expander reveals lower-confidence matches.
  - Footer: "Or create new folder named `{client_name}/`" with sanitized preview and Create button.
  - Bottom-bar: permission requirement label + Cancel button.
- `<CreateFolderDialog>` — simple form: folder name (pre-filled from client name), Cancel/Create buttons.
- On Link click: call `POST /api/clients/:id/folder/link`. On 201, close modal and trigger transition to indexing state (Phase C). On 409, show inline alert and offer "Open in admin" or "Pick a different folder."

**Success criteria**

- Visiting Files tab on an unlinked client shows the empty state.
- Clicking Link folder opens the modal; candidates load within 1s for a 500-folder firm.
- Searching filters the list client-side without re-hitting B2.
- Selecting "Best match" card and clicking Link successfully binds and triggers the indexing transition.
- Selecting a `bound_to_other` candidate cannot proceed; admin link appears only for users with `storage.folder.reconcile`.
- Create new folder action works with a name that doesn't yet exist; rejected with clear error if it does.
- Accessibility: modal traps focus; ESC closes; all buttons keyboard-reachable.

**Tests**

- Component tests with React Testing Library for empty state and modal.
- E2E (Playwright): full link flow on a seeded fixture firm.

---

### Phase C — Post-link indexing UX

**Tasks**

- After successful link, the Files tab transitions from empty state to the standard files view in **indexing substate** (mockup 3):
  - Success toast at top with the new path. Auto-dismiss after 8s; manually dismissable.
  - Storage folder card displays the new path with `Indexing` badge (animated dot, info color).
  - Rename/Move buttons disabled with tooltip "Available after indexing completes."
  - Sub-card inside the storage folder card: progress bar, "X of Y files" counter, ETA, current activity label ("Applying visibility rules · computing hashes").
- `<IndexingProgressBar>` subscribes to SSE at `/api/clients/:id/folder/index-status` on mount.
- React Query mutates the files list on each `progress` event (or pulls fresh via `GET /api/clients/:id/files` every 2s while indexing).
- The file table shows partial results with a `Indexing N more files…` row pinned at the bottom while indexing.
- Stats cards (Indexed / Visible / Private / Size) update live.
- Filter/bulk action controls in the toolbar are disabled with explanatory tooltip until indexing completes.
- On `completed` event, transition to standard active state: badge becomes `Bound`, Rename/Move enable, toolbar enables, "Indexing N more files…" row disappears.

**Success criteria**

- Linking a folder containing 47 files shows progress updating at least every 2s.
- Closing and reopening the page during indexing resumes the progress view (state pulled from Redis hash).
- SSE disconnect falls back to 5s polling without losing data.
- All disabled controls during indexing have a tooltip explaining why.
- E2E: link → verify final file count matches B2 actual count.

**Tests**

- Integration test: synthetic 100-file folder, verify progress events arrive in order and final count matches.
- UI test: disabled state of Rename, Move, and toolbar during indexing.

---

### Phase D — Conflict detection + admin resolution

**Tasks**

- Conflict detection logic in `POST /api/clients/:id/folder/link` (see §4.3): returns 409 with `attempt_id` when sentinel binds to a different client.
- `<LinkFolderModal>` handles 409: inline alert "This folder is already bound to {client_name}." with two actions: "Pick a different folder" (clears selection) and "Open in admin" (opens admin URL, gated by `storage.folder.reconcile`).
- New admin route: `/admin/storage/conflicts/:attempt_id` rendering `<ConflictResolution>` matching **mockup 4**.
- `<ConflictResolution>` component:
  - Header with breadcrumb (Admin → Storage → Conflicts → {storage_path}) and "Contested" badge.
  - Description sentence pulled from API.
  - Folder summary card with sentinel detail, sample files, file count.
  - Two comparison cards side-by-side: currently bound (info-accented, "Currently bound" badge) and challenger ("Challenger" badge). Each shows: avatar/initials, client name, tax software ID, sentinel match indicator, name fuzzy score, binding age, status, other folder count.
  - Recommendation panel: lightbulb icon, rationale text from API.
  - Resolution radio group: keep_current (pre-selected), reassign, unbind_both. Each option has descriptive sub-text.
  - Reason textarea (required for non-default choices; validated client-side and server-side).
  - Audit trail panel showing all relevant events.
  - Footer: permission label + Cancel + Apply resolution.
- On Apply: `POST /api/storage/conflicts/:attempt_id/resolve`. On success, route back to `/admin/storage/conflicts` with toast confirmation. On failure, inline error.
- `folder-reassign` BullMQ job (§5.1).
- Firm-level conflicts list at `/admin/storage/conflicts` (deferred to v1.1 if needed but at minimum a basic list view showing all conflicts with click-through to detail).

**Success criteria**

- Attempting to link a contested folder shows the inline 409 alert with both action buttons.
- "Open in admin" link is hidden for users without `storage.folder.reconcile`.
- Conflict detail page renders all four cards correctly with realistic fixture data.
- Recommendation rationale matches the algorithm described in §4.7 (sentinel-age × match-confidence heuristic).
- Apply resolution with reason < 10 chars on non-default option is rejected with field error.
- `reassign` action successfully transfers folder; both clients' Files tabs reflect the change on next load.
- `keep_current` denies the attempt and the challenger sees a notification.
- All resolutions appear in `folder_sync_events` with appropriate `resolution` and `notes`.

**Tests**

- Integration test: contested link → conflict opens → admin reassigns → both clients reflect new state.
- Unit test: recommendation algorithm produces `keep_current` when sentinel-age > 30 days AND current binding name-match > challenger.

---

### Phase E — Hardening

**Tasks**

- Telemetry: emit metrics for `storage_link_attempts_total{outcome}`, `storage_match_duration_seconds`, `storage_conflicts_resolved_total{action}`.
- Audit log retention: ensure `folder_link_attempts` and `folder_sync_events` are excluded from automatic cleanup; CPAs may need years of history.
- Notification fan-out: in-app notifications to challenger on `denied`/`reassigned`/`aborted`; partner-level notification on every `reassigned` event.
- Idempotency: re-running the same `POST /folder/link` with the same body within 60s returns the same response (use a request hash table or rely on natural idempotency of the link logic).
- Concurrency: two simultaneous link attempts on the same folder by different challengers — the second one sees the first's `folder_link_attempts` row and rejects with a friendly message ("Another link attempt is being reviewed").
- Stale match results: if the bucket listing in Redis is older than 5 minutes, the link modal shows a subtle "Results may be stale — Refresh" link that re-fetches from B2.

**Success criteria**

- All metrics visible in Grafana.
- E2E race test: two browsers attempt to link same folder simultaneously; only one succeeds, the other gets a clean rejection.
- Re-link after unbind works correctly (challenger eventually gets the folder if admin reassigns).

---

## 7. Component file layout

```
packages/
  storage/
    match-engine.ts
    normalize.ts
    __tests__/
      match-engine.test.ts
      normalize.test.ts
apps/
  tb-web/
    src/
      features/
        files/
          components/
            UnlinkedEmptyState.tsx
            LinkFolderModal.tsx
            CreateFolderDialog.tsx
            CandidateCard.tsx                    # subcomponent of LinkFolderModal
            ConfidenceBar.tsx                    # 4px bar with percentage
            SuggestionChips.tsx
            IndexingProgressBar.tsx
            IndexingToast.tsx
            StorageFolderCard.tsx                # shared across all states
          hooks/
            useFolderMatch.ts                    # React Query for /folder/match
            useFolderLink.ts                     # React Query mutation
            useIndexProgress.ts                  # SSE subscription
          api.ts                                 # typed wrappers around endpoints
        admin/
          storage/
            ConflictListPage.tsx
            ConflictResolutionPage.tsx
            components/
              FolderSummaryCard.tsx
              ClientComparisonCard.tsx
              RecommendationPanel.tsx
              ResolutionForm.tsx
              AuditTrailPanel.tsx
apps/
  tb-api/
    src/
      routes/
        clients/
          folder.ts                              # /match, /match/search, /link, /create, /index-status
        storage/
          conflicts.ts                           # /conflicts, /conflicts/:id, /conflicts/:id/resolve
      services/
        match-service.ts                         # thin wrapper around packages/storage/match-engine
        link-service.ts                          # contains conflict detection branching
        reassign-job.ts                          # BullMQ worker
        index-publisher.ts                       # writes Redis hash + publishes events
```

---

## 8. Telemetry & audit completeness checklist

Every link attempt — successful, contested, or aborted — must produce exactly one `folder_link_attempts` row. Every conflict resolution must produce exactly one `folder_sync_events` row with non-null `resolved_at`, `resolved_by`, `resolution`, and `notes`.

A test at the end of Phase E enumerates every possible outcome path and asserts the audit invariants:

| Path                          | folder_link_attempts.outcome       | folder_sync_events.event_type | resolution     |
| ----------------------------- | ---------------------------------- | ----------------------------- | -------------- |
| Link unbound folder           | `linked`                           | `link_attempted`              | n/a            |
| Link contested → keep_current | `denied`                           | `link_contested` → resolved   | `kept_current` |
| Link contested → reassign     | `reassigned`                       | `link_contested` → resolved   | `reassigned`   |
| Link contested → unbind_both  | `aborted`                          | `link_contested` → resolved   | `unbound_both` |
| Create new folder             | `linked`                           | `link_attempted`              | n/a            |
| Link idempotent (same client) | `linked` (existing row, no insert) | none                          | n/a            |

---

## 9. Acceptance criteria for this addendum

- [ ] All five phases (A–E) pass success criteria.
- [ ] All four mockup states render in the app with realistic data.
- [ ] Match engine fixture tests pass for the small-firm and large-firm scenarios.
- [ ] End-to-end test: linking a fresh client → indexing completes → file table fully populated → visibility rules applied → all in under 60 seconds for a 100-file folder.
- [ ] End-to-end test: contested link → admin resolves with `reassign` → both clients reflect new state correctly.
- [ ] Permission gating verified for each new action.
- [ ] No breaking changes to v1 schema or APIs; v1 Phase 4 onboarding still functions and now uses the shared match engine.

---

## 10. Execution protocol

Identical to v1 (`FILE_MANAGER_ADDENDUM.md` §9). To recap the key rules:

1. Maintain `QUESTIONS.md` for ambiguity; document defaults and continue.
2. One phase at a time; commit after each.
3. Tests must be green before advancing.
4. Migrations append-only.
5. Match existing patterns in the codebase.
6. Stop only for destructive migrations, missing required env vars, or incompatible existing implementations.
7. Produce `IMPLEMENTATION_REPORT_V2.md` on completion.

When this addendum and v1 are both complete, Vibe T&B has a fully functional file manager backed by Backblaze B2, accessible both through the app and through a virtual drive in Windows File Explorer, with durable sentinel-based bindings, fuzzy linking for individual clients, transparent post-link indexing, and an admin-only path for resolving the inevitable conflicts that arise when humans manage folder structures by hand.

---

_End of addendum. Version 2. Supersedes nothing in v1; extends it._
