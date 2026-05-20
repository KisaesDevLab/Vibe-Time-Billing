# Build progress summary

## Status by phase

| Phase | Area | Status |
|------:|------|--------|
| 1 | Monorepo & infrastructure | Complete |
| 2 | Database schema & migrations | Complete |
| 3 | Staff auth & sessions | Complete |
| 4 | Firm/office/user admin + RBAC | Complete (UI deferred) |
| 5 | Taxonomy CRUD | Complete (UI deferred) |
| 6 | Client management | Complete (UI deferred) |
| 7 | Rate management + resolution | Complete |
| 8 | Engagements & fee structures | Complete (UI deferred) |
| 9 | Time entry with rate snapshot | Complete (UI deferred) |
| 10 | Recurring billing core | Domain done; worker job stubs |
| 11 | Pre-bill / WIP / aging | Domain done; UI deferred |
| 12 | Adjustments (the wedge) | Complete — 6 methods × scenarios |
| 13 | Invoicing (numbering, totals) | Domain done; PDF deferred |
| 14 | Payments (provider interface) | Interface complete; Stripe/CPACharge impls deferred |
| 15 | AR aging & dunning | Schedule done; senders deferred |
| 16 | Client portal auth realm | Complete |
| 17 | Reporting / realization rollups | Domain done; UI deferred |
| 18 | Approval rule engine | Complete |
| 19 | Audit log + viewer endpoint | Complete |
| 20 | Admin UI | Endpoints in Phase 4; React UI deferred |
| 21 | Webhooks signing | Complete; REST API deferred |
| 22 | MCP server catalog | Token claims done; HTTP server deferred |
| 23 | AI provider interface + budget | Complete; provider impls deferred |
| 24 | Vibe Connect | Interface done; HTTP impl deferred |
| 25 | Distribution / Docker | Dev compose, prod compose, entrypoint, Caddy templates |
| 26 | Polish / cross-realm QA | Cross-realm isolation test passing |

## Tests

```
schema invariants     8 passed
core domain         130 passed (1 skipped)
api integration      23 passed
total               161 passed (1 skipped)
```

`pnpm typecheck`, `pnpm lint`, `pnpm prettier --check` all clean.

## What's still UI work (deferred)

React surfaces in apps/web and apps/portal — the API and domain logic are all in place; the UIs can be built against documented endpoints.

## What's still wired-in-prod work (deferred)

- Stripe + CPACharge HTTP clients (interface ready).
- Anthropic + Ollama + OpenAI-compatible HTTP clients (interface ready).
- Vibe Connect HTTP client (interface ready).
- Email delivery providers SMTP/Postmark/Resend/SES (`MAIL_PROVIDER` env ready; senders wired into auth flow but currently no-op).
- SMS delivery providers TextLink/Twilio/SNS (same shape).
- Puppeteer PDF templates for invoices/pre-bills/statements/engagement letters.
- BullMQ scheduled jobs (worker boot ready, queues to be registered).
- MCP server process at port 3002 (`MCP_PORT` env defined; tool catalog ready).

## Non-negotiables enforced

- Audit log immutability (migration `0001`, schema invariant test, `emitAudit` enforces single-actor in code too).
- Cross-realm session isolation — verified by `cross-realm-isolation.test.ts`.
- Standard rate snapshot at time entry — `time_entry.standard_rate_snapshot_cents` NOT NULL; rate-resolution test asserts historical resolution doesn't shift on rate changes.
- Per-timekeeper allocation grain — `adjustment_allocation` test suite passes 38 tests covering all six methods × multiple scenarios; symmetric write-up and grain preservation verified.
- Customer-owned external resources — schema has `firm_settings` for firm-pasted Stripe keys; Caddy templates assume customer DNS.
- License gate on portal — `portal-middleware.ts` checks `COMMERCIAL_LICENSE_TOKEN` at request time; absent token returns 503 `portal_disabled`.
- PolyForm Internal Use 1.0.0 license header — all source files start with `// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0`.

## Next session priorities

1. Wire actual Stripe / CPACharge HTTP clients behind the `PaymentProvider` interface.
2. Wire Anthropic / Ollama / OpenAI HTTP clients behind the `AiProvider` interface.
3. Build the React staff and portal UIs against the established endpoints.
4. Add Puppeteer templates and the PDF generation worker job.
5. Wire BullMQ scheduled jobs (recurring billing, WIP aging refresh, dunning sequence).
