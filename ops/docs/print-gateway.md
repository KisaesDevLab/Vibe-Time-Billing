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
- **Signature confirmation (automated)** — when a **tax-return** signature request
  completes (OpenSign webhook, or the 2-min poll as a safety net), a confirmation
  report is rendered and printed to the firm **default printer** — only when the
  gateway is enabled, a default printer is set, and the auto-print toggle is on.
- **Terminal receipts (automated, 0186)** — each Stripe Terminal **reader** (Admin →
  Terminal → Readers) can be bound to a **receipt printer** + an **Auto-print** toggle.
  When a card-present payment completes (`payment_intent.succeeded` →
  `materializeReceiptIfPending`), if the reader that took it has auto-print on **and** a
  printer assigned, the receipt is rendered and printed to that printer. Auto-print on
  but no printer assigned → **skipped + logged** (`print_log` error `no_printer_assigned`)
  so receipts never print at the wrong location.

Interactive prints use the live printer list (`GET /v1/printers`) and remember each
user's chosen printer (`app_user.default_printer_id`). Every send is recorded in
`print_log` (SENT/FAILED + gateway job id).

## Flow
- Staff: `POST /api/staff/route-sheets/:printId/print` / `POST /api/staff/payments/receipt/:id/print`
  `{ printerId, copies }` → render PDF → `sendToPrinter` → gateway.
- Auto: completion enqueues `signature-confirmation-print`; the worker renders +
  forwards (idempotency-key = request id). PDF rendering uses the shared
  `renderHtmlToPdf` (honors `PDF_SIDECAR_URL`).
