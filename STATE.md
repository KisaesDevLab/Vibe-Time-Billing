# STATE.md — Two-Way SMS Inbox (Twilio)

Addendum: `TB_SMS_INBOX_TWILIO_ADDENDUM.md` (13 phases). Branch `feat/sms-inbox`.
Plan of record: one conventional commit per phase; merge to `main` after Phase 5, Phase 8, Phase 13.
Open questions go to `QUESTIONS.md` (OPEN section). Progress narrative: `ops/docs/progress/sms-inbox.md`.

## Current phase

**Phase 8 — complete (milestone 2).** Next: Phase 9 (engagement / client / desktop surfaces).

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

## Phase 2 notes

- Migration `0234_sms_inbox.sql` (+ down): `person.phone_e164/mobile_e164` (trigger `person_sync_phone_e164_trg` over plpgsql `vibetb.normalize_phone_e164`, mirrors `normalizePhone`), opt-out provenance, consent columns + CHECK, legacy consent backfill from `notification_log`; `sms_conversation`, `sms_message`, `sms_media`, `sms_template`; `intake_sessions.source` CHECK gains `'sms'`.
- Schema: `packages/db/src/schema/sms.ts` (all four tables + string-union types); person columns in `core.ts`.
- Harness: `seedSmsLine()` in `apps/api/src/__tests__/_pglite-harness.ts`.
- `sms_message.provider_status` vocabulary = Twilio's full set + `dead_letter`; `context_kind` includes `inbound` for received rows; `parsed_intent` column added now (D13, Phase 12).

## Phase 3 notes

- `apps/api/src/sms/send-service.ts` — `createSmsSendService().send({to, body, context})`. Two modes decided per firm at send time: **inbox** (Twilio + Messaging Service SID **and** `sms_inbox_enabled`) → gates opt-out → consent → A2P, conversation upsert (reopens closed), `sms_message` row before the provider call, Messaging Service send with `StatusCallback`, `notification_log` row, 21610 → person opt-out; **legacy** (anything else) → opt-out gate when the person is known, then the fallback provider exactly as before. `kind: 'security'` always uses the fallback.
- Consent rule as built: required only when a person is resolved (explicit or unique E.164 match) with no `sms_consent_at`, and the (line, number) conversation has no inbound yet; `auto_reply` exempt; `sms_consent_enforced=false` disables. Unknown numbers are not blocked (nothing to hold a record) — logged as an OPEN question.
- Line pick order: conversation's own line → existing thread with that number on any active line → `context.lineId` → default → first active → one-time auto-sync from the Messaging Service.
- Wiring: API `server.ts` `smsSend` (fallback = the audit-wrapped env/firm provider); `sendPortalSms` accepts an optional `context` and defaults to `notification/other`; `sendSmsOtp` → `security`. Worker `index.ts` `workerSmsSend` + `workerSendSms` adapter replaces every `dunningSendSms` wiring (reminders, request reminders, dunning, staged notifications, intake, internal-message notify). Reminders return `{skipped}` on policy blocks and the ledger records `delivery_status = skipped_<reason>`. Booking visitor confirmations carry `booking/bookingRequestId`; client-request reminders carry `client_request/…`; voice fallback goes through the service when present.
- Status callback: signed `POST /api/sms/twilio/status` (`apps/api/src/sms/webhook-routes.ts`) — 204 first, updates `sms_message` (never regresses terminal states), 21610 opt-out, `sms_last_status_webhook_at`, and calls `applyTwilioDeliveryStatus` so `notification_log` stays in sync. The old shared-secret `/api/webhooks/notifications/twilio` is untouched.
- `syncLines` moved to zod-free `apps/api/src/sms/lines.ts` (the worker imports the send service, and `settings-routes.ts` pulls zod + the Express session augmentation).

## Phase 4 notes

- `POST /api/sms/twilio/inbound` (`apps/api/src/sms/webhook-routes.ts`): signature-verified against the public-origin candidates, parses `MessageSid/From/To/Body/NumMedia/MediaUrlN/MediaContentTypeN/OptOutType`, always answers `<Response/>` (503 only when ingestion throws so Twilio retries).
- `apps/api/src/sms/ingest.ts` `ingestInboundMessage(deps, msg, {source})` — dedupe on sid → line lookup (auto-discovers an unknown firm number as an ingesting line, flagged in `sms_health.lines.autoDiscovered`) → conversation upsert (+unread, reopen closed) + message insert in one transaction (`ON CONFLICT DO NOTHING` rolls back the unread bump on a race) → association → consent (`inbound`) → STOP/START (`OptOutType` or first word; bare YES only counts as START when Twilio says so) → Communications row (client known) → `sms_media` rows + jobs → hooks (`detectPii`, `onInbound` for Phase 11/12) → D13a notifications → health/events. Lines with `ingest=false` are ignored.
- `apps/api/src/sms/associate.ts` — full §3 engine (manual never overridden; reply-context ≤14 d via appointment / client-request / engagement on a prior outbound; unique phone match → link + suggested engagement when the client has exactly one ACTIVE engagement; several → `needs_triage` + candidates). Phase 6 adds the endpoints.
- `apps/api/src/sms/notify.ts` — recipients: assignee → line default assignee → all ACTIVE users with the inbox-read permission (`messaging:read` until Phase 11 introduces `sms:read`); `staff_notification` rows `type='sms_inbound'`, `actionUrl=/messages?tab=sms&c=<id>`.
- MMS: `media-queue.ts` (`sms-media`, jobId `sms-media-<id>`, 5 attempts) + API-process consumer `media-consumer.ts` (`SMS_MEDIA_CONSUMER=0` disables): fetch (auth only on api.twilio.com) → sha256 → `system/sms-media/{firm}/{conv}/{msg}/{mediaSid}.<ext>` → `createIntakeSessionWithFiles` (new `apps/api/src/intake/create-session.ts`, `source='sms'`, target staff = assignee → line default → first firm user, `matchedClientId`) → `deleteMedia`; delete failures leave `remote_deleted=false` for the Phase 5 sweep; a locked appliance defers the hand-off (retry).
- Legacy `/api/public/appointments/twilio/sms` now ingests first (skips its own Communications log when ingested) and still runs the CONFIRM keyword logic until Phase 12 moves it into the ingest hook. `resolveSenderClient` now uses the indexed `findPersonsByE164`.

## Phase 5 notes

- Worker queue `sms-poll` (cron `*/2 * * * *`, `apps/worker/src/jobs/sms-poll.ts` `runSmsPollTick`): per enabled firm, only when `sms_poll_interval_minutes` has elapsed (or `force`); per ACTIVE ingesting line lists Twilio messages since `poll_cursor_at − 5 min` (first poll: 24 h lookback), ingests inbound with `source:'poll'` (media via `listMedia`), advances the cursor; back-fills outbound rows stuck in queued/accepted/sending/sent > 10 min (21610 → opt-out); re-queues `failed` media (< 24 h) and stored-but-not-deleted media; gap = poll imported inbound and no webhook since before the oldest import → `sms_health.webhook.gapDetectedAt/missedSincePoll` + one `staff_notification` (`sms_webhook_gap`) per day to `firm:settings:write` holders; A2P refreshed every 6 h; `sms_health.poll` + `sms_last_poll_at` merge-written.
- Admin job catalog + preview note gained `sms-poll`.
- `apps/api/src/auth/rbac-resolve.ts` — Express-free permission resolvers split out of `rbac-middleware.ts` (which re-exports them) so worker-side code can resolve "who holds X".
- Health card: `webhookGap` derives from `sms_health.webhook.gapDetectedAt`; the next successful inbound webhook clears it (ingest writes `gapDetectedAt: null`).

## Phase 6 notes

- `apps/api/src/sms/routes.ts` mounted at `/api/staff/sms` (auth + CSRF): `GET /conversations` (filters unread/unassigned/triage/mine/all, `status`, `q` over contact name / number digits / body, `clientId`/`engagementId`, cursor on `last_message_at`, restricted-client exclusion), `GET /conversations/:id` (detail + `candidates`, `consent`, `optOut`, `canReply`/`replyBlockReason`, `templateVars`, `engagementOptions`, `piiWarningsEnabled`), `GET /conversations/:id/messages` (with media descriptors → `/api/staff/sms/media/:id`), `POST /conversations` (manual; staff-picked client = manual link), `POST /conversations/:id/messages` (reply on the thread's line; confirms a suggested/picked engagement — D6), `read`/`unread`, `PATCH` (assign/status/engagement), `link`/`unlink`/`rematch`, `bulk`, templates (user scope private; firm scope needs `firm:settings:write` until Phase 11), `/templates/:id/render`, `/unread-count`, `/stream` (SSE over Redis `sms:events:{firmId}`, blocked clients filtered), `/engagements/:id/conversations`, `/clients/:id/conversations`.
- Permission keys are constants at the top of the router (`PERM_READ = messaging:read`, `PERM_WRITE/ASSIGN = messaging:write`, `PERM_SETTINGS = firm:settings:write`) for the Phase 11 swap.
- Events: `apps/api/src/sms/events.ts` (`createSmsPublisher(redis)`, `smsEventChannel`); `server.ts` wires it into the send service and `AppDeps.smsPublish` (ingest + status callback).
- `GET /api/staff/stats/inbox-counts` gained `sms` (open, unread, assigned to me or unassigned).
- `packages/core/src/sms` — `countSmsSegments` (GSM-7/UCS-2), `renderSmsTemplate` / `extractSmsTemplateVars` / `firstNameOf` (`@vibe/core/sms`).
- Send-path 409 vocabulary: `sms_opted_out`, `sms_consent_required`, `sms_a2p_unregistered`, `sms_no_line`, `sms_conversation_closed|spam`; 400 `sms_invalid_number`; 502 `sms_provider_error`; 503 `sms_rate_limited|not_configured`.

## Phase 7 notes

- `/messages` gains an **SMS** tab (`?tab=sms`, deep link `&c=<conversationId>&filter=<unread|unassigned|triage|mine|all>`); the nav badge shows team + SMS unread combined; the Dashboard "Needs attention" card gains **Texts**.
- `apps/web/src/lib/sms-stream.tsx` — app-level `SmsStreamProvider` (mounted in `Shell`) holding one `EventSource` on `/api/staff/sms/stream`, falling back to 20 s polling when SSE never delivers; exposes `unread`, `health`, `subscribe`, `setActiveConversation`, and the desktop-notify preference (Phase 9 hooks `onInbound`).
- `apps/web/src/pages/sms/SmsInboxPanel.tsx` — filter chips, debounced search, cursor "Load more", hand-rolled selection + bulk bar (read / assign / close / spam), unread-row styling, optimistic read on open, A2P + webhook-gap banners, "not set up" empty state; `ConversationRow.tsx`; `SmsThreadPane.tsx` (read-only bubbles with delivery-status chips, error tooltips, media thumbnails → Intake; Phase 8 adds the header actions + composer); pure `stream-reducer.ts` + `lib/sms-notify.ts` with node-env tests.
- "New text" is a placeholder modal until Phase 9's `NewSmsConversationDialog`.

## Phase 8 notes

- `SmsThreadPane.tsx` now composes `SmsThreadHeader` (contact/client/engagement chips — suggested = warning pill; assignee `Combobox`; overflow `Menu`: mark unread, assign to me, link/change client, unlink, re-run matching, create time entry (Phase 12), reopen/close/spam — gated actions disabled with a reason), `TriagePanel` (one-click link per candidate), the bubble list (auto-scroll), and `SmsComposer`.
- `SmsComposer.tsx` — engagement picker (a suggested engagement shows "sending confirms it"), quick-reply template `Menu` rendered client-side at insert (`renderSmsTemplate` from `@vibe/core/sms`; unresolved `{vars}` warn), GSM-7/UCS-2 `SegmentCounter`, Ctrl/Cmd+Enter, policy banners (`opted_out` — no override; `consent_required` with "Record verbal consent" → `POST /api/staff/people/:id/sms-consent` (Phase 10); `a2p_unregistered`; `closed|spam` with Reopen), 409 → banner. The PII warning calls `POST …/messages/preview-flags` which lands in Phase 11 (404s are swallowed until then).
- `LinkClientDialog.tsx` — client picker → client's people → optional engagement → "also save this number as mobile/phone".
- Auto-read: an unread thread is marked read 1.5 s after it's visible unless "Mark unread" armed it. Threads reload on `sms.message.created|status` for their conversation.
- `apps/web/src/pages/messaging/styles.ts` — shared `composerTextareaStyle`.
