# Build progress summary

**Refreshed:** 2026-06-03 (live re-audit against `main` @ `029d45f`)
**Supersedes:** the prior summary (2026-05-20) and `gap-analysis-v8.md` (2026-05-21), both
written ~186 commits ago and now stale on table counts, test totals, and module scope.

This file is the authoritative current status. The dated `gap-analysis-v1..v8.md` files remain
as a historical line-by-line baseline; `depth-pass-status.md` is the older phase-by-phase
accounting (also pre-v8 — read this file for current numbers).

---

## Headline

- **319 commits** on `main`; working tree **clean**.
- **`pnpm typecheck` ✅ clean** across all 10 packages.
- **`pnpm lint` ✅ clean** (only benign warnings: Node-engine mismatch in this dev env, and a
  "react not installed at workspace root" eslint notice).
- **1,414 tests passing, 7 skipped, across 158 test files** (see breakdown below).
- The three v8 working-tree blockers (WT-1 duplicate `drizzle-orm` → worker wouldn't compile;
  WT-2 unescaped quote in `TotpEnroll.tsx`; WT-3 uncommitted theme system) are **all resolved
  and committed**.
- No `STOPPED_BECAUSE.md` — the autonomous build never had to self-halt on a blocker.

> Dev-environment caveat: `.nvmrc` pins Node **24.4.0**; this audit ran on Node **22.22.2**.
> Typecheck/lint/tests pass regardless, but runtime use should be on Node 24.

---

## Codebase scale

| Metric | Count |
|---|---:|
| Drizzle tables (`pgTable`) | 147 |
| Migrations (`0000`–`0087`) | 88 |
| API top-level router domains | ~65 |
| BullMQ worker jobs | ~33 |
| Staff app (`web`) pages | 94 |
| Portal app pages | 33 |
| Test files | 158 |
| TS/TSX lines (apps + packages) | ~170K |

---

## Tests (verified this audit, pglite-backed — no external services required)

| Package | Passing | Skipped | Files |
|---|---:|---:|---:|
| `@vibe/core` | 416 | 1 | 40 |
| `@vibe/api` | 762 | 1 | 100 |
| `@vibe/storage` | 130 | 5 | 7 |
| `@vibe/worker` | 56 | 0 | 6 |
| `@vibe/web` | 20 | 0 | 1 |
| `@vibe/crypto` | 17 | 0 | 1 |
| `@vibe/db` | 13 | 0 | 3 |
| `@vibe/portal` | — | — | 0 (no unit files; covered by e2e) |
| **Total** | **1,414** | **7** | **158** |

Run with `pnpm -r test:unit`. The API suite's integration-style tests run against an in-process
WASM Postgres (pglite), so the whole set runs without Docker. The single Playwright e2e spec
(`apps/web` / `apps/portal`) is not counted here — it needs a browser.

---

## Status by phase (core BUILD_PLAN, 26 phases)

Per `gap-analysis-v8` the core plan was ~86% complete (~470 ✅ / 47 ⚠ / 28 ❌ of 545) as of
2026-05-21, and 186 commits have landed since. All 26 phases have domain logic + tests; the open
items are deferred UI polish and external-service wiring (see "What remains").

| Phase | Area | State |
|------:|------|------|
| 1 | Monorepo & infrastructure | Shippable |
| 2 | Database schema & migrations | Shippable (147 tables, immutability + allocation-sum triggers tested) |
| 3 | Staff auth & sessions | Shippable (magic-link + TOTP + passkey, CSRF, rate-limit, step-up) |
| 4 | Firm/office/user admin + RBAC | Walking (UIs present; some endpoints thin) |
| 5 | Taxonomy | Walking (UIs + endpoints; bulk import/export deferred) |
| 6 | Client management | Walking (merge/dedup + bulk import deferred) |
| 7 | Rate management + resolution | Walking (resolution tested; some CRUD UI deferred) |
| 8 | Engagements & fee structures | Walking |
| 9 | Time entry w/ rate snapshot | Walking (timer + grid/PWA partial) |
| 10 | Recurring billing | Walking (queues registered; some handler bodies thin) |
| 11 | Pre-bill / WIP / aging | Walking (mixed-mode composer deferred) |
| 12 | Adjustments (the wedge) | Shippable (6 methods × scenarios, per-timekeeper grain) |
| 13 | Invoicing | Walking (PDF render via Puppeteer pending) |
| 14 | Payments | Skeleton+ (Stripe tested w/ mock fetch; live client wiring pending) |
| 15 | AR aging & dunning | Walking (sender wiring pending) |
| 16 | Client portal | Walking (combined-input login, entity switcher, license gate) |
| 17 | Reporting / realization cube | Walking (drill-through partial) |
| 18 | Approval workflows | Walking (multi-step routing + metrics) |
| 19 | Audit log + viewer | Shippable (append-only at DB role level) |
| 20 | Admin UI | Walking |
| 21 | Webhooks / REST / email-in | Walking (webhook signing tested; REST v1 present; email-in stub) |
| 22 | MCP server | Skeleton (tool catalog + token claims; HTTP bind to `MCP_PORT` pending) |
| 23 | AI features | Interface (provider abstraction + budget tested; live clients pending) |
| 24 | Vibe Connect | Walking (routes implemented; depends on external Connect service) |
| 25 | Distribution / Docker | Walking (multi-stage Dockerfile, prod compose, Caddy templates, installer) |
| 26 | Polish / cross-realm QA | Walking (cross-realm isolation test passing; a11y/perf ongoing) |

---

## Addendum modules (built beyond the original 26-phase plan)

These shipped largely after the v8 audit and are the bulk of the 186 post-v8 commits:

- **Proposals** (`ADDENDUM-PROPOSAL-MODULE.md`) — services catalog, packages, terms templates,
  proposal CRUD, magic-link client flow, e-sign HMAC signatures, per-section view tracking,
  acceptance flow, pipeline/conversion dashboard, quick-bill, renewal engine.
- **Tax Returns** (`TAX_RETURN_BUILD_PLAN.md`) — ingestion + section schema, K-1 lexicon, staff
  list/detail/release UI, portal viewer, selective third-party shares, view-as-client impersonation.
- **Retainers** (`VIBE_TB_RETAINER_ADDENDUM_BUILD_PLAN.md`) — tier config, activation/exhaustion
  lifecycle + emails, portal offer/list/ledger, expiry sweeps, job metrics, feature-flag gates.
- **File Manager v2** (`FILE_MANAGER_ADDENDUM*.md`) — storage onboarding, Backblaze B2 S3-compat
  adapter (+ 3 presign/copy security fixes in the latest commit), firm + per-file visibility rules,
  escrow override, conflict resolution, portal file shares.
- **Auth hardening** — WebAuthn/passkey enrollment + passkey-as-primary sign-in with a 2FA factor
  picker (migration `0087`).
- **Cloudflare Tunnel** — in-app provisioning, sidecar, admin UI (migration `0085`).
- **Vibe Connect** integration, multi-engagement billing batches (migration `0086`).

---

## What remains (by design — not failure)

These need real credentials or external services and cannot be completed in a sandbox:

1. **Live payment clients** — Stripe + CPACharge HTTP impls behind the tested `PaymentProvider`
   interface (charge/refund/webhook logic already tested against a mocked `fetch`).
2. **Live AI providers** — Anthropic / Ollama / OpenAI-compatible behind the `AiProvider` interface.
3. **Email/SMS delivery** — SMTP / Postmark / Resend / SES and TextLink / Twilio / SNS senders
   (env-var contracts + no-op senders wired into the auth flow already).
4. **MCP HTTP server** — bind the typed tool catalog to `MCP_PORT`.

Plus finishing touches (not blockers): Puppeteer PDF templates for invoice/pre-bill/statement
render, remaining deferred React surfaces, and the a11y/perf polish pass.

Selected per-item ⚠/❌ punch list carried from v8 (still open): client merge/dedup tool;
CSV rate import; firm-default-rate-by-role config; per-engagement premium/discount multiplier;
mixed-mode invoice composer (retainer + overage on one invoice); automatic hour-bank debit on
time-entry write; plan-change proration commit path (preview dialog exists).

---

## Non-negotiables — enforced & verified

- **Audit-log immutability** — migration `0001` + DB-role `REVOKE UPDATE/DELETE`; schema invariant
  test; `emitAudit` enforces single-actor (staff XOR portal) in code.
- **Cross-realm session isolation** — distinct cookies/keys/sessions; `cross-realm-isolation` test passes.
- **Standard rate snapshot** — `time_entry.standard_rate_snapshot_cents` NOT NULL; historical
  reports don't shift when rates change (rate-resolution test).
- **Per-timekeeper allocation grain** — `adjustment_allocation` at `(adjustment, time_entry, app_user)`;
  6 methods × multiple scenarios incl. symmetric write-up and grain preservation, all passing.
- **Customer-owned external resources** — firm pastes its own Stripe keys; Caddy templates assume
  customer DNS; no platform account.
- **License gate on portal** — `portal-middleware` checks `COMMERCIAL_LICENSE_TOKEN` at request time;
  absent token → 503 `portal_disabled`.
- **PolyForm Small Business License 1.0.0** — SPDX header on source files.

---

## How to verify this status yourself

```bash
pnpm install          # 784 pkgs; native argon2 + bundled Chrome build on first run
pnpm typecheck        # all 10 packages clean
pnpm lint             # clean (benign warnings only)
pnpm -r test:unit     # 1,414 pass / 7 skip across 158 files (pglite — no Docker needed)
pnpm docker:up        # postgres 16 + redis 7 + mailhog, for full integration/e2e + running the app
```

## Next-session priorities

1. Wire live Stripe / CPACharge clients behind `PaymentProvider`.
2. Wire live Anthropic / Ollama / OpenAI clients behind `AiProvider`.
3. Add Puppeteer PDF templates + the render worker job.
4. Bind the MCP server to `MCP_PORT`.
5. Close the deferred UI surfaces (pre-bill review, adjustment cascade preview, invoice composer,
   portal invoice/payment pages, audit viewer) and run the a11y/perf polish pass.
