# Vibe Time & Billing — Calendar Integration Addendum

> **Addendum to:** `BUILD_PLAN.md` (26-phase base) + `CONNECT_INTEGRATION_ADDENDUM.md` (Phases A–K)
> **Addendum label:** Phases CAL-1 through CAL-9
> **Insertion point:** After Phase K (Connect Integration) in the master phase sequence
> **Total checklist items:** ~180
> **Status:** LOCKED — ready for autonomous build

---

## Decisions Log

| ID       | Decision                                                                                                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-CAL-01 | Per-staff OAuth, self-service from staff profile page                                                                                                                                                            |
| D-CAL-02 | v1: read-only pull (ingest appointments). v2 stub: write-back infrastructure tables and API routes created but gated behind `FEATURE_CALENDAR_WRITE=false` env flag                                              |
| D-CAL-03 | Poll-only sync (no webhooks). Interval configurable in System Settings (default 15 min, min 5, max 60). Executed via BullMQ repeatable job                                                                       |
| D-CAL-04 | Per-staff multi-calendar selection: after OAuth, staff selects which calendar(s) to sync from a list of their available calendars                                                                                |
| D-CAL-05 | Matching tiers: (1) exact attendee email → client contact, (2) fuse.js fuzzy on event subject/organizer vs. client name/entity name. LLM tier stubbed with `calendar_match_strategy = 'llm'` but not wired in v1 |
| D-CAL-06 | Unmatched queue: events with no confident match enter a staff-facing review queue; staff can link, dismiss, or create a new client                                                                               |
| D-CAL-07 | Reminders reuse existing TB reminder delivery infrastructure (no new transport)                                                                                                                                  |
| D-CAL-08 | Client RSVP: one-click confirm/decline via signed token URL in reminder email; no portal login required                                                                                                          |
| D-CAL-09 | Time entry suggestion: when a matched appointment's end time passes, BullMQ enqueues a prompt notification to the staff member                                                                                   |
| D-CAL-10 | SMS reminders: out of scope v1                                                                                                                                                                                   |
| D-CAL-11 | LLM matching (Qwen3-8B): out of scope v1; interface and DB column stubs included                                                                                                                                 |

---

## Phase CAL-1 — OAuth Provider Configuration & Credential Vault

**Purpose:** Firm admin registers Azure App + Google OAuth client in System Settings. Encrypted credentials stored in Postgres. Per-staff connect flow reads from firm config.

### System Settings UI

- [ ] Add "Calendar Integrations" section to System Settings admin page
- [ ] M365 / Microsoft Graph sub-section with fields: `Azure Tenant ID`, `Azure Client ID`, `Azure Client Secret` (masked input, stored AES-256-GCM encrypted, key from `MASTER_FIRM_KEY` envelope)
- [ ] Google Calendar sub-section with fields: `Google Client ID`, `Google Client Secret` (same encryption)
- [ ] "Test Connection" button per provider — attempts a client-credentials token exchange, displays success/error inline
- [ ] Save stores to `calendar_provider_config` table (one row per firm per provider)
- [ ] Show/hide toggle for each provider; a provider must be enabled before staff can connect it

### Database

- [ ] `calendar_provider_config` table: `id`, `firm_id`, `provider` (`microsoft|google`), `client_id_enc`, `client_secret_enc`, `tenant_id_enc` (nullable, M365 only), `enabled` boolean, `created_at`, `updated_at`
- [ ] `staff_calendar_connections` table: `id`, `staff_id`, `provider`, `access_token_enc`, `refresh_token_enc`, `token_expiry`, `scope`, `provider_user_id`, `provider_email`, `connected_at`, `last_synced_at`, `sync_error` (nullable text), `enabled` boolean
- [ ] `staff_calendar_selections` table: `id`, `connection_id`, `calendar_id` (provider-native calendar ID), `calendar_name`, `color` (hex, from provider), `is_primary` boolean, `sync_enabled` boolean
- [ ] `calendar_events` table: `id`, `firm_id`, `staff_id`, `connection_id`, `provider_event_id` (unique per connection), `calendar_id`, `subject`, `body_preview` (first 500 chars), `start_at` (timestamptz), `end_at` (timestamptz), `location` (nullable), `is_all_day` boolean, `organizer_email`, `organizer_name`, `attendees` (jsonb array of `{email, name, response_status}`), `ical_uid` (nullable), `web_link` (nullable), `raw_etag` (nullable, for delta sync later), `sync_at`, `created_at`, `updated_at`
- [ ] `calendar_event_matches` table: `id`, `event_id`, `client_id` (nullable FK), `match_tier` (`exact_email|fuzzy_name|llm|manual`), `match_score` (float, 0–1), `match_status` (`confirmed|dismissed|pending`), `matched_by` (staff_id nullable — null = auto), `matched_at`, `dismissed_reason` (nullable)
- [ ] `calendar_rsvp_tokens` table: `id`, `event_id`, `client_contact_id`, `token` (uuid, unique), `response` (`confirmed|declined|null`), `responded_at` (nullable), `reminder_id` (FK to existing reminders table), `expires_at`
- [ ] Migration file following existing Drizzle migration conventions
- [ ] Indexes: `calendar_events(staff_id, start_at)`, `calendar_events(provider_event_id, connection_id)`, `calendar_event_matches(event_id)`, `calendar_event_matches(client_id, match_status)`, `calendar_rsvp_tokens(token)`

### Encryption helpers

- [ ] Extend existing `@vibe/crypto` package (or equivalent firm-key envelope utility) with `encryptField(plaintext, firmKey)` / `decryptField(ciphertext, firmKey)` helpers used for token storage — reuse MFK pattern from Connect addendum
- [ ] Unit tests: round-trip encrypt/decrypt for each new encrypted column type

**Phase CAL-1 checklist count: 18**

---

## Phase CAL-2 — Per-Staff OAuth Connect Flow

**Purpose:** Staff self-service connection from their profile page. Initiates OAuth 2.0 authorization code flow, stores tokens, lists available calendars for selection.

### Profile Page — "My Calendars" tab

- [ ] Add "My Calendars" tab to staff profile page (visible only if at least one provider is enabled in System Settings)
- [ ] Per-provider connection card: shows provider logo/name, connection status (connected email address or "Not connected"), "Connect" / "Disconnect" button
- [ ] "Connect" initiates OAuth redirect: backend generates `state` param (JWT signed with session secret, contains `staff_id` + `provider` + CSRF nonce, 10-min expiry), stores in Redis, redirects to provider authorization URL
- [ ] M365 authorization URL: `https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/authorize` with scopes `Calendars.Read offline_access User.Read` (expand to `Calendars.ReadWrite` when write-back enabled)
- [ ] Google authorization URL: `https://accounts.google.com/o/oauth2/v2/auth` with scopes `https://www.googleapis.com/auth/calendar.readonly` (expand for write-back)
- [ ] OAuth callback route `GET /api/calendar/oauth/callback/:provider` — validates state from Redis, exchanges code for tokens, upserts `staff_calendar_connections`, redirects to profile page with `?cal_connect=success`
- [ ] Callback error handling: invalid state → 400; token exchange failure → store error in `staff_calendar_connections.sync_error`, redirect with `?cal_connect=error`
- [ ] On successful connect, immediately fetch the staff member's calendar list from provider (see CAL-2 calendar picker below)
- [ ] "Disconnect" flow: revokes token with provider (best-effort), deletes `staff_calendar_connections` row and all child `staff_calendar_selections`, marks `calendar_events` rows for this connection as `soft_deleted` (set `connection_id` to null, keep event history)
- [ ] Refresh token rotation: on every poll sync, if `token_expiry` is within 5 minutes, refresh before calling API; store new tokens; if refresh fails, set `sync_error = 'token_expired'` and surface warning on profile page

### Calendar Picker

- [ ] After connect (and on returning visits), fetch list of user's calendars from provider
  - M365: `GET /me/calendars` (Graph API) → `[{id, name, color, isDefaultCalendar}]`
  - Google: `GET /calendar/v3/users/me/calendarList` → `[{id, summary, backgroundColor, primary}]`
- [ ] Upsert results into `staff_calendar_selections` (mark calendars no longer returned by provider as `sync_enabled = false`)
- [ ] Render calendar picker: checkbox list showing calendar name + color swatch per calendar; "primary" calendar pre-checked; others unchecked by default
- [ ] Staff can check/uncheck any calendar; changes saved immediately via `PATCH /api/calendar/connections/:id/selections`
- [ ] UI note shown if no calendars are selected: "Select at least one calendar to enable sync"

### Token security

- [ ] Access and refresh tokens stored AES-256-GCM encrypted using MFK envelope (same as CAL-1 encrypted fields)
- [ ] Tokens never appear in API responses or logs
- [ ] `sync_error` field visible to staff on profile; detailed error (e.g., HTTP status from provider) logged server-side only

**Phase CAL-2 checklist count: 20**

---

## Phase CAL-3 — Poll Sync Engine

**Purpose:** BullMQ repeatable job fetches events from connected provider calendars on the configured interval. Upserts into `calendar_events`. Handles pagination, delta detection, and error back-off.

### System Settings — Sync interval

- [ ] Add `calendar_sync_interval_minutes` to System Settings (integer, 5–60, default 15)
- [ ] Changing the setting cancels and re-schedules the BullMQ repeatable job immediately
- [ ] Show "Last synced" timestamp per staff connection on the admin calendar overview page

### BullMQ Job: `calendar-sync-all`

- [ ] Repeatable job registered at app startup with interval from system settings
- [ ] Job queries `staff_calendar_connections` where `enabled = true` and `sync_error IS NULL` (or `sync_error` is retryable)
- [ ] For each connection, enqueues a child job `calendar-sync-connection` with `connectionId` payload (fan-out pattern; prevents one slow/failing connection from blocking others)
- [ ] Job concurrency: max 5 `calendar-sync-connection` workers running in parallel

### BullMQ Job: `calendar-sync-connection`

- [ ] Decrypt access token; refresh if within 5-min expiry window
- [ ] For each `sync_enabled = true` calendar in `staff_calendar_selections`:
  - Fetch events with `start_at >= now() - 7 days` and `end_at <= now() + 90 days` (configurable via `calendar_sync_lookback_days` / `calendar_sync_lookahead_days` system settings)
  - **M365 Graph API:** `GET /me/calendars/{calendarId}/events?$select=id,subject,bodyPreview,start,end,location,organizer,attendees,iCalUId,webLink,changeKey&$filter=...&$top=100&$orderby=start/dateTime` — follow `@odata.nextLink` for pagination
  - **Google Calendar API:** `GET /calendar/v3/calendars/{calendarId}/events?timeMin=...&timeMax=...&maxResults=250&singleEvents=true&orderBy=startTime` — follow `nextPageToken` for pagination
- [ ] Upsert each event into `calendar_events` using `(provider_event_id, connection_id)` as the conflict key; update all mutable fields on conflict
- [ ] Detect deleted events: fetch provider event IDs for the sync window; any `calendar_events` row for this connection/calendar not in the returned set gets `soft_deleted_at = now()`
- [ ] Update `staff_calendar_connections.last_synced_at = now()` on success
- [ ] Error handling:
  - HTTP 401/403 → set `sync_error = 'auth_failed'`; do not retry automatically (requires staff re-auth)
  - HTTP 429 → exponential back-off (BullMQ `delay`), max 3 retries
  - HTTP 5xx → standard BullMQ retry (3 attempts, 2-min back-off)
  - All other errors → log + set `sync_error` with message; mark connection `enabled = false` after 5 consecutive failures
- [ ] After successful upsert batch, enqueue `calendar-match` job for any newly inserted/updated events (see CAL-4)

### API: Manual sync trigger

- [ ] `POST /api/calendar/connections/:id/sync` — staff-triggered manual sync; enqueues `calendar-sync-connection` immediately; returns 202
- [ ] Rate-limit: max 1 manual trigger per connection per 60 seconds (Redis key with TTL)
- [ ] Profile page "Sync Now" button per connection; shows spinner while job is pending, displays last synced timestamp on completion (poll `GET /api/calendar/connections/:id/status` every 3 seconds)

**Phase CAL-3 checklist count: 22**

---

## Phase CAL-4 — Client Matching Engine

**Purpose:** Two-tier matching (exact email → fuse.js fuzzy) assigns a `client_id` to each synced event or places it in the unmatched queue. Stubs the LLM tier interface.

### Matching job: `calendar-match`

- [ ] Accepts `eventId` payload; idempotent — if `calendar_event_matches` row already exists with `match_status = 'confirmed'`, skip
- [ ] **Tier 1 — Exact email match:**
  - Extract all attendee emails + organizer email from `calendar_events.attendees` (jsonb) + `organizer_email`
  - Query `client_contacts` (or equivalent contacts table) for any row where `email IN (attendee_emails)` AND `firm_id = event.firm_id`
  - If exactly one distinct `client_id` found: insert `calendar_event_matches` with `match_tier = 'exact_email'`, `match_score = 1.0`, `match_status = 'confirmed'`, `matched_by = null` (auto)
  - If multiple distinct `client_id`s found: insert match row per client with `match_status = 'pending'`, `match_tier = 'exact_email'` — flag for human review
- [ ] **Tier 2 — Fuzzy name match (fuse.js):**
  - Runs only if Tier 1 produced no confirmed match
  - Build search corpus: all active clients for the firm — `[{id, name, entity_name, dba}]`
  - Initialize `Fuse` instance with keys `['name', 'entity_name', 'dba']`, `threshold: 0.35`, `includeScore: true`
  - Search string: `event.subject` (stripped of common prefixes: "Re:", "Fwd:", date tokens, meeting type words: "call", "meeting", "appointment", "review", "consult")
  - Take top result if `score >= 0.65` (fuse score is inverted — 0 = perfect match, so `1 - score >= 0.65` → `score <= 0.35`)
  - Insert match row: `match_tier = 'fuzzy_name'`, `match_score = 1 - fuse_score`, `match_status = 'pending'`
  - If no result above threshold: insert match row with `client_id = null`, `match_tier = 'unmatched'`, `match_status = 'pending'`
- [ ] **LLM tier stub:**
  - `calendar_event_matches.match_tier` column accepts `'llm'` value
  - Service file `packages/calendar/src/matchers/llm-matcher.ts` created with interface `matchWithLLM(event: CalendarEvent, firmId: string): Promise<MatchResult>` — body throws `new Error('LLM matching not implemented in v1')`
  - `FEATURE_LLM_CALENDAR_MATCH` env flag checked before calling; if false, skip silently
- [ ] Matching job is idempotent: running twice on same event produces one row (upsert on `event_id`)
- [ ] Unit tests for matching logic: exact match hit, exact match miss, fuzzy hit above threshold, fuzzy miss below threshold, multi-client collision

### Unmatched Review Queue — API

- [ ] `GET /api/calendar/unmatched` — returns events with `match_status = 'pending'`, paginated, filterable by staff/date range
- [ ] `POST /api/calendar/matches/:matchId/confirm` — body `{ clientId }` — sets `match_status = 'confirmed'`, `matched_by = req.staffId`; if `clientId` differs from existing `client_id`, updates it
- [ ] `POST /api/calendar/matches/:matchId/dismiss` — body `{ reason? }` — sets `match_status = 'dismissed'`, stores reason
- [ ] `POST /api/calendar/matches/:matchId/new-client` — creates a stub client record from event data (name from subject, email from attendees) and links; returns new `client_id` — delegates to existing client creation service

**Phase CAL-4 checklist count: 22**

---

## Phase CAL-5 — Staff Dashboard Calendar Panel

**Purpose:** "My Calendar" panel on the staff dashboard showing today/week appointments with client chips, unmatched badge, and quick time-log action.

### Staff Dashboard Panel — "My Calendar"

- [ ] Panel added to staff dashboard grid (collapsible, position configurable via dashboard layout settings)
- [ ] Default view: **Today** — events for `now()` date sorted by `start_at`
- [ ] Toggle: Today / This Week (7-day rolling)
- [ ] Each appointment card shows:
  - Time range (e.g., "2:00–3:00 PM") + duration
  - Subject (truncated at 60 chars)
  - Client chip: if `match_status = 'confirmed'` → client name badge (clickable → client record); if `match_status = 'pending'` → amber "Review Match" badge; if `match_status = 'dismissed'` → no badge; if `match_tier = 'unmatched'` → grey "Unmatched" badge
  - Location / meeting link (if present)
  - Provider icon (M365 or Google) as small indicator
- [ ] "Log Time" quick-action button on each confirmed-match card: opens time entry drawer pre-populated with `client_id`, `date = event date`, `description = event subject`, `duration = event duration (rounded to nearest 6 min)` — staff can edit before saving
- [ ] "Review" link on pending-match cards: opens inline match review popover (client search autocomplete + confirm/dismiss actions) without leaving the dashboard
- [ ] Empty state: "No appointments today" with "Sync Now" link if last sync > 1 hour ago
- [ ] Last synced timestamp shown at panel footer: "Synced 4 min ago" (relative time, updates every 60 sec)
- [ ] Panel data endpoint: `GET /api/calendar/events/my?view=today|week` — returns events with resolved match data, client name

### Unmatched Queue Badge

- [ ] Staff nav bar (or notification bell area) shows badge count of their pending unmatched events
- [ ] Clicking badge navigates to full Unmatched Review page (CAL-5 sub-page)

### Unmatched Review Page (`/calendar/unmatched`)

- [ ] Table: Event Subject | Date/Time | Organizer | Attendees (email list) | Suggested Client (fuse match name + score %) | Actions
- [ ] Actions per row: "Confirm [Suggested]" (one-click if suggestion exists), "Pick Different Client" (search popover), "Dismiss", "Create Client"
- [ ] Bulk actions: select multiple → Dismiss All selected
- [ ] Filter bar: All / Pending / Confirmed / Dismissed; date range picker; staff selector (admin only)

**Phase CAL-5 checklist count: 20**

---

## Phase CAL-6 — Client Portal & Admin Dashboard Surfaces

**Purpose:** Appointments visible on client-facing portal (Vibe Connect licensed) and on the admin/manager calendar overview.

### Client Portal — Appointments Tab

- [ ] Add "Appointments" tab to client portal (visible to client contact users; gated on `FEATURE_CONNECT` license entitlement — if Connect not licensed, tab is hidden)
- [ ] Lists all upcoming confirmed appointments for this client across all staff, ordered by `start_at`
- [ ] Each row: Date & Time | Staff Name | Subject | Location/Link | RSVP Status chip (Confirmed / Declined / Awaiting)
- [ ] Past appointments section (collapsible): last 90 days
- [ ] "Add to Calendar" button per appointment: generates iCal `.ics` download (ICS file built server-side from event data — no provider credentials required)
- [ ] No create/edit on client side — read-only view of what firm staff have on calendar

### Client Portal — RSVP flow

- [ ] RSVP token URL pattern: `GET /rsvp/:token` — public route (no auth required)
- [ ] Token validated against `calendar_rsvp_tokens` table: check exists, not expired, not already responded
- [ ] Renders simple branded page: firm logo, appointment details (subject, date/time, staff name), two buttons "✓ Confirm" / "✗ Decline"
- [ ] On button click: `POST /rsvp/:token` with `{ response: 'confirmed' | 'declined' }`; updates `calendar_rsvp_tokens.response` + `responded_at`; updates matching `attendees` jsonb entry in `calendar_events` (set `response_status` for this contact); returns confirmation page ("Thanks, we've noted your response")
- [ ] Expired token: show "This link has expired" with firm contact info
- [ ] Already-responded token: show current status with option to change response (re-POST)
- [ ] Token expiry: `event.start_at` (token expires when appointment starts)

### Admin Calendar Overview (`/admin/calendar`)

- [ ] All-staff calendar view — admin/manager role only
- [ ] Two sub-views: **List** (table, filterable by staff/client/date) and **Grid** (week grid, color-coded by staff)
- [ ] List view columns: Staff | Date/Time | Subject | Client (matched) | Match Tier | RSVP Status | Reminder Status
- [ ] Grid view: appointments shown as blocks in staff columns; click block → appointment detail drawer
- [ ] Appointment detail drawer: full event details, attendee list, match status, RSVP responses per contact, reminder log (sent/pending), manual re-send reminder button, manual match override
- [ ] Filter bar: date range, staff multi-select, client multi-select, match status (all/confirmed/pending/unmatched)
- [ ] Export: filtered list to CSV (subject, staff, client, date/time, duration, match tier, RSVP status)
- [ ] Connection health panel: table of all staff connections — provider, last synced, sync error (if any), event count; admin can trigger manual sync per connection; admin can disconnect on behalf of staff (with confirmation)

**Phase CAL-6 checklist count: 22**

---

## Phase CAL-7 — Reminder Engine Integration

**Purpose:** Wire calendar appointments into the existing TB reminder delivery system. Configurable reminder schedule per firm. RSVP token generated and embedded in reminder.

### Reminder Schedule Configuration

- [ ] System Settings → Calendar Integrations → Reminders sub-section
- [ ] Firm-wide default reminder schedule: multi-select of offsets — options: 7 days before, 3 days before, 1 day before, 2 hours before (can enable multiple; default: 1 day before + 2 hours before)
- [ ] Per-client override: client record → Preferences → "Appointment Reminders" section; can override schedule or disable entirely
- [ ] "Reminder from" name: defaults to firm name; overridable per staff member ("Reminders will come from [Staff Name] at [Firm Name]")
- [ ] Reminder email template: stored in existing TB template system; new template type `calendar_appointment`; merge fields: `{{client_name}}`, `{{staff_name}}`, `{{appointment_date}}`, `{{appointment_time}}`, `{{appointment_subject}}`, `{{appointment_location}}`, `{{rsvp_confirm_url}}`, `{{rsvp_decline_url}}`, `{{firm_name}}`, `{{firm_phone}}`
- [ ] Default template provided (plain, professional, firm-branded); admin can customize in Settings → Email Templates

### BullMQ Job: `calendar-reminder-scheduler`

- [ ] Runs every 5 minutes (separate from sync job)
- [ ] Queries `calendar_events` joined with `calendar_event_matches` where `match_status = 'confirmed'` and `start_at > now()` and `start_at <= now() + 7 days + 1 hour` (lookahead window covers 7-day reminder offset)
- [ ] For each event + reminder offset: checks `calendar_reminders_sent` (new table) for existing sent record; if not sent and `now() >= event.start_at - offset`, enqueues `calendar-reminder-send` job
- [ ] `calendar_reminders_sent` table: `id`, `event_id`, `client_contact_id`, `reminder_offset_minutes` (integer), `sent_at`, `delivery_status`, `rsvp_token_id`

### BullMQ Job: `calendar-reminder-send`

- [ ] Resolves client contacts for the matched client (all contacts with `receive_appointment_reminders = true`)
- [ ] For each contact: generate/fetch `calendar_rsvp_tokens` row (upsert — one token per event+contact); set `expires_at = event.start_at`
- [ ] Build RSVP URLs: `https://{firmDomain}/rsvp/{token}` for confirm and decline (same token, different response POSTed)
- [ ] Render reminder email via existing template renderer; inject merge fields including RSVP URLs
- [ ] Deliver via existing TB email transport (SMTP/SES, whatever is configured); record delivery in `calendar_reminders_sent`
- [ ] On delivery failure: standard BullMQ retry (3 attempts); after 3 failures set `delivery_status = 'failed'`; surface in admin calendar overview

### Client contact preferences

- [ ] Add `receive_appointment_reminders` boolean (default `true`) to client contacts table
- [ ] Expose in client contact edit form: "Receive appointment reminders" toggle
- [ ] Respect opt-out: `calendar-reminder-send` skips contacts where `receive_appointment_reminders = false`

**Phase CAL-7 checklist count: 20**

---

## Phase CAL-8 — Time Entry Suggestion (Post-Appointment Prompt)

**Purpose:** When a confirmed matched appointment's end time passes, prompt the staff member to log time. Surfaces as a dashboard notification and in-app nudge.

### BullMQ Job: `calendar-time-suggestion`

- [ ] Runs every 5 minutes
- [ ] Queries `calendar_events` where `end_at BETWEEN now() - 30min AND now()` (catches events that just ended)
- [ ] Joins `calendar_event_matches` where `match_status = 'confirmed'` and `client_id IS NOT NULL`
- [ ] Joins `staff_time_suggestion_log` (new table — see below) — excludes events already suggested or dismissed
- [ ] For each qualifying event, inserts a `staff_notification` row (type: `time_entry_suggestion`) with payload: `{ eventId, clientId, clientName, subject, date, durationMinutes, staffId }`
- [ ] `staff_time_suggestion_log` table: `id`, `event_id`, `staff_id`, `suggested_at`, `action` (`logged|dismissed|snoozed`), `time_entry_id` (nullable FK — populated if staff logs time)

### Staff Dashboard — Suggestion Banner

- [ ] "Did you just meet with [Client Name]?" banner appears at top of staff dashboard when pending time suggestion exists
- [ ] Banner shows: client name, appointment subject, duration, date
- [ ] Three actions: "Log Time" (opens time entry drawer pre-populated), "Not Now" (snoozes 1 hour — re-appears after snooze; max 3 snoozes then auto-dismisses), "Dismiss" (marks as dismissed, won't show again for this event)
- [ ] Multiple pending suggestions: carousel/stack with "1 of 3" indicator and prev/next
- [ ] Time entry drawer pre-population: `client_id`, `date = event date`, `description = event subject`, `duration = event.end_at - event.start_at` rounded to nearest 6 minutes, `billing_type` = client default
- [ ] On time entry save from drawer: update `staff_time_suggestion_log.action = 'logged'`, `time_entry_id = newEntryId`; dismiss banner

### API

- [ ] `GET /api/calendar/suggestions` — returns pending suggestions for authenticated staff member
- [ ] `POST /api/calendar/suggestions/:id/dismiss` — marks dismissed
- [ ] `POST /api/calendar/suggestions/:id/snooze` — stores snooze until timestamp
- [ ] `POST /api/calendar/suggestions/:id/log` — body `{ timeEntryId }` — links entry to suggestion; marks logged

**Phase CAL-8 checklist count: 18**

---

## Phase CAL-9 — v2 Write-Back Stubs, Polish & Release

**Purpose:** Infrastructure stubs for two-way sync (v2 gates), admin polish, rate-limit guards, documentation.

### v2 Write-Back Stubs

- [ ] `FEATURE_CALENDAR_WRITE=false` env flag documented in `.env.example` with comment: "Enable to allow TB to create/update events in connected provider calendars (v2 feature)"
- [ ] Database: `calendar_events.tb_origin` boolean column (default false) — marks events created by TB vs. ingested from provider
- [ ] API stub: `POST /api/calendar/events` — creates event in TB (inserts `calendar_events` with `tb_origin = true`); if `FEATURE_CALENDAR_WRITE = true`, also calls provider API to create event; currently always 501 if write feature disabled
- [ ] API stub: `PATCH /api/calendar/events/:id` — 501 guard if `FEATURE_CALENDAR_WRITE = false`
- [ ] API stub: `DELETE /api/calendar/events/:id` — 501 guard
- [ ] Service layer `CalendarWriteService` with methods `createEvent`, `updateEvent`, `deleteEvent` — each method checks feature flag; provider implementations (GraphEventWriter, GoogleEventWriter) created as empty classes with interface stubs
- [ ] Document v2 write-back architecture in `docs/calendar-writeback-v2.md` (provider API endpoints needed, scope changes required, conflict resolution strategy placeholder)

### Rate Limiting & Guardrails

- [ ] Provider API rate limit awareness: M365 Graph has per-app throttling (10,000 requests per 10 min); Google has 1,000,000 queries per day — log request counts per provider per day in Redis; alert in admin panel if > 80% of quota consumed
- [ ] Per-connection sync lock: Redis key `sync:lock:{connectionId}` with TTL = sync interval; prevents overlapping sync jobs for the same connection
- [ ] Token refresh lock: Redis key `token:refresh:{connectionId}` with 30-sec TTL; prevents race condition on concurrent refresh

### Staff Profile — Calendar Health Card

- [ ] "Calendar Connections" section on staff profile shows: provider icon, connected account email, calendars synced (count), last sync time, sync status (green/amber/red), error message if `sync_error` present
- [ ] "Re-authorize" button shown if `sync_error = 'auth_failed'` — re-initiates OAuth flow
- [ ] "Manage Calendars" expander shows calendar selector (same as post-connect picker) — allows changing calendar selection without disconnecting

### Documentation

- [ ] `docs/calendar-setup-microsoft.md` — step-by-step Azure App Registration guide (screenshots annotated): create app, set redirect URI (`https://{firmDomain}/api/calendar/oauth/callback/microsoft`), add Calendar permissions, generate client secret, copy values to System Settings
- [ ] `docs/calendar-setup-google.md` — step-by-step Google Cloud Console guide: create project, enable Calendar API, create OAuth client (Web application type), set redirect URI, configure consent screen, copy values
- [ ] `docs/calendar-sync-troubleshooting.md` — common errors (auth_failed, token_expired, 429, calendar not found) with resolution steps
- [ ] Admin UI inline help: "?" tooltip on each System Settings calendar field pointing to relevant doc page

### Testing

- [ ] Integration test: mock M365 Graph API responses (MSW handlers) — full sync cycle: fetch events → upsert → match → suggestion
- [ ] Integration test: mock Google Calendar API — same cycle
- [ ] Unit tests: RSVP token generation, expiry, double-response handling
- [ ] Unit test: reminder scheduler — ensure correct offset calculations across DST boundary
- [ ] Unit test: fuzzy matcher — 10 named test cases covering hit, near-miss, no-match, acronym expansion
- [ ] E2E test (Playwright): staff connects calendar (mock OAuth), events appear on dashboard, match confirmed, time entry logged from suggestion

**Phase CAL-9 checklist count: 22**

---

## Summary

| Phase     | Description                              | Items   |
| --------- | ---------------------------------------- | ------- |
| CAL-1     | OAuth Provider Config & Credential Vault | 18      |
| CAL-2     | Per-Staff OAuth Connect Flow             | 20      |
| CAL-3     | Poll Sync Engine                         | 22      |
| CAL-4     | Client Matching Engine                   | 22      |
| CAL-5     | Staff Dashboard Calendar Panel           | 20      |
| CAL-6     | Client Portal & Admin Dashboard Surfaces | 22      |
| CAL-7     | Reminder Engine Integration              | 20      |
| CAL-8     | Time Entry Suggestion                    | 18      |
| CAL-9     | v2 Write-Back Stubs, Polish & Release    | 18      |
| **TOTAL** |                                          | **180** |

---

## New Dependencies

| Package                             | Purpose                                  | Add to              |
| ----------------------------------- | ---------------------------------------- | ------------------- |
| `@microsoft/microsoft-graph-client` | M365 Graph API client                    | `packages/calendar` |
| `googleapis`                        | Google Calendar API client               | `packages/calendar` |
| `fuse.js`                           | Fuzzy client name matching               | `packages/calendar` |
| `ical-generator`                    | Build `.ics` files for "Add to Calendar" | `packages/calendar` |

All other dependencies (BullMQ, Drizzle, Redis, Express, React, existing crypto utilities) already present in TB base.

---

## New Environment Variables

```env
# Calendar Integration
FEATURE_CALENDAR_WRITE=false          # v2 gate — keep false in v1
CALENDAR_SYNC_INTERVAL_MINUTES=15    # overridden by System Settings; fallback default
CALENDAR_SYNC_LOOKBACK_DAYS=7
CALENDAR_SYNC_LOOKAHEAD_DAYS=90
FEATURE_LLM_CALENDAR_MATCH=false     # v1.5 gate for Qwen3 matching tier
```

---

## Open Items (Deferred to v2)

- **Two-way sync / write-back:** TB-originated events pushed to provider calendar. Requires scope expansion (`Calendars.ReadWrite`) and conflict resolution strategy.
- **LLM matching tier:** Qwen3-8B as third matching pass for low-confidence events. Interface stubbed; enable via `FEATURE_LLM_CALENDAR_MATCH=true`.
- **SMS reminders:** Add Twilio transport to reminder engine when BYO-Twilio is wired in base TB.
- **Webhook push sync:** Replace or augment poll with Graph API subscription + Google push channels for near-real-time updates.
- **Recurring event handling:** Current model treats each occurrence as an independent event. v2 should track `seriesMasterId` and allow bulk match/dismiss on a series.
- **Attendee response write-back:** When client responds to RSVP token, write `accepted/declined` back to the provider event's attendee list (requires write-back scope).
