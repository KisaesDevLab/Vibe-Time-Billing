# Vibe Practice Management — demo walkthrough

A 10-minute path from a fresh clone to seeing the differentiator live.

## What you'll see

By the end of this walkthrough, sitting in front of a browser:

1. A staff member signs in via magic link, completes TOTP enrollment.
2. They log time against an engagement; the rate snapshot is captured at write time.
3. They open a billing batch, review WIP, deferring/including entries.
4. They create a hierarchical-cascade adjustment — Sarah Chen (partner) absorbs $1,000, Mike Davis (manager) absorbs $200, Rachel Kim and Jenny Park are held harmless. The per-timekeeper preview updates live.
5. They generate the invoice, send it, and watch the audit log row land.
6. A client (Tom Vance) signs into the portal at `portal.firm.com`, switches between his three entity accesses, views the invoice, pays via Stripe test-mode.
7. The "Viewed in portal" pill flips green on the staff invoice list. AR aging recomputes.

That's the demoable loop.

---

## Prerequisites

- Node.js 20.11.1+ (`.nvmrc` is checked in)
- pnpm 8.15+
- Docker (only for `pnpm docker:up` to bring up Postgres + Redis + MailHog locally)
- (Optional) Stripe test API key for live payment demo
- (Optional) Anthropic API key for live AI description suggestions

## 0. Clone and install

```sh
git clone [email protected]:KisaesDevLab/Vibe-Time-Billing.git
cd Vibe-Time-Billing
pnpm install
cp .env.example .env
```

The default `.env.example` works out of the box for local dev — JWT secrets are placeholder, Postgres/Redis URLs point at `localhost`, no provider keys.

## 1. Boot Postgres + Redis + MailHog

```sh
pnpm docker:up
```

That brings up:
- `postgres:16-alpine` on `:5432` (user `vibe`, db `vibe_tb`)
- `redis:7-alpine` on `:6379`
- `mailhog/mailhog` on `:1025` (SMTP) and `:8025` (web UI)

Confirm with `docker compose -f ops/docker/docker-compose.dev.yml ps`.

## 2. Migrate + seed

```sh
pnpm db:migrate
pnpm db:seed
```

After `pnpm db:seed`:
- Firm: `Granite Peak CPAs`, 2 offices, 7 staff users (Sarah Chen, Mike Davis, Rachel Kim, Jenny Park, David Park, Linda Hayes, Tom Vance).
- 5 clients (Holland Manufacturing LLC, Vance Holdings Inc, Holland Family Trust, Vance Realty Partners, Polson Bakery).
- 4 service lines, 12 work codes, 8 engagement types, 7 reason codes.
- 3 portal identities — Tom Vance has access to 3 of the 5 clients (FULL / PAY_ONLY / VIEW_ONLY).
- **One engagement with the canonical Vance scenario** preloaded: 4 time entries totalling $3,950 WIP, an APPROVED billing batch, an APPLIED hierarchical-cascade $1,200 write-down. The realization report renders immediately.

## 3. Start everything

```sh
pnpm dev
```

This runs all four apps in parallel:
- API on `http://localhost:3001` (Express + tsx hot-reload)
- Worker (BullMQ; 4 scheduled queues registered: recurring-billing, ar-aging-snapshot, view-refresh, dunning-sweep)
- Staff app on `http://localhost:5173`
- Client portal on `http://localhost:5174`

The Vite dev proxy forwards `/api` and `/mcp` from each app to the API.

## 4. Staff login

Open `http://localhost:5173` and navigate to `/auth/login`.

1. Enter `[email protected]`. Hit **Send sign-in link**.
2. Open MailHog at `http://localhost:8025`. Click the latest email. Copy the magic-link URL.
3. Paste it into a new tab. Click **Continue**.
4. You're redirected to `/auth/totp` for first-time enrollment. Scan the QR with any TOTP app (or paste the secret), check the recovery codes box, enter the 6-digit code.
5. You land on the dashboard. The realization-by-timekeeper card already shows the Vance scenario: Sarah 0%, Mike 83.3%, Rachel & Jenny 100%.

> **Pre-loaded TOTP for the demo**: if you don't want to enroll, run `pnpm db:seed --no-totp` (currently a TODO toggle; for now, enroll once and reuse the device).

## 5. Log time

Click **Time** in the nav.

- Pick the engagement (`1120-S 2026 Tax Return` is the seeded one).
- Optionally pick a work code (e.g. `tax_prep`).
- Date defaults to today; hours default to 1.00.
- Description is plain text — if AI is wired (see §11), the **Suggest** button next to the description field calls `POST /api/staff/ai/suggest-description` and prefills a one-sentence draft.

Submit. The row appears in **My entries** with the rate snapshot captured. Running totals at the top update.

## 6. Open a billing batch

Click **Billing** in the nav. The seed already created an APPROVED batch; you can either review that one or create a new one:

- New batch: pick the engagement, choose period start / end, hit **Create**. The API pulls all unbilled time entries in that period into the batch, denormalizes `billing_batch_id` onto each entry.

Click the batch. You'll see:
- Per-entry rows with Include / Defer / Write-off radio pills.
- WIP aging card (0–30 / 31–60 / 61–90 / 90+) over the included amounts.
- Top-card totals that recompute as you toggle actions.

## 7. Create the cascade adjustment

On a DRAFT or IN_REVIEW batch, click **Create adjustment**. The dialog opens.

- Direction: Write-down
- Amount: `1200.00`
- Method: Time
- Allocation method: **Hierarchical cascade (junior held harmless)**
- Reason code: Scope creep

The per-timekeeper preview table updates live (debounced 300ms) as you change the amount or method:

| Timekeeper  | Role     | Standard WIP | Adjustment | After   | Realization |
|-------------|----------|--------------|------------|---------|-------------|
| Sarah Chen  | PARTNER  | $1,000       | -$1,000    | $0      | 0.0%        |
| Mike Davis  | MANAGER  | $1,200       | -$200      | $1,000  | 83.3%       |
| Rachel Kim  | SENIOR   | $750         | $0         | $750    | 100.0%      |
| Jenny Park  | STAFF    | $1,000       | $0         | $1,000  | 100.0%      |

That's the wedge.

Hit **Create adjustment**.

> **Step-up TOTP**: if your last TOTP verification was more than 30 minutes ago (Q4) the server returns 403 `step_up_required` and the dialog surfaces a clear message pointing you to Account → Two-factor. Re-verify, then retry.

The adjustment is persisted; allocations write per-(time_entry, app_user) row; audit log records the CREATE.

## 8. Generate the invoice

Back on the batch detail, when status is APPROVED you'll see a **Generate invoice** button. Click it.

- Invoice number auto-assigned `INV-2026-NNNNN`.
- Line item aggregates the INCLUDED entries net of the APPLIED $1,200 write-down.
- Status starts at DRAFT.

You're redirected to `/invoices`. Find the new row, click **Send** to flip it to SENT (timestamps `sent_at`). The **PDF** link opens the Puppeteer-rendered PDF in a new tab.

## 9. Client portal — pay the invoice

Open `http://localhost:5174` (the portal).

1. Sign in as `[email protected]` (or his phone `+13125550148` — the portal detects email vs phone automatically).
2. Email path: open MailHog, click the latest portal link.
3. Phone path: the API logs the OTP to stdout in dev (because there's no real SMS provider wired); copy it, paste into the portal.
4. The portal shell shows `Client: vance-h…` in the header. Tom has access to three clients — clicking the chip opens the entity switcher.
5. **Invoices** → click the open invoice. The first GET marks `first_viewed_at` and emits an audit row (Q30 — portal-view receipt, no tracking pixel).
6. Click **Pay $X,XXX.XX**. If `STRIPE_SECRET_KEY` is set, the API calls Stripe with the seeded test card. Otherwise it returns 402 `no_payment_provider_configured`.

Back on the staff `/invoices` page, the **Viewed in portal** column flips from "not yet" to today's date. The audit log under `/audit` shows the PAYMENT row with `actorPortalIdentityId` = Tom's UUID.

## 10. Reports drill-through

Click **Reports**. The dimension toggle at the top: `firm / timekeeper / engagement / client`.

- Firm view → three stat cards (Standard WIP / After adjustments / Realization).
- Timekeeper view → one row per staffer with the per-timekeeper realization.
- Engagement / Client views → same shape, scoped differently.

This is the same rollup as the dashboard, just configurable.

## 11. Optional integrations

### Stripe test mode

```sh
STRIPE_SECRET_KEY=sk_test_xxx pnpm dev
```

The portal pay button now actually charges Stripe's test account. Test card pm_card_visa is preloaded as the demo payment method; for a real demo, add a `payment_method` row in the DB or wire the saved-method UI.

### Anthropic AI

```sh
AI_CLOUD_API_KEY=sk-ant-xxx \
AI_CLOUD_MODEL=claude-opus-4-7 \
pnpm dev
```

Description suggestions and realization narratives now hit Claude. Cost is logged to `ai_request_log` per call; firm-level monthly budget (Q14) gates the request and returns 402 when exhausted.

### Local Ollama

```sh
AI_LOCAL_URL=http://localhost:11434 \
AI_LOCAL_MODEL=qwen3:8b-q4_K_M \
pnpm dev
```

`pickProvider` prefers local. Run `ollama pull qwen3:8b-q4_K_M` first.

### REST API / MCP

Generate a token via the admin endpoint:

```sh
curl -X POST http://localhost:3001/api/staff/admin/api-tokens \
  -H "Cookie: __vibe_app_session=$STAFF_COOKIE" \
  -H "X-CSRF-Token: $CSRF" \
  -d '{"name":"demo","allowedTools":["list_engagements","get_time_entries","create_time_entry"]}'
```

> Token-issuance UI is the next session's work. For now generate one directly:
> `pnpm exec tsx -e "console.log(crypto.randomBytes(32).toString('hex'))"` then insert into `mcp_token` with `tokenHash = sha256(token)`.

Then hit the REST or MCP surfaces:

```sh
curl http://localhost:3001/api/v1/engagements -H "Authorization: Bearer $TOKEN"
curl http://localhost:3001/mcp/tools -H "Authorization: Bearer $TOKEN"
curl -X POST http://localhost:3001/mcp/call \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tool":"list_engagements"}'
```

## 12. Production parity check

`GET http://localhost:3001/health/ready` reports the full wiring state:

```json
{
  "status": "ready",
  "checks": { "db": true, "redis": true },
  "wiring": {
    "stripe": false,
    "aiCloud": false,
    "aiLocal": false,
    "portalEnabled": true
  }
}
```

Flip the bools as you set environment variables. Surface this in your production monitoring dashboard.

## Troubleshooting

- **Magic-link doesn't arrive**: check MailHog at `http://localhost:8025`. The dev `sendMagicLink` no-ops if no SMTP is configured; check API stdout for the link URL.
- **TOTP says invalid**: ensure your device clock is in sync. The validation window is ±30 seconds.
- **Adjustment 403 step_up_required**: re-verify TOTP under Account → Two-factor; valid for 30 minutes per Q4.
- **Portal says 503 portal_disabled**: set `COMMERCIAL_LICENSE_TOKEN` in `.env` (any non-empty string). The license gate (CLAUDE.md non-negotiable #6) requires it.
- **Reports show no data**: the seed plants the Vance scenario; if you skipped seed, log time → create batch → cascade adjustment manually to populate.

## Where things live

| Surface | Path |
|---|---|
| Staff React UI | `apps/web/src/` |
| Portal React UI | `apps/portal/src/` |
| API HTTP layer | `apps/api/src/{auth,admin,clients,engagements,time-entries,billing-batches,adjustments,invoices,portal,reports,ar,approvals,audit,ai,mcp,rest-v1}/` |
| Worker scheduled jobs | `apps/worker/src/jobs/` |
| Domain logic (pure) | `packages/core/src/{auth,rbac,rates,billing,invoicing,payments,dunning,reporting,approvals,webhooks,mcp,ai,connect,adjustment-allocation}/` |
| Schema + migrations | `packages/db/src/schema/` + `packages/db/migrations/` |
| UI library | `packages/ui/src/` |

## What this demo does NOT cover yet

These exist as typed interfaces or skeleton implementations:

- Real SMS dispatch (TextLink/Twilio/SNS — the OTP shows in API stdout for now).
- Real email dispatch (Postmark/Resend/SES — MailHog is the dev mailer; production needs creds).
- CPACharge as a Stripe alternative.
- Approval-rule editor UI (rules engine works in code; admin UI is next).
- MCP token-issuance UI (DB row insert for now).
- Vibe Connect notification routing (HTTP client ready, no demo server).
- Puppeteer PDF runs in Docker prod; dev falls back to HTML.

None of these block the demo loop you just walked through.
