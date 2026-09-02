# SMS Inbox (Twilio) — progress notes

See `STATE.md` at the repo root for the phase checklist and decision log.

## Phase 1 — provider seam, config, settings UI

- Done: migration 0233, `sms_line`, Twilio config extension (Messaging Service SID, API key pair), raw-fetch Twilio client, shared signature helpers, settings API + admin page.
- Surprises: zod `discriminatedUnion` rejects refined members — twilio cross-field rules moved to a `superRefine` on the union. Lines inserted in one transaction share `created_at`, so line ordering is `(created_at, phone_number_e164)`.
- Deferred: quick-reply templates card (needs Phase 2 tables), `sms:settings` permission (Phase 11).
