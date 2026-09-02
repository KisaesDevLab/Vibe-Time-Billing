# SMS inbox — operator runbook

## Components

| Piece | Where | Notes |
|---|---|---|
| Inbound webhook | `POST /api/sms/twilio/inbound` (api) | Twilio-signature verified against the PUBLIC origin candidates (firm override → `PUBLIC_BASE_URL` → `APP_BASE_URL`). |
| Status callback | `POST /api/sms/twilio/status` (api) | Same signature gate; updates `sms_message` + `notification_log`. |
| Polling reconciler | worker cron `sms-poll` (every 2 min; per-firm interval) | Imports missed inbound, back-fills stuck outbound status, retries media, refreshes A2P. |
| MMS pipeline | api-process BullMQ consumer `sms-media` (`SMS_MEDIA_CONSUMER=0` disables) | Twilio → object storage `system/sms-media/…` → Intake → delete from Twilio. |
| Send retry | api-process consumer `sms-send-retry` (`SMS_RETRY_CONSUMER=0` disables) | 30 s·2^n backoff ≤ 8 min, 5 attempts, then `dead_letter` + staff notification. |
| Retention | worker cron `sms-retention` (03:50) | Unassigned 90 d, spam/closed-unassigned 30 d (firm-configurable); client-linked threads never purged. |
| Real-time | `GET /api/staff/sms/stream` (SSE over Redis `sms:events:{firmId}`) | Browser falls back to polling when SSE is unavailable. |

## Health card (Admin → SMS inbox)

- **Last inbound webhook** stale while **Last poll** is recent and texts keep arriving → the public URL/tunnel is wrong. The card shows "Polling is finding inbound texts that the webhook never delivered" and admins get one `sms_webhook_gap` notification per day.
- **Rejected signatures (24h)** > 0 → a wrong Auth Token or a public-URL mismatch (Twilio signs the exact URL configured in the console, including scheme and host).
- **Send failures (24h)** / last error → check A2P status and the Twilio console error codes (21610 opted out, 30034 A2P blocked, 30007 carrier filtered).

## Common fixes

- **Texts arrive minutes late**: webhook not reaching the appliance; fix the tunnel or set the firm's Public base URL. Polling keeps things flowing meanwhile.
- **"No texting line"**: no `sms_line` rows — Admin → SMS inbox → Refresh from Twilio (the first send also auto-syncs).
- **Media stuck "processing"**: see `sms_media.status/error`; failed rows are retried for 24 h by the poll tick; the appliance must be unlocked for the Intake hand-off.
- **Dead-lettered text**: staff can Retry from the thread (`POST /api/staff/sms/messages/:id/retry`).

## Manual runs

Admin → Jobs → run `sms-poll` or `sms-retention` now. A manual Twilio test against the test credentials (`+15005550006` "valid" number) exercises the send path without billing.

## Backup / restore

`sms_*` tables are in the nightly pg_dump. Media lives in the storage bucket under `system/sms-media/` — restore the bucket with the database (Twilio's copies are deleted after import).
