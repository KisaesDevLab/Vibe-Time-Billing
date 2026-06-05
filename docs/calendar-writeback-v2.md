# Calendar write-back (v2) — architecture notes

v1 was **read-only**: Vibe ingested appointments from staff calendars and
never wrote back. Two-way sync is now **implemented** behind
`FEATURE_CALENDAR_WRITE` (default `false`). When the flag is on, Vibe can push
events to a staff member's connected calendar and keep them in sync with the
firm's appointment records.

## What's implemented

- `calendar_events.tb_origin` (boolean) — marks events created by Vibe vs
  ingested from a provider.
- `apps/api/src/calendar/write-service.ts` — `CalendarWriteService` plus
  `GraphEventWriter` / `GoogleEventWriter` (plain `fetch`, no SDKs).
  `ensureEnabled()` throws `calendar_write_disabled` when the flag is off;
  failures surface as a typed `CalendarWriteError` whose `code` the route
  layer maps to an HTTP status.
- Routes `POST /api/staff/calendar/events`, `PATCH …/events/:id`,
  `DELETE …/events/:id` — return **501** while the flag is off; otherwise
  create/update/delete a TB-origin event. Status mapping:
  `write_scope_missing`/`reauth_required`/`not_configured` → 409,
  `not_found` → 404, `provider_failed` → 502.
- **Appointments integration.** Creating an appointment
  (`POST /api/staff/appointments`) mirrors it onto the lead staff member's
  calendar (best-effort); the mirror's `calendar_events` id is stored in
  `appointment.external_ref`. Edits propagate via PATCH; cancellation deletes
  the provider event and soft-deletes the mirror. The admin Appointments UI
  shows a "📅 On calendar" badge and confirms the push.

### How each v2 requirement was met

1. **Scope expansion.** `oauth.ts` requests `Calendars.ReadWrite` (Microsoft)
   / `…/auth/calendar.events` (Google) via `scopesFor()` when the flag is on.
   Already-connected staff keep their read-only grant until they reconnect;
   `hasWriteScope()` checks the connection's stored `scope` and write attempts
   on a read-only connection return `write_scope_missing` (409) — the UI
   prompts a reconnect.
2. **Provider writers.** create/update/delete against
   `…/me/calendars/{id}/events` (Graph) and `…/calendars/{id}/events`
   (Google), reusing `ensureFreshAccessToken`. Deletes are idempotent
   (404/410 treated as success).
3. **TB-origin lifecycle.** `createEvent` inserts a `calendar_events` row with
   `tb_origin=true` and the returned `provider_event_id`. The poll sync's
   soft-delete sweep **excludes `tb_origin` rows** (see `sync.ts`), so
   provider-propagation lag never deletes an event Vibe just created; the
   upsert leaves `tb_origin` untouched.
4. **Conflict resolution.** Provider wins for ingested fields (the upsert
   overwrites from the poll); Vibe owns `tb_origin` events — the sweep never
   touches them, so a provider-side deletion of a Vibe-owned event is ignored.
   `raw_etag` is captured on every write for future change detection.
5. **Attendee response write-back.** When a client responds via the RSVP
   token, the handler updates `calendar_events.attendees` locally and then
   (flag on + write-scoped connection) PATCHes the provider event's attendee
   list via `CalendarWriteService.writeBackAttendees` — best-effort, so a
   provider failure never blocks the public RSVP page. This works on ingested
   events too (the staff is the organizer), so it does not require tb_origin.

## Out of scope even for v2 (tracked separately)

- Webhook/push sync (Graph subscriptions, Google push channels) to replace
  polling.
- Recurring-series awareness (`seriesMasterId`) — each occurrence is treated
  independently today.
