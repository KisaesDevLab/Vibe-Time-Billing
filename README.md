[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/I3D3227TTP)

# Vibe Practice Management

**Self-hosted practice management for CPA firms — time tracking, recurring billing, proposals, tax-return tracking, and a branded client portal.**

A Docker appliance you run on your own hardware. One annual license, unlimited users, unlimited clients, no per-seat pricing. Built for firms that want their data on their own infrastructure and want billing math that actually models how partner write-downs flow through to staff realization.

## What it does

- Track time across seven fee structures: hourly, hourly-NTE, fixed-fee, fixed-fee with milestones, recurring subscription, mixed-mode (retainer + overage), and hour bank with rollover
- Pre-bill, adjust, and invoice with six allocation methods — including a per-timekeeper grain so a partner's write-down on one engagement doesn't drag everyone's realization down equally
- **Engagement-level secure messaging** — encrypted at rest with a firm-managed key (XChaCha20-Poly1305 + per-thread DEK wrapped by the firm Master Key); decrypted server-side only for the authenticated session
- **Pay-to-unlock deliverables** — drop a file into a per-engagement `escrow` zone; it auto-promotes to client-visible the moment the gating invoice clears (Stripe webhook or manual `/payments/receive`); reverts on refund
- **In-app document collection** — client requests with one-click conversion into time-entry suggestions on the assigned staff member's timer
- **Unified branded client portal** — single magic-link auth, identity-based access (one person, multiple client entities, email-or-SMS login), four top-level tabs (Invoices · Messages · Requests · Files)
- Stripe and CPACharge payment processing — firm owns the merchant account
- Dimensional reporting cube (realization, utilization, profitability, recurring revenue)
- Local-first AI for description suggestions, scope creep detection, and plain-English query
- MCP server for AI agent integration (Claude Code, Cowork, third-party)

## Scope

Vibe PM covers the engagement-to-cash workflow: time tracking, billing & realization, adjustments, proposals, retainers, tax-return tracking, secure messaging, document collection, and the client portal. It is **not** a bookkeeping ledger, a payroll system, or a tax-prep engine — pair it with the rest of the Vibe family for those:
- **Vibe MyBooks** — bookkeeping
- **Vibe Payroll Time** — kiosk time tracking
- **Vibe Trial Balance** — tax workpapers
- **Vibe Shield** — local PII redaction gateway (required when opting AI features into cloud API egress; see `docs/architecture/AI_EGRESS_POLICY.md`)

(Messaging, document vault, and document requests — previously planned as standalone "Vibe Connect" features — are absorbed directly into Vibe Practice Management. See `docs/architecture/MESSAGING_VAULT.md`.)

## Stack

- TypeScript 5 · Node.js 24 · React 18 · Vite · Express · BullMQ
- PostgreSQL 16 · Redis 7 · Drizzle ORM · pnpm workspaces
- Caddy v2 · Puppeteer · Docker (multi-arch)
- Multi-provider AI: Anthropic Claude API, Ollama, OpenAI-compatible

## Deployment modes

1. **Domain mode** — public web access via Cloudflare Tunnel; `app.firm.com` + `portal.firm.com`. DNS configuration required.
2. **LAN mode** — appliance accessible on local network; portal accessible via Tailscale serve.
3. **Tailscale-only mode** — both staff and portal access gated through Tailscale.

## License

PolyForm Small Business License 1.0.0 — source-available. Companies with fewer than 100 total employees/contractors and under 1,000,000 USD (2019, inflation-adjusted) prior-year revenue may self-host, use, and modify the software freely; larger companies need a commercial license from Kisaes LLC. The client portal feature requires a separate commercial license token regardless of company size, and license-key functionality may not be circumvented. See `LICENSE.md` for full terms.

## Status

Pre-release. Built autonomously via Claude Code following the plan in `BUILD_PLAN.md`. Track progress in `git log --grep '^phase'`.

## For developers

Start here:
1. Read `CLAUDE.md` — autonomous build operating manual
2. Read `BUILD_PLAN.md` — 26 phases, ~513 items
3. Read `QUESTIONS.md` — locked architectural decisions

To resume the autonomous build, copy the prompt in `AUTONOMOUS_EXECUTION_PROMPT.md` into a fresh Claude Code session.

## Repository

`KisaesDevLab/Vibe-Time-Billing` — to be created at build kickoff.