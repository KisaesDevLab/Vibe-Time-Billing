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
