# Calendar write-back (v2) — architecture notes

v1 is **read-only**: Vibe ingests appointments from staff calendars and
never writes back. Two-way sync is a v2 feature, stubbed in v1 behind
`FEATURE_CALENDAR_WRITE=false`.

## What exists today (stubs)

- `calendar_events.tb_origin` (boolean) — marks events created by Vibe vs
  ingested from a provider. Always `false` in v1.
- `apps/api/src/calendar/write-service.ts` — `CalendarWriteService` +
  `GraphEventWriter` / `GoogleEventWriter` interface shells. Every method
  throws `calendar_writeback_not_implemented`; `ensureEnabled()` throws
  `calendar_write_disabled` when the flag is off.
- Routes `POST /api/staff/calendar/events`, `PATCH …/events/:id`,
  `DELETE …/events/:id` — return **501** while the flag is off.

## What v2 must add

1. **Scope expansion.** Microsoft `Calendars.ReadWrite`; Google
   `https://www.googleapis.com/auth/calendar.events`. Re-consent required
   for already-connected staff (the connect flow already stores the granted
   scope on the connection).
2. **Provider writers.** Implement create/update/delete against
   `POST /me/calendars/{id}/events` (Graph) and
   `POST /calendars/{id}/events` (Google), reusing `ensureFreshAccessToken`.
3. **TB-origin lifecycle.** `createEvent` inserts a `calendar_events` row
   with `tb_origin=true` and the returned `provider_event_id`, then the poll
   sync must NOT treat its own writes as external changes (skip soft-delete
   for `tb_origin` rows it just wrote).
4. **Conflict resolution.** Decide last-writer-wins vs. provider-authoritative
   when an event changes on both sides between polls (compare `raw_etag` /
   `changeKey`). Placeholder: provider wins for ingested fields; Vibe wins
   for `tb_origin` events it owns.
5. **Attendee response write-back.** When a client responds via the RSVP
   token, optionally PATCH the provider event's attendee list (needs write
   scope).

## Out of scope even for v2 (tracked separately)

- Webhook/push sync (Graph subscriptions, Google push channels) to replace
  polling.
- Recurring-series awareness (`seriesMasterId`) — each occurrence is treated
  independently today.
