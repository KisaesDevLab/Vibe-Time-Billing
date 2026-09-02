# STATE.md — Two-Way SMS Inbox (Twilio)

Addendum: `TB_SMS_INBOX_TWILIO_ADDENDUM.md` (13 phases). Branch `feat/sms-inbox`.
Plan of record: one conventional commit per phase; merge to `main` after Phase 5, Phase 8, Phase 13.
Open questions go to `QUESTIONS.md` (OPEN section). Progress narrative: `ops/docs/progress/sms-inbox.md`.

## Current phase

**Phase 1 — complete.** Next: Phase 2 (data model).

## Phase checklist

| Phase                                  | Commit                                                                       | Status       |
| -------------------------------------- | ---------------------------------------------------------------------------- | ------------ |
| 1 Provider seam + config + settings UI | `feat(sms): add SmsProvider seam and Twilio settings`                        | ✅           |
| 2 Data model                           | `feat(sms): messaging schema and contact phone normalization`                | ⏳           |
| 3 Outbound unification                 | `refactor(sms): route all outbound SMS through SmsSendService`               | ⏳           |
| 4 Inbound webhook + MMS                | `feat(sms): inbound Twilio webhook with signature validation and MMS intake` | ⏳           |
| 5 Polling reconciler                   | `feat(sms): polling reconciler and webhook gap detection`                    | ⏳ (merge 1) |
| 6 Association engine + inbox API       | `feat(sms): client/engagement association engine`                            | ⏳           |
| 7 Inbox list                           | `feat(sms): inbox conversation list`                                         | ⏳           |
| 8 Thread + reply                       | `feat(sms): thread view and reply composer`                                  | ⏳ (merge 2) |
| 9 Engagement / client / desktop        | `feat(sms): engagement, client, and desktop surfaces`                        | ⏳           |
| 10 Compliance                          | `feat(sms): opt-out, consent, and A2P registration checks`                   | ⏳           |
| 11 PII, roles, retention, backup       | `feat(sms): redaction, roles, retention, backup`                             | ⏳           |
| 12 Reminder replies + time entry       | `feat(sms): appointment reply parsing and time entry from thread`            | ⏳           |
| 13 Hardening + docs                    | `chore(sms): hardening, tests, and setup docs`                               | ⏳ (merge 3) |

## Decisions confirmed with the owner (2026-09-02)

- **U1** Inbox UI is a third tab on the existing `/messages` page (`Clients · Team · SMS`); SMS unread folds into the "Messages (n)" nav badge.
- **U2** Twilio credentials extend the existing `firm_settings.sms_config_encrypted` config (`messagingServiceSid`, optional `apiKeySid`/`apiKeySecret`; `from` optional once a Messaging Service is set). No `sms_provider_config` table.
- **U3** No `twilio` npm SDK — raw fetch client (`apps/api/src/sms/twilio-client.ts`) + the existing HMAC validator (`apps/api/src/sms/twilio-signature.ts`).
- **U4** One branch, milestone merges after phases 5 / 8 / 13.

## Adaptations from the addendum (codebase-driven)

| Addendum                                         | Adaptation                                                                                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------- | ------------ | --------- |
| `sms.view` etc.                                  | TB permission format `sms:read` / `sms:write` / `sms:assign` / `sms:settings` (added in Phase 11; until then settings routes use `firm:settings:read/write`).  |
| `sms_audit` table                                | Not created — `audit_log` rows via `emitAudit` (`entityType: sms_conversation                                                                                  | sms_message | sms_line | sms_settings | person`). |
| `sms_provider_config`                            | Folded into `firm_settings` columns (0233) + existing encrypted Twilio config.                                                                                 |
| D11 mirror "Meeting Notes transcript visibility" | No such feature exists. Visibility = `sms:read` + restricted-client exclusion.                                                                                 |
| D10 "same as unassigned transcripts"             | No transcript purge exists; 90/30-day cron added in Phase 11, skips `legal_hold_flag` clients.                                                                 |
| D7 "stored locally" + `data/sms-media/`          | Object storage (`packages/storage`) under `system/sms-media/…`; backup is whole-DB pg_dump, media lives in the storage bucket.                                 |
| D12 "engagement's primary activity code"         | Engagements have no primary work code → `firm_settings.sms_default_work_code_id` → `engagement.in_scope_work_code_ids[0]` → user picks.                        |
| D14 "existing SSE/WebSocket channel"             | Only ad-hoc SSE exists; new `GET /api/staff/sms/stream` + polling fallback.                                                                                    |
| "Mark the GoTo SMS plan as superseded"           | No GoTo plan exists in the repo; `ADDENDUM-PROPOSAL-MODULE.md` §P27 gets a note in Phase 13.                                                                   |
| Official Twilio SDK                              | Not added (U3).                                                                                                                                                |
| Consent (D8a) day-one impact                     | Phase 2 backfills `sms_consent_source='legacy'` for people texted successfully in the last 12 months; `firm_settings.sms_consent_enforced` is the kill switch. |

## Phase 1 notes

- Migration `0233_sms_inbox_settings.sql` (+ down): `firm_settings.sms_*` columns, `sms_line`.
- Schema: `packages/db/src/schema/sms.ts` (smsLines, SmsHealth, SmsA2pStatus); firm_settings columns in `core.ts`.
- Config: `TwilioConfig` gains MG sid / API key pair; cross-field rules live on the `SmsConfig` union (`superRefine`) because a discriminatedUnion can't hold a refined member.
- `createTwilioSmsProvider` sends via `MessagingServiceSid` when present (OTP/security sends included).
- Signature helpers extracted to `apps/api/src/sms/twilio-signature.ts`; `appointments/twilio-routes.ts` now imports them (behavior unchanged).
- Settings API: `/api/staff/sms/settings` (`GET`, `PUT`, `POST /test`, `GET /lines`, `POST /lines/sync`, `PATCH|DELETE /lines/:id`, `GET /health`, `POST /a2p/refresh`).
- Web: Admin → Email + SMS providers (Twilio card: MG sid, API key pair, "Test connection"); new Admin → SMS inbox page (`/admin/sms-inbox`).
- Deferred to later phases: firm-level quick-reply templates card (needs `sms_template`, Phase 2/6); `sms:settings` gate swap (Phase 11).
