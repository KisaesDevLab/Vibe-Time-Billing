# SMS Inbox (Twilio) — progress notes

See `STATE.md` at the repo root for the phase checklist and decision log.

## Phase 1 — provider seam, config, settings UI

- Done: migration 0233, `sms_line`, Twilio config extension (Messaging Service SID, API key pair), raw-fetch Twilio client, shared signature helpers, settings API + admin page.
- Surprises: zod `discriminatedUnion` rejects refined members — twilio cross-field rules moved to a `superRefine` on the union. Lines inserted in one transaction share `created_at`, so line ordering is `(created_at, phone_number_e164)`.
- Deferred: quick-reply templates card (needs Phase 2 tables), `sms:settings` permission (Phase 11).

## Phase 2 — data model

- Done: migration 0234 + down, Drizzle schema, harness seeder, schema test (trigger, uniques, consent CHECK, down/up round-trip).
- Surprises: `expectDbReject` takes a promise, not a thunk. `intake_sessions.source` CHECK was unnamed in 0103 → dropped by both auto and explicit names, re-added as `intake_sessions_source_ck`.

## Phase 3 — outbound unification

- Done: `SmsSendService`, API + worker wiring, signed status callback, tests (service gates/rows/21610/line pick; status webhook proxy-URL + non-regression).
- Surprises: worker typecheck pulled `settings-routes.ts` (zod + `req.staffSession`) through the send service → `syncLines` extracted to `sms/lines.ts`. Test fetch stub must mint unique sids.
