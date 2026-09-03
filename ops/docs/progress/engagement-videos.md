# Engagement videos — progress notes

Branch `feat/engagement-videos` (cut from `main` 2026-09-03). One conventional commit per phase.
Plan of record: `~/.claude/plans/i-want-to-add-abundant-flamingo.md` (decisions D1–D11 confirmed with the operator).

## Decisions confirmed with the operator (2026-09-03)

| # | Decision |
| --- | --- |
| D1 | Video is attached to an **engagement**; portal distribution follows the engagement's client. |
| D2 | "Played" = first press of play; furthest point and completion are also recorded. |
| D3 | Retention per video with firm defaults (`firm_settings.video_default_*`); either clock nullable; earliest wins. |
| D4 | Notify via portal + email + SMS to all eligible contacts, sent immediately; "Notify client" checkbox at upload. |
| D5 | Staff: Videos card on the engagement page + read-only Videos tab on the client record. |
| D6 | Portal: Videos card on the home page (hidden when empty) → full-width player page. |
| D7 | Stream only — no download. |
| D8 | MP4 / MOV / WebM ≤ 2 GB; .mov HEVC warning; no transcoding. |
| D9 | Summary + per-viewer play log; first play writes a `client_communication` row. |
| D10 | Expiry deletes the object, keeps the row as EXPIRED with history; staff can delete early or extend. |
| D11 | Reply under the video lands in the engagement's client thread, tagged with the video. |

## Phase 1 — schema and permissions

- Done: migration `0235_engagement_videos.sql` (+ down): `engagement_video`, `engagement_video_play`, `firm_settings.video_default_delete_after_days|_days_after_play`, `message.engagement_video_id`. Drizzle mirrors in `core.ts`; `video:read|write|delete` (partner/manager all three, senior/staff read+write). `@vibe/core` `videos.computeVideoExpiresAt` / `videoProgressPct` (zod-free, worker-safe).
- Notes: `expires_at` is app-maintained (no generated column — pglite). `engagement_video_play.portal_identity_id` is a loose uuid in Drizzle (FK in SQL) to avoid a `core.ts → portal.ts` cycle.

## Phase 2 — staff API

- Done: `apps/api/src/engagements/videos.ts` — reserve (60-min presigned PUT, 2 GiB cap, firm-default clocks), complete (409 until the object lands, 413 over cap), list per engagement / per client (with `replyCount`), patch (recomputes `expires_at`; 409 once EXPIRED/DELETED), delete-now (object gone, row kept; pending reservations hard-removed), play log. Firm defaults ride the generic `PATCH /api/staff/admin/firm-settings`.
- Storage keys: `system/engagement-videos/{firm}/{engagement}/{video}/{filename}` — never under `Client Files/`.

## Phase 3 — notification

- Done: `notifications/staged/video.ts` stages an IMMEDIATE EMAIL+SMS+PORTAL row (`templateKind engagement_video_ready`, `supersedeKey engagement_video:<id>`). Recipient snapshot extracted to `loadEligibleContactRecipients()` and shared with the status producer. Worker deep-links PORTAL rows to `/videos/:id` and cancels at fire time if the video is no longer AVAILABLE. Seeded EMAIL/SMS copy + admin template kind.

## Phase 4 — portal API and replies

- Done: `portal/videos.ts` — scoped list (`playedByMe`), metadata (410 when expired), 6 h inline presigned stream URL (60/h per identity), play start (first play → `first_played_at`, `expires_at` recompute, timeline row), heartbeats (owner-only, monotonic, 3 s server throttle, completion never dropped), conversation tail, reply. Reply reuses `provisionThreadForEngagement` and the client-thread staff routing, now extracted to `engagement-messaging/client-thread.ts` and shared with portal messaging. `/attention` gains `newVideos`; activity allowlist gains `engagement_video`; message lists expose `videoId`/`videoTitle`.
- Impersonation: middleware blocks non-GET; the play/reply handlers also check `isImpersonation` explicitly.

## Phase 5 — worker

- Done: `engagement-video-expiry` (hourly at :20) — object delete best-effort, row → EXPIRED, one batched audit row per tick. `pending-upload-sweep` also reaps abandoned video reservations (never before the 60-min PUT TTL).

## Phase 6 — staff UI

- Done: `EngagementVideosCard` (+ `VideoUploadDialog`, `VideoPlaysModal`, inline edit dialog), `useVideoUpload` (XHR PUT with progress, abort, complete-with-retry, mock-presign dev path), `ClientVideosCard` + Videos tab, Admin → Settings video defaults, "Re: video" chip in `ThreadView`.
- Deviation: the per-viewer log is a modal, not an inline expander (`@vibe/ui` Table has no expand-row primitive).

## Phase 7 — portal UI

- Done: home "Videos from your firm" section (hidden when empty), `/videos/:id` player (`playsInline`, `controlsList="nodownload"`, URL-expiry recovery, codec fallback copy), `lib/video-plays.ts` tracker (fetch keepalive, not sendBeacon — CSRF), reply composer + conversation tail, `Messages?thread=` deep link + chip.

## Still manual / not verified here

- Live B2 smoke (real presigned PUT from Chrome, Range playback on iPhone Safari / Android Chrome, HEVC .mov on Windows).
- EmailIt + Twilio delivery of `engagement_video_ready`.
- Deploy: migration 0235, api + worker recreate (`--no-deps`), `init-static` re-run for web + portal, bucket CORS unchanged (PUT/GET already allowed for practice + portal origins).

## Post-review fixes (2026-09-03)

A code review of the branch found nine issues; all are fixed on the branch.

- **Restricted clients (0165) were not enforced** on any of the seven staff
  video routes — the hidden Videos tab was a UI-only gate, so a blocked
  staffer could list, upload to and delete a restricted client's videos and
  read viewer names and emails from the play log. `blockIfClientRestricted`
  now guards all seven.
- **A refused reply still granted thread access.** The ARCHIVED check ran
  after `ensureEngagementClientThread` had inserted members, and the message
  route never filtered `threads.status`. The archived check now runs first.
- **One reply promoted every contact.** `ensureEngagementClientThread` took
  every ACTIVE `client_portal_access` row, so one contact replying opened the
  thread backlog to the whole household. It now takes an explicit
  `portalIdentityIds` and the portal passes only the replier.
- **Soft-removed members were silently re-added** (the unique indexes are
  partial on `removed_at IS NULL`, so the insert succeeded). Membership is now
  keyed on *any* row, removed included — re-admitting is a staff action.
- **A failed notification was recorded as sent.** `notified_at` was stamped
  before the fire-and-forget producer ran with its error swallowed, so a Redis
  blip permanently suppressed the client's email/SMS/portal notice. The
  producer is awaited, `notified_at` is stamped only on success, failures are
  logged and `notifyFailed` comes back in the response. The status flip is now
  guarded on `PENDING_UPLOAD` so overlapping completes cannot both notify.
- **The expiry sweep deleted before it flipped**, and its guard ignored
  `expires_at` — a retention extension landing mid-tick destroyed the object
  anyway. It now flips first, guarded on `lte(expires_at, now)`, and deletes
  only after the flip wins.
- **The pending-video sweep cutoff equalled the presign TTL** (60 min), so a
  2 GB upload still streaming past the hour lost its row and orphaned its
  object. Raised to 12 hours.
- **First play was a read-then-write** under READ COMMITTED, so simultaneous
  plays both claimed it and both wrote a timeline row. It is now a conditional
  `UPDATE … WHERE first_played_at IS NULL … RETURNING`.
- **Cancel during 'finalizing'** raced `/complete`; the button is disabled
  once there is nothing left to cancel.

