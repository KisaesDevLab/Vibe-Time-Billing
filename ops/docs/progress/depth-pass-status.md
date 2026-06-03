# Depth-pass status — what is and isn't actually done

> **⚠ Stale (pre-v8).** This accounting predates ~186 commits and the proposals, tax-returns,
> retainers, file-manager-v2, connect, passkey, and cloudflare-tunnel modules. Its table count
> (45) and test totals (175) are out of date. See **`summary.md`** (refreshed 2026-06-03) for
> current numbers: 147 tables, 88 migrations, 1,414 tests passing across 158 files. Kept here as
> the historical depth-rating rubric and phase-by-phase baseline.

Honest accounting after the second pass. Each phase is rated on a 4-point scale:

- **Shippable** — UI works, API works, tests cover it, no external service required.
- **Walking** — backend works and is tested; UI exists for the core flows but admin tools or polish are thin.
- **Skeleton** — domain logic and tests exist; HTTP and/or UI surface is partial; production use needs more.
- **Interface** — typed surface only; concrete implementation needs external creds (Stripe, email, etc.).

| Phase | Area | State | Notes |
|---:|---|---|---|
| 1 | Repo & infrastructure | **Shippable** | All 4 apps build; UI library has 7 components; husky hook installed |
| 2 | Database schema & migrations | **Shippable** | 45 tables; pglite tests verify migrations apply, immutability triggers fire, allocation-sum trigger rejects mismatched commits |
| 3 | Staff auth & sessions | **Shippable** | Magic-link + TOTP + Redis sessions + CSRF + rate-limit + lockout + step-up; login/TOTP-enroll/account UIs |
| 4 | Firm/office/user admin | **Walking** | All API endpoints + Firm settings / Offices / Users admin UIs; role-assignment endpoint thin |
| 5 | Taxonomy | **Walking** | Service-lines/work-codes/reason-codes UIs + endpoints; bulk import/export deferred |
| 6 | Clients | **Walking** | API + list/search/create UI; client detail page, merge, bulk import deferred |
| 7 | Rate management | **Skeleton** | Resolution function tested end-to-end; rate CRUD UI deferred |
| 8 | Engagements & fee structures | **Skeleton** | API + schema for all fee structures; engagement create/list UI deferred |
| 9 | Time entry & capture | **Walking** | API enforces rate snapshot; staff UI has quick-entry form with running totals; timer/grid/PWA deferred |
| 10 | Recurring billing | **Skeleton** | 4 BullMQ queues registered with cron schedules; handler bodies stubbed with logs (need DB queries) |
| 11 | Pre-bill & WIP | **Skeleton** | API for create batch / finalize / view aging; review UI deferred |
| 12 | Adjustments — the wedge | **Walking** | All 6 allocation methods tested across 38 scenarios; API endpoint with step-up enforcement; per-timekeeper preview UI deferred |
| 13 | Invoicing | **Skeleton** | Numbering, totals, late fee, processing fee, HTML template all tested; PDF render endpoint + Puppeteer wiring deferred |
| 14 | Payments | **Skeleton+** | Stripe charge/refund/webhook-verify tested with mocked fetch; CPACharge interface only |
| 15 | AR aging & dunning | **Skeleton** | Schedule + bucketize tested; AR report UI + dunning sender deferred |
| 16 | Client portal | **Walking** | Combined-input login + entity switcher + license gate tested cross-realm; invoice/payment UI deferred |
| 17 | Reporting | **Walking** | Realization rollup API + dashboard UI (timekeeper dimension); drill-through + saved reports deferred |
| 18 | Approval workflows | **Skeleton** | Rule engine tested; queue UI + email/Slack notify deferred |
| 19 | Audit trail | **Walking** | Append-only at DB level (pglite tests); viewer endpoint exists; UI deferred |
| 20 | Administration UI | **Walking** | Covered as part of Phase 4 |
| 21 | Webhooks/REST/email-in | **Skeleton** | Webhook signing/verify tested; REST API + email-in worker deferred |
| 22 | MCP server | **Skeleton** | Tool catalog typed; HTTP server not yet bound to MCP_PORT |
| 23 | AI features | **Interface** | Provider interface + budget check tested; no provider impl yet |
| 24 | Vibe Connect | **Interface** | Typed client; no HTTP impl |
| 25 | Distribution | **Walking** | Dockerfile multi-stage; prod compose with Postgres/Redis/API/worker/Caddy/backup; entrypoint runs migrations at boot |
| 26 | Polish | **Skeleton** | Seed exists; perf/a11y/wizard/docs deferred |

## Test totals

- 13 schema invariants + migration runs against real WASM Postgres
- 134 core domain (1 deliberate skip — cascade reversal, non-bit-exact by design)
- 28 API integration (cross-realm isolation, RBAC, step-up enforcement, Stripe mock)
- **175 tests passing**

`pnpm typecheck`, `pnpm lint`, `pnpm prettier --check` all clean. All 4 apps (`web`, `portal`, `api`, `worker`) build to production bundles.

## What blocks "production-ready"

Every Skeleton-or-below phase needs one or more of:

1. **External service credentials** — Stripe/CPACharge, Anthropic/OpenAI/Ollama, TextLink/Twilio/SES/Postmark/Resend, Vibe Connect. These cannot be added in a sandboxed session.
2. **UI work** — pre-bill review, adjustment dialog with cascade preview, invoice composer, portal invoice/payment pages, AR aging report, audit log viewer, MCP token issuance, AI panels. Each is half a day to a day of focused React work.
3. **Worker job bodies** — recurring-billing scheduler, AR aging snapshot, MV refresh, dunning sweep. Domain functions exist; need DB query wiring + idempotency keys.
4. **Puppeteer PDF rendering** — Chromium is in the Dockerfile; the `apps/api/src/pdf/render.ts` adapter that turns invoice template HTML into PDF doesn't exist yet.

## Recommended next sessions

Each session should be scoped to land 2–3 phases at "Shippable" state. A reasonable order:

- **Session A:** Phase 11 + 12 + 17 — pre-bill review UI, adjustment dialog with cascade preview, reports drill-through. Closes out the differentiator end-to-end.
- **Session B:** Phase 13 + 14 + 16 — invoice composer, Puppeteer PDF render, portal invoice/payment UI, Stripe wired into a test-mode firm.
- **Session C:** Phase 15 + 18 + 19 — AR aging UI, approval queue, audit viewer.
- **Session D:** Phase 10 + 21 + 22 — worker job bodies, REST API + email-in, MCP server.
- **Session E:** Phase 23 + 24 + 25 + 26 — AI panels, Connect integration, deployment polish, demo seed.

Each session should start with `pnpm dev` + manual smoke and end with the new flow demoable on `http://localhost:5173`/`5174`.
