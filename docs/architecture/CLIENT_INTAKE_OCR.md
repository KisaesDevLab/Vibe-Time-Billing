# Client Intake OCR (Capture Client Info)

## What it is

"Capture Client Info" lets staff populate the New Client form from a tax
program's **General Information** screen (built for UltraTax CS) instead of
retyping it. The screen is captured as an image, read by the firm's **local
GLM-OCR** server, mapped to the client form, and shown for human review
before anything is saved.

## Data flow — local only, zero egress

```
Desktop shell (apps/desktop, Tauri + xcap)     ── OR ──   Browser upload (PNG/JPG/PDF)
  capture_window(id) → in-memory base64 PNG                fileToPngBase64() rasterizes p.1
        │                                                        │
        └───────────────► POST /api/staff/ocr/client-intake ◄────┘   { imageBase64 }
                                   │
                 apps/api/src/ocr/glm-client.ts
                 → POST http://<GLM_OCR_URL>/v1/chat/completions  (model glm-ocr, temp 0)
                                   │
                 Local GLM-OCR server on the firm's on-prem workstation
                                   │
                 Zod-validate → map (map-to-client.ts) → { extracted, mapped }
                                   │
                 Confirm-before-fill review → New Client wizard → POST /clients
```

The screenshot is sent **only** to `GLM_OCR_URL`, which is a trusted LAN
address on the firm's own hardware. Nothing goes to Anthropic, OpenAI, or any
third party. This is consistent with [AI_EGRESS_POLICY.md](./AI_EGRESS_POLICY.md):
the cloud provider is never involved, so the egress gate and Vibe Shield are
not in the path. The capture bytes live in memory only — the desktop command
returns base64 directly and never writes a PNG to disk.

## Compliance posture (WISP note)

Tax preparers are financial institutions under the GLBA / FTC Safeguards Rule
(16 C.F.R. Part 314) and are bound by IRC §7216 / §6713 on use and disclosure
of taxpayer information. Because client-intake OCR runs entirely on-prem
(screenshot → local GLM-OCR on the firm workstation → local Postgres), there
is **no third-party disclosure and no egress**. Add to the firm WISP:

> Client-intake OCR ("Capture Client Info") processes screen captures of tax
> return General Information screens on the firm's on-premises workstation
> running a local GLM-OCR model. Images are transmitted only over the LAN to
> that workstation and are not stored on disk or disclosed to any third party.

## Deliberate limits

- **Tax IDs are never captured.** The OCR schema and prompt exclude SSN and
  EIN; the audit record excludes them too. Staff enter tax IDs manually via
  the existing hash-only flow (`apps/api/src/portal/tax-id.ts`,
  `POST /clients/:id/tax-id`). See `apps/api/src/ocr/map-to-client.ts`.
- **No `.CSD` parsing.** The UltraTax binary client file is never read;
  screen capture + OCR is the only path.
- **No schema migration.** Extraction maps to existing columns (`name`,
  `client_type`, `filing_status`, `mailing_*`). Entity-specific fields with no
  column (entity form, state/date of incorporation, S-election date, business
  code, tax-year dates) are stashed in the existing `custom_fields` jsonb.
- **Human-in-the-loop.** The endpoint never writes a client. Extracted values
  pre-fill the wizard; the CPA reviews, edits, and clicks Create.

## Configuration

Set in the appliance env (see `.env.example`):

| var                  | default   | note                                                                                                                                      |
| -------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `GLM_OCR_URL`        | _(unset)_ | LAN base URL, e.g. `http://192.168.68.105:8082`. **Unset disables the feature** (endpoint returns 503, capture UI hides the window path). |
| `GLM_OCR_MODEL`      | `glm-ocr` | must match the served model                                                                                                               |
| `GLM_OCR_API_KEY`    | _(unset)_ | optional bearer; the reference server is unauthenticated on the LAN                                                                       |
| `GLM_OCR_TIMEOUT_MS` | `120000`  | per-request timeout                                                                                                                       |

## Capture backends & fallback

The desktop shell captures via `xcap` (GDI BitBlt on Windows), which works for
conventional Win32 apps like UltraTax CS. On GPU-accelerated or occluded
windows — notably RDP/Citrix-hosted setups — BitBlt can return black frames.
When capture is unusable, staff use the **upload fallback**: print/export the
General Information screen and drop the PNG/JPG/PDF into the same modal. The
fallback also covers browsers and non-Windows machines where the desktop shell
isn't installed.

## Key files

- Desktop: `apps/desktop/` (`src-tauri/src/lib.rs` — `list_capturable_windows`, `capture_window`)
- Backend: `apps/api/src/ocr/{glm-client.ts, map-to-client.ts, routes.ts}`; config in `apps/api/src/config.ts`; wiring in `server.ts` / `app.ts`
- Frontend: `apps/web/src/lib/{desktop.ts, rasterize.ts}`, `apps/web/src/pages/clients/CaptureClientInfo.tsx`, entry point in `CreateClientWizard.tsx`
