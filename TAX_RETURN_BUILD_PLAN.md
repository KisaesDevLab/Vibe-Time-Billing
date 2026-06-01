# Tax Return Module — Build Plan

**Repository:** `KisaesDevLab/Vibe-Time-Billing`
**Apps touched:** `apps/portal` (client) · `apps/web` _or staff-equivalent_ (firm)
**Scope:** Ingest, release, view, and selectively share tax-return PDFs — driven by UltraTax-style PDF bookmarks — across both the client portal and the staff "view-as-client" perspective.
**Companion to:** `CLIENT_PORTAL_BUILD_PLAN.md` § 2.9 · `CLIENT_PORTAL_UI_PLAN.md` § 5 / § 8
**Status of the prototype today:** `TaxDocsScreen` + `TaxReturnViewerScreen` + `ShareDialog` are scaffolded in `screens-aux.jsx`. Schedules are mock arrays; no real PDF, no real share token, no staff side, no audit log. **This plan replaces the mock with a working module.**

---

## 0. Foundational concept — UltraTax bookmarks are the source of truth

UltraTax CS, Lacerte, GoSystem, and CCH Axcess all emit PDF returns with `/Outlines` (PDF bookmarks) describing the structure of the return. A typical UltraTax 1040 "Client Copy" looks like:

```
Federal
├── Form 1040                                    pp. 1–2
│   ├── Schedule 1 — Additional Income           p. 3
│   ├── Schedule 2 — Additional Taxes            p. 4
│   └── Schedule 3 — Additional Credits          p. 5
├── Schedule A — Itemized Deductions             pp. 6–7
├── Schedule B — Interest & Ordinary Dividends   p. 8
├── Schedule D — Capital Gains                   pp. 9–11
│   └── Form 8949                                pp. 12–13
├── Schedule E — Supplemental Income             pp. 14–16
└── Form 8606 — Nondeductible IRA                p. 17
State — Illinois                                 pp. 18–22
State — Wisconsin                                pp. 23–26
Worksheets                                       pp. 27–40   ← typically Preparer Copy only
```

For 1120-S / 1065, the K-1 packages become first-class:

```
Form 1120-S                                      pp. 1–5
Schedule K-1 — Maya Calderón                     pp. 6–7
Schedule K-1 — Devin Holland                     p. 8
Schedule K-1 — Sasha Kim                         p. 9
Schedule L (balance sheet)                       p. 10
Schedule M-1                                     p. 11
Schedule M-2                                     pp. 12–13
```

**Implication.** We do **not** hand-curate a schedules list per return (the prototype's `TAX_DOCS[].schedules` array). We parse the PDF outline tree on ingest and persist the structure. Every downstream feature — viewer sidebar, selective release, selective share, audit log per section, recipient-scoped subset PDF — keys off this parsed structure.

**Reality check.** Outlines are _usually_ present in UltraTax output but not _always_. Some firms re-print returns through "Print to PDF" workflows that flatten bookmarks. The ingest pipeline must handle three cases:

1. **Bookmarked PDF** (the common case) — parse `/Outlines`, normalize titles, persist sections.
2. **Flat PDF with detectable headers** — fallback: run OCR-light text extraction on page 1 of each candidate page boundary and regex-match against a form-header lexicon (`^Form \d{3,4}[A-Z\-]?$`, `^Schedule [A-Z]( |$)`, `^Schedule K-1`, etc.).
3. **Truly unstructured PDF** — degrade to a single "Full return" section spanning all pages; staff can edit sections by hand in the admin UI.

---

## 1. Today (prototype)

| Artifact                             | Location                                | State                                                                                                 |
| ------------------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `TaxDocsScreen` (list)               | `screens-aux.jsx:1492`                  | Mock — reads `TAX_DOCS` from `data.jsx`                                                               |
| `TaxReturnViewerScreen` (single doc) | `screens-aux.jsx:1585`                  | Mock — `PdfPagePlaceholder` is a faked PDF page; schedules sidebar reads hard-coded `schedules` array |
| `ShareDialog` (3-step wizard)        | `screens-aux.jsx:1837`                  | UI complete — submits to in-memory state, no server                                                   |
| `ShareRow` (recipient row)           | `screens-aux.jsx:1788`                  | Complete                                                                                              |
| `SHARE_ROLES` lexicon                | `data.jsx:436`                          | Complete — drop-in for the real recipient picker                                                      |
| Roadmap pins                         | `data.jsx:840` (`taxdocs`, `taxViewer`) | Reference for what the prototype promised                                                             |
| Staff side                           | —                                       | **Nothing exists.** Greenfield.                                                                       |
| Server                               | —                                       | **Nothing exists.** Greenfield.                                                                       |
| Storage                              | —                                       | **Nothing exists.** Greenfield.                                                                       |

The UI is the easy part. Everything below it needs to be built.

---

## 2. Data model

All tables under schema `tax` to keep the namespace clean. Monetary values in BIGINT cents (matches `Vibe-Trial-Balance` convention).

### `tax.returns` — one row per filed return (or draft awaiting release)

| Column                     | Type                     | Notes                                                                                                       |
| -------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `id`                       | uuid pk                  |                                                                                                             |
| `client_id`                | uuid fk → `clients`      | The entity the return is for                                                                                |
| `engagement_id`            | uuid fk null             | Engagement that produced the return                                                                         |
| `tax_year`                 | int                      | e.g. 2025                                                                                                   |
| `form_code`                | text                     | `1040`, `1120-S`, `1065`, `1120`, `1041`, `990`, `706`, etc.                                                |
| `jurisdiction`             | text default `'federal'` | `'federal'`, `'IL'`, `'WI'`, … — a multi-jurisdiction return is a single row; states are sections inside it |
| `title`                    | text                     | Human label: "2025 S-Corporation Return"                                                                    |
| `status`                   | text                     | `draft` / `parsed` / `review` / `approved` / `released` / `superseded`                                      |
| `release_kind`             | text                     | `original` / `amended` / `superseded`                                                                       |
| `amends_return_id`         | uuid fk null             | If amended, points at predecessor                                                                           |
| `filed_at`                 | timestamptz null         | Date filed with the agency                                                                                  |
| `refund_or_owed_cents`     | bigint null              | Negative = owed                                                                                             |
| `source_file_id`           | uuid fk → `files`        | The original PDF the staff uploaded                                                                         |
| `source_file_sha256`       | text                     | Tamper hash; recomputed on every parse                                                                      |
| `total_pages`              | int                      |                                                                                                             |
| `parsed_at`                | timestamptz null         |                                                                                                             |
| `released_at`              | timestamptz null         | When **any** release was published to a client                                                              |
| `released_by_user_id`      | uuid null                |                                                                                                             |
| `created_at`, `updated_at` | timestamptz              |                                                                                                             |

### `tax.return_sections` — one row per outline entry

| Column                | Type                                      | Notes                                                                                        |
| --------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `id`                  | uuid pk                                   |                                                                                              |
| `return_id`           | uuid fk → `tax.returns` on delete cascade |                                                                                              |
| `ordinal`             | int                                       | Outline traversal order, stable across parses                                                |
| `parent_section_id`   | uuid fk null                              | Hierarchical bookmarks (Federal → Form 1040 → Schedule A)                                    |
| `depth`               | smallint                                  | Cached depth for fast tree rendering                                                         |
| `raw_title`           | text                                      | Bookmark title verbatim                                                                      |
| `normalized_title`    | text                                      | After lexicon pass: `Schedule A`, `Schedule K-1`, `Form 8949`                                |
| `kind`                | text                                      | `cover` / `main_form` / `schedule` / `k1` / `state` / `worksheet` / `attachment` / `unknown` |
| `form_code`           | text null                                 | `Schedule A`, `1040-X`, `K-1`, etc. — when identifiable                                      |
| `recipient_name`      | text null                                 | For K-1s — "Maya Calderón"                                                                   |
| `recipient_tin_last4` | text null                                 | For K-1s — last 4 only                                                                       |
| `start_page`          | int                                       | 1-indexed, inclusive                                                                         |
| `end_page`            | int                                       | Inclusive                                                                                    |
| `releasable`          | boolean default `true`                    | Staff toggle: `false` for preparer notes, worksheets, etc.                                   |
| `page_sha256`         | text                                      | Hash of the section's page bytes (subset PDF integrity)                                      |
| `parse_confidence`    | smallint                                  | 0–100; lexicon match strength                                                                |
| `created_at`          | timestamptz                               |                                                                                              |

### `tax.return_releases` — one row per (return × client release)

A "release" is the snapshot the firm publishes for the client to see. Distinct from a share — a release scopes _what the client sees in their portal_. A share scopes _what a 3rd party sees through the client's share link._ The client can never share more than the firm released to them.

| Column                  | Type                                 | Notes                                                                                               |
| ----------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `id`                    | uuid pk                              |                                                                                                     |
| `return_id`             | uuid fk                              |                                                                                                     |
| `released_to_client_id` | uuid fk → `clients`                  | Usually equals `tax.returns.client_id`, but a partnership's K-1 release goes to each partner-client |
| `scope`                 | text                                 | `full` / `selected`                                                                                 |
| `section_ids`           | uuid[]                               | When `scope='selected'`; ordered by ordinal                                                         |
| `client_can_download`   | boolean default `true`               | View-only releases for sensitive cases                                                              |
| `cover_note`            | text null                            | Renders above the viewer                                                                            |
| `released_by_user_id`   | uuid                                 |                                                                                                     |
| `released_at`           | timestamptz                          |                                                                                                     |
| `revoked_at`            | timestamptz null                     | Soft-revoke (client sees "withdrawn" pill)                                                          |
| **Unique**              | `(return_id, released_to_client_id)` | One live release per (return, client). Re-release replaces.                                         |

### `tax.return_shares` — one row per client-to-3rd-party share

Matches the prototype's `ShareDialog` shape 1:1, plus token + crypto.

| Column                                         | Type                            | Notes                                                              |
| ---------------------------------------------- | ------------------------------- | ------------------------------------------------------------------ |
| `id`                                           | uuid pk                         |                                                                    |
| `return_id`                                    | uuid fk                         |                                                                    |
| `release_id`                                   | uuid fk → `tax.return_releases` | Guarantees the share is bounded by what the client was released    |
| `shared_by_access_id`                          | uuid fk → `client_access`       | Which identity created the share                                   |
| `recipient_name`                               | text                            |                                                                    |
| `recipient_email`                              | text                            |                                                                    |
| `recipient_phone`                              | text null                       | If present, 2FA defaults to SMS                                    |
| `organization`                                 | text                            |                                                                    |
| `role`                                         | text                            | One of `SHARE_ROLES`                                               |
| `access_level`                                 | text                            | `view_only` / `view_download`                                      |
| `scope`                                        | text                            | `full` / `selected`                                                |
| `section_ids`                                  | uuid[]                          | Subset of `release.section_ids` — server enforces                  |
| `expires_at`                                   | timestamptz                     |                                                                    |
| `require_2fa`                                  | boolean default `true`          |                                                                    |
| `verify_channel`                               | text                            | `sms` / `email` / `none`                                           |
| `watermark`                                    | boolean default `true`          |                                                                    |
| `token_hash`                                   | text                            | Argon2id of the share token. **Plaintext token only at issuance.** |
| `wrapped_dek`                                  | bytea                           | Per-share data-encryption key wrapped under the platform KEK       |
| `personal_message`                             | text                            |                                                                    |
| `status`                                       | text                            | `sent` / `viewed` / `expired` / `revoked`                          |
| `sent_at`, `first_viewed_at`, `last_viewed_at` | timestamptz                     |                                                                    |
| `view_count`                                   | int default 0                   |                                                                    |
| `revoked_at`, `revoked_by_access_id`           | nullable                        |                                                                    |

### `tax.return_access_log` — every touch

| Column             | Type                      | Notes                                                                                                                                         |
| ------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | uuid pk                   |                                                                                                                                               |
| `return_id`        | uuid fk                   |                                                                                                                                               |
| `share_id`         | uuid fk null              | Null = direct client/staff access                                                                                                             |
| `actor_kind`       | text                      | `client` / `staff` / `recipient` / `system`                                                                                                   |
| `actor_ref`        | text                      | `client_access.id`, `users.id`, or `tax.return_shares.id`                                                                                     |
| `actor_ip`         | inet                      |                                                                                                                                               |
| `actor_user_agent` | text                      |                                                                                                                                               |
| `event`            | text                      | `parsed` / `released` / `revoked` / `view` / `download` / `page_render` / `2fa_sent` / `2fa_passed` / `2fa_failed` / `expired` / `superseded` |
| `page_number`      | int null                  |                                                                                                                                               |
| `section_id`       | uuid null                 |                                                                                                                                               |
| `metadata`         | jsonb                     |                                                                                                                                               |
| `at`               | timestamptz default now() |                                                                                                                                               |

Partitioned by month — these rows are append-only and high-volume for active firms.

---

## 3. Phase 1 — Ingestion pipeline (staff app)

**Why.** Nothing downstream works without parsed sections.

**Library choices.** Node-only stack, no AGPL.

- **`pdfjs-dist`** (Apache 2.0) — read `/Outlines` via `pdfDocument.getOutline()`. Returns the bookmark tree with destination refs. Resolve each ref to a page index with `pdfDocument.getPageIndex(dest[0])`.
- **`pdf-lib`** (MIT) — copy pages to a new document for subset extraction and watermark stamping.
- **`tesseract.js`** (Apache 2.0) — OCR fallback for flat PDFs.
- Avoid PyMuPDF (AGPL); avoid PDF.co / cloud parsers (data residency).

**UI (staff app — `pages/Returns.tsx`).**

1. **Upload card.** Drag-and-drop. Accepts PDF up to 50MB. On drop, POST `/api/firm/tax/returns/upload`. Server stores the file, kicks off a BullMQ job, returns the new `return_id` immediately.
2. **Parse status panel.** Shows progress: _Uploaded → Parsing outlines → Normalizing → Hashing → Ready for review._ Pulls from a Redis channel via SSE.
3. **Section editor.** When parsed, render the parsed tree alongside the rendered PDF (PDF.js inline). Each row: drag handle, title (editable), kind dropdown, start/end pages (editable), `releasable` checkbox. Re-ordering writes `ordinal`. Saving recomputes `page_sha256`.
4. **Reparse button.** Re-run the parser with current options; useful when the bookmark normalization lexicon updates.
5. **Header detection assist (when no bookmarks).** Sidebar shows candidate header pages with the regex match that fired; one-click "Make this a section starting here."

**Server.**

- `POST /api/firm/tax/returns/upload` — multipart, returns `{ returnId, jobId }`.
- `POST /api/firm/tax/returns/:id/reparse`
- `PATCH /api/firm/tax/returns/:id` — title, status, refund_or_owed_cents
- `PATCH /api/firm/tax/returns/:id/sections/:sid`
- `POST /api/firm/tax/returns/:id/sections` — manual section creation
- `DELETE /api/firm/tax/returns/:id/sections/:sid`

**Worker (BullMQ queue `tax:parse`).**

1. Read PDF from storage; SHA-256 it; persist on `tax.returns.source_file_sha256`.
2. `pdfjs.getOutline()` → walk tree, build flat list with `ordinal`, `parent_section_id`, `depth`, `start_page`.
3. Compute `end_page` for each: the page before the next sibling's start, or `total_pages` for the last in tree.
4. Run `normalized_title` lexicon pass — see § 3.1.
5. If `getOutline()` returns null/empty, run the **header-detection fallback** — see § 3.2.
6. Per-section `page_sha256` over the byte range.
7. Update `tax.returns.status = 'parsed'`; push completion to the SSE channel.

### 3.1 Normalization lexicon

A YAML file at `apps/web/server/tax/lexicon.yaml`. Pattern → `(form_code, kind, normalized_title)`. Maintained as part of release notes.

```yaml
patterns:
  - re: '^Form 1040(?:-SR)?\b'
    form_code: '1040'
    kind: main_form
    normalized: 'Form 1040'
  - re: '^Form 1120-?S\b'
    form_code: '1120-S'
    kind: main_form
    normalized: 'Form 1120-S'
  - re: '^Schedule K-1.*?[—\-]\s*(.+?)$'
    form_code: 'K-1'
    kind: k1
    normalized: 'Schedule K-1'
    recipient_capture: 1 # group 1 is the partner/shareholder name
  - re: '^Schedule ([A-Z])\b'
    form_code: 'Schedule {1}'
    kind: schedule
    normalized: 'Schedule {1}'
  - re: '^State[\s—\-]+(.+)$'
    form_code: 'State'
    kind: state
    normalized: 'State — {1}'
  - re: '^Worksheets?\b'
    form_code: null
    kind: worksheet
    normalized: 'Worksheets'
    default_releasable: false # never auto-release preparer worksheets
```

K-1 recipient_name passes through a normalize step (strip TIN if present in the label — UltraTax sometimes embeds them).

### 3.2 Header-detection fallback

When no outlines, sample text from each page with `pdfjs.getTextContent()` and look at the top ~10% of the page only (form headers are top-of-page). Same lexicon, lower `parse_confidence` (capped at 60). Adjacent pages with the same detected form_code merge into one section. Staff reviews/edits in the UI before approving.

### 3.3 Definition of Done — Phase 1

- [ ] Upload a real UltraTax 1040 PDF → sections table populated, every bookmark accounted for, page ranges contiguous.
- [ ] Upload an 1120-S with K-1s → each K-1 has `recipient_name` populated, `kind='k1'`.
- [ ] Upload a flat PDF → header detection produces ≥1 section per visible form.
- [ ] Edit a section title; save; reparse does **not** clobber the edit (manual edits are sticky — track `is_manual_override`).

---

## 4. Phase 2 — Page-range subset extraction

**Why.** Every read (client viewer, recipient viewer, "Schedule L only" share) renders a _derived_ PDF that contains only the in-scope sections, watermarked appropriately. The original PDF is never served to a non-staff actor.

**Approach.**

- For each `(return_id, ordered section_ids, watermark_payload)` tuple, generate the derived PDF on demand and cache it.
- Cache key: `sha256(return_id || section_ids_sorted || watermark_payload_canonical)`.
- Storage: object store (Caddy-fronted internal S3 in the appliance build, or filesystem in single-host mode).
- TTL: 24h for client/staff renders; the share render TTL = share's `expires_at`.

**Steps in code (`apps/web/server/tax/extract.ts`).**

1. Load the source PDF via `PDFDocument.load()`.
2. `dest.copyPages(src, [pageIndices...])` over the union of section page ranges, preserving order.
3. Stamp watermark on every page — see § 4.1.
4. If `access_level === 'view_only'`, set PDF permissions to disallow printing/copying and serve through a viewer that disables download. (Permissions are _advisory_ — clients with adversarial intent can defeat them. The real defense is "don't release sensitive sections in the first place.")
5. Return `Uint8Array`; stream to caller.

### 4.1 Watermarking

- **Client direct view.** Diagonal watermark with the _client name + viewed-at timestamp_. Faint (8–10% opacity) so it doesn't impede reading.
- **Staff "view-as-client" view.** Watermark says `VIEW AS CLIENT · {staff_name} · {timestamp}` in slightly stronger contrast. Hard to mistake for a real client copy.
- **Share recipient view.** Watermark says `{recipient_email} · {recipient_org} · viewed {timestamp}`. Stronger contrast (15–20% opacity). One stamp per page, rotated −30°, centered.

Implementation: `pdf-lib` text drawing with `StandardFonts.HelveticaBold`, opacity via `opacity: 0.1`, rotation via `rotate: degrees(-30)`. Pre-flatten the watermark onto the page so it survives screenshotting + recompression.

### 4.2 DoD — Phase 2

- [ ] Extract `[Schedule L]` from a 14-page 1120-S → derived PDF is exactly 1 page.
- [ ] Extract `[K-1 — Maya Calderón]` from the same → 2 pages, recipient name on watermark.
- [ ] Cache hit on second request — verified by log.
- [ ] view-only PDF cannot be saved via Chrome's PDF viewer (acknowledging the limit — see note above).

---

## 5. Phase 3 — Staff release workflow

**Why.** A parsed return is internal until the firm explicitly releases it. Release is a deliberate, audited act.

**UI (staff app — `pages/Returns.tsx` detail view).**

Three states drive the layout:

| State               | What staff sees                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `parsed` / `review` | Section editor (Phase 1 UI) + **Mark ready for partner review** button                                                   |
| `review`            | Read-only section list + **Approve & release** button (visible only to users with `firm.role IN ('partner', 'manager')`) |
| `released`          | Audit log + **Withdraw release**, **Release amended** actions                                                            |

The release modal:

1. Step 1 — **Choose recipient client.** Default = `tax.returns.client_id`. For 1120-S / 1065, optionally extend to "Also release K-1s to each shareholder's portal" — produces N additional releases scoped to each partner's K-1 sections only.
2. Step 2 — **Choose scope.** _Full return_ / _Selected sections._ Pre-populates `releasable=true` sections.
3. Step 3 — **Cover note.** Optional paragraph rendered above the viewer for the client.
4. Step 4 — **Notification choice.** Email / SMS / both — respects client's notification prefs.
5. Step 5 — **Confirm.** Shows: client name, section count, "this client will be able to share these sections with up to N 3rd parties (rate-limited)."

**Server.**

- `POST /api/firm/tax/returns/:id/releases` — body: `{ clientId, scope, sectionIds, coverNote, clientCanDownload, notify }`
- `DELETE /api/firm/tax/returns/:id/releases/:rid` — withdraws the release; client portal shows "withdrawn" pill on the return; any in-flight 3rd-party shares get `status='revoked'`.

**Side effects on release.**

- Notification fired (`tax.return.released` event).
- A `tax_documents` `files` row is **not** created — the return lives in `tax.*` tables only; the Files page shows it via a virtual file projector (Phase 4).
- Audit log entry `event='released'`.

### 5.1 DoD — Phase 3

- [ ] Partner-role user can release; manager-role can mark for review; staff-role cannot release.
- [ ] Releasing 1120-S with "also release K-1s" creates N+1 releases.
- [ ] Withdrawing a release revokes all dependent 3rd-party shares within 1 second.

---

## 6. Phase 4 — Client viewer (portal)

**Why.** Replace `PdfPagePlaceholder` with real rendering.

**UI (portal — `pages/TaxReturn.tsx`, replaces prototype's `TaxReturnViewerScreen`).**

Layout matches the prototype:

- Left rail: **Sections** card from the parsed outline. Hierarchical when `depth > 0`. Click jumps to `start_page`.
- Center: **PDF viewer** using `pdfjs-dist` (canvas render). Pagination strip stays; add **fit to width / fit to page / 100%** zoom controls and a **Search** input that searches the rendered PDF.
- Right rail: **Shared with** card listing this client's active shares of this release; **Share** button → opens existing `ShareDialog`, now wired to the server.

The viewer requests the derived PDF for the _release scope_ — never the original.

**Endpoint.**

- `GET /api/portal/tax/returns/:returnId.pdf` → returns the derived PDF for the calling client's release. 404 if no release exists.
- `GET /api/portal/tax/returns/:returnId/meta` → returns release metadata: `{ id, title, year, form, filed_at, sections: [...], shares: [...], cover_note, client_can_download }`.

**Section sidebar behavior.**

- Sections that are released render normally.
- Sections that are _not_ released (when staff used `selected` scope) **do not appear** in the sidebar — the client never sees that they exist. This is the explicit semantic: a withheld section is invisible, not greyed out.

**Multi-entity behavior.**

- When an identity has access to multiple clients, the Tax Documents nav shows a roll-up. The viewer is always scoped to one `release_id` at a time.

### 6.1 DoD — Phase 4

- [ ] A released 1040 renders pages 1–17 inline.
- [ ] An 1120-S released with K-1s-only scope to a shareholder shows only their K-1 — the rest of the return is invisible in the sidebar.
- [ ] Jump-to-section moves the viewer to the correct `start_page` within ~150ms.
- [ ] On mobile (<720px), sidebar collapses into a dropdown above the viewer.

---

## 7. Phase 5 — Staff "view-as-client" mode

**Why.** Partners want to see exactly what the client will see _before_ releasing — and want a way to debug "client says page 3 is missing" without phone tag.

**Approach.** A staff-only impersonation session — read-only, audited.

**UI.**

- On every staff-side screen scoped to a client (`Clients/[id]/*`, `Returns/[id]`), a header chip: **View as client** (icon + dropdown listing `client_access` identities for that client).
- Click → opens portal in a new tab at `/portal?impersonate=acc_xyz&signature=...`. The portal renders normally with a sticky red banner at top: `VIEW AS CLIENT · {client_name} · {access_email} · {staff_name}` + an **Exit** button.
- All UI is read-only: forms disabled, `Share` button replaced with a tooltip "Cannot share from impersonation session," `Download` works (staff legitimately need to download what client downloads).

**Server.**

- `POST /api/firm/clients/:clientId/impersonate` — body: `{ accessId }`. Issues a signed short-lived token (5 min) with claims `{ kind: 'staff_impersonation', client_id, access_id, staff_user_id, exp }`. Returns the URL.
- The portal recognizes this token, sets a session context with `is_impersonation: true`, and the API middleware enforces read-only.
- Every API call during impersonation is logged with `actor_kind='staff'` AND a `metadata.impersonating_access_id` field on each `tax.return_access_log` row. This is important: the client's own access history should distinguish _they_ viewed something from _staff viewed on their behalf_.

**Audit-log surfacing.**

- In the **client's** Profile → Access history, staff impersonation events render as: _"Sasha Kim (your CPA) viewed your 2025 1120-S on Apr 12. Reason: Pre-release review."_ — clear, not hidden.

### 7.1 DoD — Phase 5

- [ ] Partner can impersonate; staff with `firm.role='staff'` cannot.
- [ ] Impersonation tokens expire in 5 min.
- [ ] Attempts to POST/PATCH/DELETE during impersonation return 403.
- [ ] Client's own access history shows the impersonation event with the staff member's name.

---

## 8. Phase 6 — Selective share to 3rd party (client)

**Why.** The flagship feature. Replace the prototype's in-memory `ShareDialog` with a wired implementation.

**UI.** The prototype's `ShareDialog` is good — minor changes:

1. Step 2 — **Scope picker.** When `scope='selected'`, the chip list is generated from the _client's release sections_, not the whole return. Server enforces this constraint on submit. Schedules marked `releasable=false` at parse time were already excluded at release; they never reach the share UI.
2. Step 3 — **Review.** Add a line: _"This link is one-time issuance. If you need to re-send to {recipient}, you'll generate a new link."_ (Tokens are one-shot — see § 9 for verification.)
3. Pre-fill the share with a sensible default: if recipient phone matches a pattern, default `verify_channel='sms'`.

**Server.**

- `POST /api/portal/tax/returns/:returnId/shares` — body matches the `ShareDialog` form. Server:
  1. Validates `release_id` belongs to caller's client_access.
  2. Validates every `section_id` is in `release.section_ids`.
  3. Generates a 32-byte token (`crypto.randomBytes(32).toString('base64url')`).
  4. Generates a per-share DEK; wraps under the platform KEK; persists `wrapped_dek`.
  5. Persists `token_hash = argon2id(token)`.
  6. Returns `{ shareId, status, sentAt }`. The plaintext token is only in the **outbound email/SMS to the recipient**, never in the API response.
- `POST /api/portal/tax/returns/:returnId/shares/:shareId/revoke`
- `POST /api/portal/tax/returns/:returnId/shares/:shareId/resend` — generates a new token, invalidates the old one, re-emails.

**Outbound notification.**

- Email template includes the share URL: `https://{firm_domain}/shared/tax/{token}`.
- SMS includes a short share-launch URL (URL shortener within the appliance, not external).
- Email body shows: sender name, return year + form, schedule list (when `scope='selected'`), expiry date, personal message, instructions for the verification step.

### 8.1 Rate limits

- Per client_access: max 50 shares created per 24h; max 10 active per return.
- Per recipient email: max 5 active shares across all clients (cross-tenant rate — prevents a leaky email from being weaponized).
- Hard 90-day cap on `expires_at` regardless of "never" option in the UI (the "never" option is removed for tax docs).

### 8.2 DoD — Phase 6

- [ ] Client creates a share with `scope='selected'`, picks 2 of 8 sections → the derived PDF served to the recipient has exactly those pages.
- [ ] Attempt to include a section_id not in the release → 400 with explicit "section not in your release scope" message.
- [ ] Revoke fires within 1 second; recipient's next access attempt sees a revoked page.

---

## 9. Phase 7 — 3rd-party recipient page

**Why.** This is the public-internet-facing surface and the highest-risk one. Treat accordingly.

**Routing.**

- `https://{firm_domain}/shared/tax/{token}` — totally separate from the portal. No portal nav, no portal session. Rate-limit aggressively per IP.

**Flow.**

1. **Token resolve.** Server hashes incoming token with `argon2id` (same params as issuance), looks up the share by `token_hash`. Constant-time match. On miss → generic "link not found or expired" page (no distinction).
2. **Expiry check.** If `expires_at < now()`, mark `status='expired'`, log event, show expired page with "Ask {sender_name} to resend."
3. **Revoked check.** Same — show "This link has been revoked" with `sender_name`.
4. **2FA gate** (if `require_2fa`). Show "We'll send a 6-digit code to {channel_hint}." Channel hint:
   - SMS: last 4 of phone — `… 0148`.
   - Email: domain only — `… @chase.com`.
   - The recipient enters the code; server verifies; sets a short-lived session cookie scoped to this share.
5. **Watermark consent.** Single inline notice: _"Every page you view is watermarked with your email and the current time. Each access is logged and visible to {sender_name} and their firm."_
6. **Render.** PDF viewer (same `pdfjs-dist` as the portal — but in a stripped chrome). Pagination + section sidebar (built from the share's `section_ids`). When `access_level='view_only'`, a **Download** button is absent; right-click-save is intercepted at the viewer level (acknowledging the limit).
7. **Logging.** Every page render writes a `tax.return_access_log` row. Page renders are throttled to 1/sec/share to prevent log spam from auto-scroll.

**Page chrome.**

- Top bar: firm logo + small text _"You're viewing a document {client_name} shared with you through {firm_name}."_
- No "back" — this is a one-page surface.
- Mobile-first: most lenders open these on a phone.

**Security checklist.**

- HSTS, X-Frame-Options DENY (no embedding the recipient page), CSP that disallows external script/img except the firm CDN.
- Token never logged anywhere except the outbound channel.
- Each PDF byte stream is signed with a short-lived URL fragment (max 60s), so a recipient can't share their browser tab URL and re-stream.
- The session cookie is `__Host-share_sess` — `Secure`, `SameSite=Strict`, path-locked to `/shared/tax/{token}`.

### 9.1 DoD — Phase 7

- [ ] Token lookup is constant-time (Argon2id), independent of token validity.
- [ ] 2FA fail count: 5 failed codes → share auto-revokes, event `2fa_failed` logged with each attempt + `revoked` logged on auto-revoke.
- [ ] PDF stream URL expires; re-load works; copying the stream URL into a new tab after 90s gets a 404.
- [ ] Recipient cannot navigate to sections outside the share's `section_ids`.

---

## 10. Phase 8 — Audit log + access history

**Why.** Clients want "who saw what, when." Firms need it for engagement-quality and SOC-2-flavored requests.

**Surfaces.**

| Where                                         | What it shows                                                                                                                      |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Client portal: `Profile → Access history`     | Their own views, staff impersonation views, every share recipient's accesses to their shares. Grouped by share.                    |
| Client portal: Tax Document detail right rail | Per-share: view count + last viewed. (Already in prototype.)                                                                       |
| Staff app: `Clients/[id] → Tax → Access log`  | Everything in the client view, plus internal events (parsing, release, revoke), plus the impersonation events from the staff side. |
| Staff app: `Returns/[id] → Activity`          | Same data filtered to one return.                                                                                                  |

**Endpoint.**

- `GET /api/portal/tax/returns/:id/access-log?cursor=...` — client-visible events only.
- `GET /api/firm/tax/returns/:id/access-log?cursor=...` — all events.

**Pagination.** Cursor-based (`(at, id)` tuple). Page size 50. Older-than-90-days events are summarized into a single "Earlier activity" rollup (5,000+ rows of bank-recipient page renders are unhelpful in the UI).

**Export.** Staff export-to-CSV button — full log, no rollup. For audit defense.

### 10.1 DoD — Phase 8

- [ ] Every `view` / `download` / `2fa_*` / `release` / `revoke` event is logged with actor + IP.
- [ ] Client sees their own data only; recipient identifiers are visible (the client _knows_ who they shared to).
- [ ] Staff CSV export contains all rows verbatim — no rollup.

---

## 11. Phase 9 — Lifecycle jobs

**BullMQ queues.**

| Queue                     | Job                                             | Cadence                                                |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------------ |
| `tax:parse`               | `parseReturn(returnId)`                         | On upload                                              |
| `tax:notify-release`      | `notifyClientOfRelease(releaseId)`              | On release                                             |
| `tax:notify-share`        | `notifyRecipientOfShare(shareId)`               | On share create                                        |
| `tax:notify-share-viewed` | `notifyClientOfShareView(shareId, accessLogId)` | On first view + then throttled 1/day per share         |
| `tax:expire-shares`       | `markExpiredShares()`                           | Cron every 5 min                                       |
| `tax:remind-expiring`     | `remindRecipientOfImpendingExpiry(shareId)`     | Cron daily — fires 48h and 2h before `expires_at`      |
| `tax:render-cache`        | `precomputeDerivedPDFs(returnId, releaseId)`    | After release — warm cache for the client's first open |

Workers run in the same Node.js process pool as the API (Kurt's convention for the appliance build).

### 11.1 DoD — Phase 9

- [ ] A share with `expires_at` in the past gets `status='expired'` within 5 min of expiry.
- [ ] 48h-and-2h reminders fire exactly once each.
- [ ] Cache warming makes the client's first viewer load <500ms on a 40-page return.

---

## 12. Phase 10 — Amended returns + versioning

**Why.** Real returns get amended. A 1040-X supersedes the original but the original must remain accessible to anyone with an active share.

**Behavior.**

- Staff creates a new `tax.returns` row with `release_kind='amended'`, `amends_return_id=<original>`.
- On approval, the original gets `status='superseded'` but is **not deleted** — existing shares to it continue to work until they expire. New shares cannot be created against superseded returns.
- The client portal shows both with the original marked `Superseded · See Amended` and the amended one prominently featured.
- A small **What changed** badge on the amended record opens a side-by-side schedule diff (only schedule presence + page counts — not a line-item diff; that's too brittle).

### 12.1 DoD — Phase 10

- [ ] An amended return shows up alongside the original; original is marked superseded.
- [ ] Existing shares to the superseded return remain viewable until expiry.
- [ ] No new shares can be created against a superseded return.

---

## 13. Phase 11 — Encryption-at-rest specifics

**Why.** Tax returns are the most sensitive document type in the firm. Default `files` table encryption is necessary but not sufficient.

**Approach.**

- Platform KEK (master) lives in `Vibe Shield` vault (per the broader appliance design) or, for firms without Vibe Shield, in a Postgres-pgcrypto-wrapped column in `app.kek_store` under a passphrase set at first-run.
- Per-return DEK encrypts: source PDF, derived PDFs, watermark blob.
- Per-share DEK encrypts: the share's pinned subset PDF (so revocation can be a key-deletion event).
- All DEKs wrapped under KEK; only the wrapped form is persisted.
- Logs (`tax.return_access_log`) are **not** encrypted at the row level — they need to be queryable. They get standard at-rest encryption via the underlying volume.

### 13.1 DoD — Phase 11

- [ ] No PDF bytes are readable on disk without a decrypted DEK.
- [ ] Revoking a share deletes the share's wrapped_dek; the recipient's cached PDF stream becomes un-decryptable on the very next access.

---

## 14. Phase mapping

This module slots into the larger `CLIENT_PORTAL_BUILD_PLAN.md` phase scheme as the long-form expansion of § 2.9. Within itself:

| Plan phase                      | Maps to portal-plan phase | Size |
| ------------------------------- | ------------------------- | ---- |
| 1 — Ingestion + bookmarks       | Portal 16+                | M    |
| 2 — Subset extraction           | Portal 16+                | S    |
| 3 — Staff release workflow      | Portal 16+                | M    |
| 4 — Client viewer               | Portal 16+                | M    |
| 5 — Staff view-as-client        | Portal 16+                | S    |
| 6 — Selective share (3rd party) | Portal 16+                | M    |
| 7 — Recipient page              | Portal 16+                | M    |
| 8 — Audit log                   | Portal 16+ + 2.14         | S    |
| 9 — Lifecycle jobs              | Portal 16+                | S    |
| 10 — Amended returns            | Portal 16+                | S    |
| 11 — Encryption-at-rest         | Portal 16+ + cross-app    | S    |

Total: **~12-14 weeks of solo build** at Kurt's pace; ~350 checklist items when expanded into a Claude Code execution prompt.

---

## 15. Open architectural questions

- **Per-section ACLs vs. release-level only?** Today's design treats `tax.return_releases.section_ids` as the only access boundary. A future need might be "show client A this section, client B that one, within the same return." We can extend with `tax.return_section_grants` later — no schema breakage required.
- **K-1 auto-distribution.** Should the firm release a 1065's K-1s to each partner's _individual_ portal automatically (with their K-1 only), or require explicit per-partner releases? Lean explicit for v1; auto is a great Phase 10+ add.
- **Native integration with UltraTax CS / Lacerte API.** UltraTax has an undocumented but discoverable file-watch + export workflow ("send to portal" plugin). Skip for now — staff manually drops the PDF. Re-evaluate after 20+ firms onboard.
- **OCR-only PDFs.** Some firms re-scan paper returns. The lexicon-based header detection won't catch these; OCR-first pipeline adds 30s+ per return. Plan: detect scanned PDFs (no text layer on >50% of pages), warn staff to skip the parser and create sections manually, or run OCR-first opt-in.
- **AICPA ET §1.700 considerations.** Selectively sharing schedules to a non-client 3rd party is a confidential client information disclosure. The current design assumes the client themselves is the discloser (acceptable). Firm-initiated shares (e.g. firm sends Schedule L to client's bank on client's behalf) need explicit § 1.700.040 consent. **Out of scope** for v1 — firm always sends to the client; the client shares onward.
- **Tax payments cross-link.** Each `tax.returns` row likely produces 0–N `tax_payments` rows (estimates, balance-due). Phase 2.7's `tax_payments` table should optionally FK back to `tax.returns.id` so the client can see "this Q3 estimate came from your 2024 return."

---

## 16. Out of scope (deliberately)

- **In-portal tax return preparation.** Clients do not prepare returns here — that's the firm's tax software. (Same line as `CLIENT_PORTAL_BUILD_PLAN.md` § 5.)
- **Editing returns post-upload.** Sections are editable; PDF content is not. Amend by uploading a new return that supersedes.
- **Annotation / highlighting.** Maybe v2. For now, viewers are read-only.
- **Per-line-item disclosure.** "Share Schedule B line 4 with the bank but not line 5" — page-level is the boundary. Lower granularity is a redaction problem (out of scope; the firm should redact the source PDF before upload if needed).
- **E-signature on the return.** Clients sign Form 8879, not the return itself. Engagement letters + 8879 belong on the existing `Letters.tsx` screen, not here.
- **Bookmark-creation tooling.** If a PDF has no bookmarks, staff makes sections manually. We don't "fix" the source PDF.

---

## 17. Files this plan creates / touches

| File                                                      | App    | New / Modified                                                   |
| --------------------------------------------------------- | ------ | ---------------------------------------------------------------- |
| `apps/web/server/db/migrations/0xxx_tax_module.sql`       | staff  | **NEW** — all `tax.*` tables                                     |
| `apps/web/server/tax/parse.ts`                            | staff  | **NEW** — `pdfjs-dist` bookmark walker                           |
| `apps/web/server/tax/lexicon.yaml`                        | staff  | **NEW** — normalization patterns                                 |
| `apps/web/server/tax/extract.ts`                          | staff  | **NEW** — `pdf-lib` subset + watermark                           |
| `apps/web/server/tax/routes.ts`                           | staff  | **NEW** — `/api/firm/tax/*` + `/api/portal/tax/*`                |
| `apps/web/server/tax/share-tokens.ts`                     | staff  | **NEW** — Argon2id token issuance/verify                         |
| `apps/web/workers/tax-queues.ts`                          | staff  | **NEW** — BullMQ workers for `tax:*`                             |
| `apps/web/pages/Returns.tsx`                              | staff  | **NEW** — staff list + detail + section editor                   |
| `apps/web/pages/Returns/[id]/Release.tsx`                 | staff  | **NEW** — release modal                                          |
| `apps/web/pages/Returns/[id]/Activity.tsx`                | staff  | **NEW** — per-return audit                                       |
| `apps/portal/pages/TaxDocuments.tsx`                      | portal | **MOD** — replace `TaxDocsScreen` mock with real fetch           |
| `apps/portal/pages/TaxReturn.tsx`                         | portal | **MOD** — replace `TaxReturnViewerScreen` + `PdfPagePlaceholder` |
| `apps/portal/components/ShareDialog.tsx`                  | portal | **MOD** — keep UI, wire to `/api/portal/tax/.../shares`          |
| `apps/portal/pages/AccessHistory.tsx`                     | portal | **MOD** — add tax events alongside existing audit feed           |
| `apps/shared/pages/SharedTax.tsx` (new app `apps/shared`) | new    | **NEW** — recipient-facing share page                            |

---

## 18. KICKOFF — Claude Code execution prompt template

When ready to build, the entry prompt to Claude Code is:

> Work through `TAX_RETURN_BUILD_PLAN.md` phase by phase. Before starting each phase, post a Phase Plan with: files you'll create/touch, schema deltas, test plan. After each phase, post a DoD-check against the phase's DoD section and pause for sign-off. Open `QUESTIONS.md` and ask anything ambiguous before coding; don't make schema or API decisions silently. The lexicon at `apps/web/server/tax/lexicon.yaml` is treated as data — never inlined into TS.

— end of plan —
