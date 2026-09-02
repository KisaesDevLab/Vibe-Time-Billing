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

## Phase 4 — inbound webhook + MMS

- Done: signed inbound webhook, idempotent ingest, association engine, D13a notifications, MMS queue/consumer, Intake session helper, legacy alias, tests.
- Notes: intake sessions need the firm key (DEK wrap) — the consumer runs in the API process and the unit test exercises the locked/deferred path when no key manager is present.

## Phase 5 — polling reconciler

- Done: `sms-poll` worker job (import, cursor/overlap, stuck-status backfill, media retry, gap detection + admin notice, A2P refresh), admin catalog, tests.
- Surprises: `rbac-middleware.ts` uses the Express `req.staffSession` augmentation, which the worker tsconfig doesn't see → resolvers extracted to `rbac-resolve.ts`.
- Milestone 1 reached: inbound works end to end (webhook + poll).

## Phase 6 — association engine + inbox API

- Done: inbox router (list/detail/thread/reply/read/assign/link/bulk/templates/stream/surfaces), event publisher, inbox-counts `sms`, core segment/template helpers, tests.
- Surprises: `audit_log` JSON columns are `before_json/after_json` (`afterJson` in Drizzle).

## Phase 7 — inbox list

- Done: SMS tab, stream provider, list panel + row, read-only thread pane, badge/dashboard wiring, reducer/notify tests.
- Notes: `Me` exposes `appUserId` (not `id`); a11y lint forbids click handlers on plain divs → dialogs use `Modal`.

## Phase 8 — thread view + composer

- Done: header, composer (templates, segments, banners), triage, link dialog, auto-read.
- Milestone 2 reached: the inbox is usable end to end (read + reply).

## Phase 9 — engagement, client, desktop surfaces

- Done: engagement panel, client SMS tab, contact actions, new-conversation dialog, Tauri notification plugin + web bridge + Account toggle.
- Notes: the desktop shell is CI-built (no Rust toolchain here) — the Cargo/capability changes are untested locally.

## Phase 10 — compliance

- Done: consent endpoints + provenance, booking/portal capture, consent-needed notification, tests.

## Phase 11 — PII, roles, retention, backup

- Done: PII detector + flags + preview/report endpoints, `sms:*` permission keys + full gate swap, retention cron, backup notes, tests.

## Phase 12 — reminder replies + time entry

- Done: reply hook (confirm / reschedule), confirm helper extraction, time-entry prefill + create, dialog + close prompt, tests.
- Surprises: the time-entry core needs a staff rate snapshot (`no_rate_resolves`) — the test seeds one like the appointments→time-entry test.

## Phase 13 — hardening, tests, docs

- Done: retry queue + consumer + manual retry, fixtures + signing helper, load test, KB/runbook docs, P27 note, QUESTIONS Q66–Q70.
- Milestone 3: all phases complete on `feat/sms-inbox`.
