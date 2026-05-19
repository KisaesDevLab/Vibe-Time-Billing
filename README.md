# Vibe Time & Billing

**Self-hosted time tracking, recurring billing, and adjustment allocation for CPA firms.**

A Docker appliance you run on your own hardware. One annual license, unlimited users, unlimited clients, no per-seat pricing. Built for firms that want their data on their own infrastructure and want billing math that actually models how partner write-downs flow through to staff realization.

## What it does

- Track time across seven fee structures: hourly, hourly-NTE, fixed-fee, fixed-fee with milestones, recurring subscription, mixed-mode (retainer + overage), and hour bank with rollover
- Pre-bill, adjust, and invoice with six allocation methods — including a per-timekeeper grain so a partner's write-down on one engagement doesn't drag everyone's realization down equally
- Branded client portal with identity-based access (one person, multiple client entities, email-or-SMS login)
- Stripe and CPACharge payment processing — firm owns the merchant account
- Dimensional reporting cube (realization, utilization, profitability, recurring revenue)
- Local-first AI for description suggestions, scope creep detection, and plain-English query
- MCP server for AI agent integration (Claude Code, Cowork, third-party)

## What it isn't

Not a full practice-management suite. No workflow/task management, no CRM, no document management, no tax prep. Pair with the rest of the Vibe family if you need those:
- **Vibe Connect** — secure messaging and client document vault
- **Vibe MyBooks** — bookkeeping
- **Vibe Payroll Time** — kiosk time tracking
- **Vibe Trial Balance** — tax workpapers

## Stack

- TypeScript 5 · Node.js 20 · React 18 · Vite · Express · BullMQ
- PostgreSQL 16 · Redis 7 · Drizzle ORM · pnpm workspaces
- Caddy v2 · Puppeteer · Docker (multi-arch)
- Multi-provider AI: Anthropic Claude API, Ollama, OpenAI-compatible

## Deployment modes

1. **Domain mode** — public web access via Cloudflare Tunnel; `app.firm.com` + `portal.firm.com`. DNS configuration required.
2. **LAN mode** — appliance accessible on local network; portal accessible via Tailscale serve.
3. **Tailscale-only mode** — both staff and portal access gated through Tailscale.

## License

PolyForm Internal Use 1.0.0 for self-deployment within a single firm. Commercial license required to enable client portal access (separately licensed). See `LICENSE.md` for full terms.

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
