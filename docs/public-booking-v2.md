# Public self-booking (v2) — design stub

**Status:** Not implemented in v1. Gated by `FEATURE_PUBLIC_BOOKING` (default `false`).
`GET /api/public/book/:slug` returns `501 Not Implemented` until v2 ships.

## Why deferred

v1 booking is staff-initiated (any staff books on any staff's calendar via the 4-step wizard).
Public self-booking — where a client picks their own time from a shareable link without logging in —
adds an anonymous write surface that needs its own abuse controls, and is out of scope for the BK-1…BK-8
release.

## Data already in place

`staff_public_booking_link` (migration `0118`):

| column                         | meaning                                            |
| ------------------------------ | -------------------------------------------------- |
| `staff_id`                     | the staff member the link books onto               |
| `slug`                         | unique public path segment (`/book/:slug`)         |
| `is_active`                    | soft on/off without deleting the link              |
| `allowed_appointment_type_ids` | jsonb array of type ids; `null` = all active types |
| `custom_message`               | optional intro shown on the public page            |

## Intended v2 flow (no auth)

1. `GET /api/public/book/:slug` → resolve the active link; 404 if missing/inactive.
2. Public page: pick appointment type (restricted to `allowed_appointment_type_ids`) → pick a date →
   fetch open slots (reuse `getAvailableSlots` for the link's single staff member) → pick a slot.
3. Visitor enters name + email (+ optional phone). Create-or-match a `person`/`client_contact`
   (third-party = portal-only contact, per the people-reconciliation model).
4. `POST` creates the appointment via the same booking path as the wizard (single staff), then runs
   the existing fan-out: per-staff calendar write (BK-5) + confirmation email (BK-6).

## Abuse controls to add in v2

- Per-IP + per-slug rate limits (reuse `checkAndIncrement`, stricter than the 20/min token routes).
- CAPTCHA / proof-of-work before the create call.
- Email verification (send the confirmation only after a click-through) to stop fake bookings.
- A per-link daily booking cap.

## Reuse map

- Slot engine: `apps/api/src/appointments/availability.ts` (`getAvailableSlots`, single-staff path).
- Booking create: factor the multi-staff create in `booking-routes.ts` into a shared service the
  public route can call with `staffIds = [link.staffId]`.
- Calendar write + emails: the existing BK-5 / BK-6 jobs (no changes needed).
