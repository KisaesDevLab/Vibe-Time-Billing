<!-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0 -->

# Document Intake — operator guide

A public, anonymous-friendly document-intake surface. Clients pick a staff
member, enter their name + email/phone, and upload or phone-scan documents.
Uploads are virus-scanned and (for image batches) combined into a PDF, then
land in the staff **Intake Inbox** for filing into a client → folder.

Display name in the UI: **Vibe Practice Management**.

---

## Architecture at a glance

| Layer | What |
|---|---|
| Public SPA | `apps/intake` (own origin: `:5197` local, `intake.<zone>` via tunnel). Exposes **only** `/api/public/intake/*` + the static SPA. |
| Public API | `/api/public/intake/*` — unauthenticated, CORS + per-IP rate limited, isolated outside the staff/portal auth chains. |
| Quarantine | Uploads stream (API-proxied) to `intake/quarantine/<sessionId>/<fileId>` — never a client bucket — invisible until scanned. |
| Worker | `intake-process` BullMQ job: ClamAV scan → image→PDF assembly → mark `received` → notify the target staff. |
| Staff inbox | `/intake` (nav) + `/api/staff/intake/*` — decrypts PII, downloads, disposition. |
| Admin | Admin → **Document intake** (`/admin/intake-settings`) — feature toggle + per-staff cards + headshots. |

**Encryption:** each session/link carries a per-record DEK wrapped by the
firm master key (MFK). PII columns (name/email/phone/message) and the
original filename are encrypted at rest. File bytes use the same at-rest
posture as the rest of the File Manager. The worker holds no firm key, so
its notifications are generic — decrypted details appear only in the
authenticated inbox.

---

## Enabling intake

1. **Turn the feature on.** Admin → **Document intake** → check *Document
   intake enabled*. (Per-firm flag `firm_config.intake_enabled`.)
2. **Show staff cards.** In the same screen, check *Visible* for each staff
   member who should appear on the public page. Optionally set a *Title*
   (e.g. "Tax Manager"), display *Order*, notification prefs, and upload a
   *Headshot*. Every active staff member starts with a hidden card.
3. **Publish the host.** Add `intake.<your-zone>` in Admin → Cloudflare
   Tunnel with realm **Intake**. This
   creates the ingress + DNS so the public page is reachable on the
   internet. Locally it is served at `https://<host>:5197`.

To turn it off: uncheck *Document intake enabled* — the public page then
returns a neutral "not available" message and reveals nothing.

---

## The flow

1. Client opens `intake.<zone>`, picks a staff member, enters name +
   email/phone, uploads files or scans pages with their phone camera.
2. Files land in quarantine; the session is `pending_scan` and the worker
   is enqueued on **Send**.
3. Worker scans every file with ClamAV. Infected → the file is marked
   `infected`, the session `rejected`, and staff get an alert. Clean →
   image pages are combined into one PDF and the session becomes
   `received`.
4. The target staff member is notified (in-app alert always; email/SMS per
   their card prefs — generic copy only).
5. Staff open **Intake** in the main nav, review the decrypted details +
   files, and **File to client** (auto-match suggestions are offered) or
   **Reject**. Filing copies the documents into that client's File Manager
   folder and records an `intake_actions` row.

---

## Send a link

From the Intake inbox, **Send a link** generates a one-time, expiring upload
link bound to a staff member (works even if that staff card is hidden).
Optionally email/text it to a recipient. The token is the bearer credential
(only its SHA-256 hash is stored); it expires after the chosen window and is
single-use.

---

## ClamAV sidecar

ClamAV is an opt-in compose service (the `intake` profile) because its
signature database needs ~1 GB resident.

```bash
# bring up clamd (first boot downloads signatures — ~1–2 min to ready)
docker compose -f ops/docker/docker-compose.local.yml --profile intake up -d clamd
# point the worker at it
CLAMD_HOST=clamd docker compose -f ops/docker/docker-compose.local.yml up -d worker
```

If `CLAMD_HOST` is unset the worker logs a loud warning and **skips**
scanning so the pipeline still functions on appliances that haven't enabled
the sidecar — enable clamd before going live.

---

## Metrics

`/metrics` exposes `vibe_intake_sessions{status="…"}` gauges
(pending_scan / processing / received / disposed / rejected).

---

## Notes / deferred (v2)

- Create-new-client directly from an intake submission.
- Routing a disposed PDF straight into a Tax Return slot (today: file it,
  then use the existing tax intake-from-file on the resulting PDF).
- jscanify auto edge-detection / perspective crop in the phone scanner
  (today: full-frame capture).

## Phone scanner notes (2026-09)

The in-browser scanner (`@vibe/ui` `CameraCapture`, shared with the portal)
now asks for a readable resolution + continuous focus, prefers the main rear
lens on multi-camera Android phones, disables the shutter until the first
frame is decodable, and explains permission / busy-camera errors. A native
**Take a photo** button (`<input capture="environment">`) sits next to it
and is the only camera path in in-app browsers (Gmail, Facebook, LinkedIn
WebViews have no `getUserMedia`). The same native button exists on the
portal's document-request items and message composers.
- Retention auto-delete of disposed/rejected sessions.
