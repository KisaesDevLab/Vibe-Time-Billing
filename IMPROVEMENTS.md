# Improvement backlog — gaps from the 2026-06 build sessions

**SECURITY AUDIT (2026-06-11): all findings remediated** on
`feat/firm-people-directory`. Commits: c1f2797 (attachment inline-XSS +
CSP), 56424b9 (CSV/Excel formula injection across 12 export helpers),
8afa462 (firm-scope MCP time-entry tools + admin user/role mutations),
d442a1e (terminal amount caps, CSPRNG rate-limiter, Puppeteer SSRF guard,
backup chmod 600), 339e981 (portal new-device SMS re-verification — Q6).
Tests added: csv-injection, portal-device-verification. Full API suite
1250 passing. Operator-config items (AI base URL, dev-compose ports) were
assessed as non-remote-exploitable and documented, not code-changed.

---

**STATUS (2026-06-11): all items implemented and committed** on
`feat/firm-people-directory` except the two operational notes in item 13
that need the user (physical Terminal reader verification). Commits:
891576d (item 1), 7bbbdfc (items 2, 3, 9, 10, 11), 251538f (items 4
clients-part, 7, 8), de74cb0 (items 4 requests-part, 5), e482888 (item 6),
af883c7 (item 12). Tasks/TimeEntry needed no change (no filter state /
already persisted by design).

Self-review of recently shipped features (booking location presets, calendar
review tab, client-initiated messaging, client header/list changes, table
filter audit, client billing additions). Each item is verified against the
code as of branch `feat/firm-people-directory`, with file references. Ordered
by priority. Pass any subset back to Claude Code to implement.

---

## P1 — Real gaps (verified in code)

### 1. Reschedule flow ignores the saved location preset

The new-booking flow filters slots by `locationOptionId`, but rescheduling
does not — rescheduling a "Monett" appointment will offer days/slots backed
only by a "Cassville" window (the exact bug just fixed for new bookings).

- `apps/api/src/appointments/booking-routes.ts` (~line 1096): the reschedule
  re-validation calls `getAvailableSlots` with `location: appt.location` but
  never reads/passes the appointment's stored `location_option_id`.
- `apps/web/src/pages/Appointments.tsx` (~lines 1003–1040): the reschedule
  month/day slot queries don't send `locationId`.
  Fix: load `appointment.location_option_id`, thread it through both the web
  queries and the server re-validation, mirroring the new-booking path.

### 2. No rate limit on client-initiated thread creation

`POST /api/portal/messaging/threads` (`apps/api/src/portal/messaging.ts`) has
no `checkAndIncrement` guard, unlike other portal-facing mutations (see
`apps/api/src/appointments/public-routes.ts` for the pattern). A portal user
can create unbounded threads, each of which wraps a T-DEK and fans out
member rows. Add a Redis sliding-window limit (e.g. 5 new threads per
identity per hour) returning 429.

### 3. No staff notification when a client starts a thread

A client-initiated thread only surfaces when staff open that client's
Messages card. Wire `staff_notifications` (and optionally email) to the
auto-added staff members at creation — the reschedule-request flow in
`public-routes.ts`/`booking-routes.ts` already shows the in-app + email
notification pattern to copy.

---

## P2 — Consistency / UX

### 4. Filter-persistence audit only covered `ColumnFilter` views

Pages with custom filter UIs were out of scope and still reset on refresh:

- `apps/web/src/pages/Clients.tsx` — search, owner, type, status, office
  chips, page/sort.
- Likely also Tasks, TimeEntry, Requests list views (verify each).
  Decide whether these should persist too; if yes, reuse the sessionStorage
  hydrate/write pattern (`apps/web/src/pages/tax/TaxReturnsTab.tsx`).

### 5. Persistence storage is inconsistent across pages

- Engagements uses `localStorage` (`__vibe_eng_filters`) — survives forever.
- Everything else (`useColumnView`, TaxReturnsTab, Proposals) uses
  `sessionStorage` — per browser session.
  Pick one lifetime (sessionStorage is the established default) or justify the
  difference. Note: Engagements also persists the active _tab_, which silently
  overrides the "My Work" default on next visit — confirm that's wanted.

### 6. Engagement-type column exists only on the client Billing tab

- `/invoices` list page (`apps/web/src/pages/Invoices.tsx`) doesn't show the
  new `engagementTypes` field (it's already in the API response).
- `GET /api/staff/invoices/export.csv` doesn't include it.
- Perf note: it's a correlated subquery per row
  (`apps/api/src/invoices/routes.ts` list select). Fine at the 500-row cap;
  consider a lateral join if firms grow past that.

### 7. "Outstanding" definitions can disagree

Client header Outstanding (`/api/staff/stats/client/:id`, all-time) vs the
Billing tab summary Outstanding (defaults to current-year filter). A client
with a 2025 balance shows different numbers in the header and the tab.
Either label the header value ("Outstanding (all time)") or compute both
from the same source.

### 8. Clients list: Office column isn't sortable

Every other column header on `/clients` sorts; the new Office column
(`apps/web/src/pages/Clients.tsx`) is render-only. Add it to the sort
columns (needs `officeName` in the server sort whitelist too).

---

## P3 — Polish / hardening

### 9. Portal thread titles collide and first message can't carry attachments

Every thread a contact starts is titled "Name (Client)" — add the date or a
sequence. The new-thread composer (`apps/portal/src/pages/Messages.tsx`)
also has no attachment support on the first message (replies do).

### 10. Engagement assignment is one-way

`POST /api/staff/engagement-messaging/threads/:id/engagement` can link but
there's no unlink/reassign (a misclick is permanent without SQL). Add
`DELETE /threads/:id/engagement` (messaging:write + audit).

### 11. Client-thread routing could include engagement assignments

"Assigned team" currently = staff already on the client's threads
(`apps/api/src/portal/messaging.ts` POST /threads). Staff assigned via
`engagement_assignment` to the client's active engagements are arguably part
of the team and could be included in the member fan-out.

### 12. Booking month-availability endpoint is uncached

`/slots` day queries are Redis-cached; `/slots/month`
(`apps/api/src/appointments/slots-routes.ts`) recomputes up to 31
`getAvailableSlots` calls per request with no cache. Add the same 2-minute
cache (key must include location + locationId, as the day cache now does).

### 13. Operational follow-ups

- Stripe Terminal in-person flow still needs verification with a physical
  reader + live Stripe (tap → automatic capture → webhook → receipt
  materialization → auto-poll completes).
- Local branch `feat/firm-people-directory` has many commits not pushed to
  PR #3 — push and refresh the PR description to cover the newer features
  (payments overhaul, terminal mode, booking fixes, messaging, billing).
