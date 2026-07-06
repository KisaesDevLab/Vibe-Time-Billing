# Direct printing via the Vibe Print gateway (0185)

Vibe T&B can send rendered PDFs straight to a printer through a self-hosted
[Vibe Print](https://github.com/KisaesDevLab/Vibe-Printer) gateway on the LAN —
no browser print dialog. The app renders the document exactly as it does for
"Open PDF", then base64-forwards it to the gateway's `POST /v1/print/file`.

## Configure

Admin → Operations → **Printing**:
- **Gateway base URL** — reachable from the **api and worker** containers
  (e.g. `http://192.168.1.50:8080`). On the Docker appliance this means the
  gateway must be routable from the compose network.
- **API key** — the gateway's `VIBE_PRINT_SECRET` (stored encrypted under `KMS_KEY`).
- **Enable direct printing** — master switch; the per-feature print controls hide when off.
- **Default printer** — used for *automated* prints (run **Test connection** to list ids).
- **Auto-print signature confirmation** — see below.

Env fallback (overridden by the saved firm config): `PRINT_GATEWAY_BASE_URL`,
`PRINT_GATEWAY_API_KEY`.

## Multi-location printers (0186)

Admin → Printing → **Printer assignments** maps each gateway printer to an **office** +
label. The staff print picker then **groups printers by office** (`<optgroup>`), and
preselects: the user's remembered printer → a printer assigned to the user's default
office → the firm default. Run **Test connection** first to load the gateway's printers,
then assign each to an office.

## What can print directly
- **Route sheets** — "Print" on each recent route sheet (RouteSheetDialog).
- **Payment receipts** — "Print to printer" in the receipt actions.
- **Signature confirmation (automated, configurable — 0187)** — when a **tax-return**
  signature completes (OpenSign webhook, or the 2-min poll as a safety net), the firm's
  **signature print rules** (Admin → Operations → Signature print rules) decide what
  prints and where. Each rule has: a **trigger** (form codes + engagement/service types;
  empty = any), a **template** (the built-in confirmation report **or** a Vibe Print
  gateway template rendered from signature data via `POST /v1/print`), and a **printer**
  (a specific id, or the signature's **client office** printer from the assignments).
  First enabled rule by priority wins; no match → no print; printer unresolved → skip +
  log. **Configured rules are authoritative** — they apply whenever the gateway is enabled,
  regardless of the master "auto-print signature confirmation" toggle. That toggle governs
  only the **legacy fallback**: a firm with *no rules* but the toggle on + a firm default
  printer prints the built-in report to that printer. The gateway **Enable direct printing**
  switch is the global kill switch for all of it.
- **Terminal receipts (automated, 0186)** — each Stripe Terminal **reader** (Admin →
  Terminal → Readers) can be bound to a **receipt printer** + an **Auto-print** toggle.
  When a card-present payment completes (`payment_intent.succeeded` →
  `materializeReceiptIfPending`), if the reader that took it has auto-print on **and** a
  printer assigned, the receipt is rendered and printed to that printer. Auto-print on
  but no printer assigned → **skipped + logged** (`print_log` error `no_printer_assigned`)
  so receipts never print at the wrong location.

- **Notification PRINT channel (0188)** — notification templates (Admin → Messaging →
  Notification templates) gain a **PRINT** channel for: `invoice_sent`, `payment_received`,
  `statement_sent`, `signature_complete`, and engagement **status-change** notifications. A
  PRINT template defines a **message body** + a **printer** (a specific id, or the
  notification's **client-office** printer). When the notification fires it auto-prints a copy
  **alongside** the other channels (best-effort — a print failure never blocks email/SMS).
  Opt-in: it only prints when an **enabled PRINT template exists** for that kind; status-change
  prints also require `PRINT` in the status's notify methods. No-printer → skipped + logged.

Interactive prints use the live printer list (`GET /v1/printers`) and remember each
user's chosen printer (`app_user.default_printer_id`). Every send is recorded in
`print_log` (SENT/FAILED + gateway job id).

## Flow
- Staff: `POST /api/staff/route-sheets/:printId/print` / `POST /api/staff/payments/receipt/:id/print`
  `{ printerId, copies }` → render PDF → `sendToPrinter` → gateway.
- Auto: completion enqueues `signature-confirmation-print`; the worker renders +
  forwards (idempotency-key = request id). PDF rendering uses the shared
  `renderHtmlToPdf` (honors `PDF_SIDECAR_URL`).
