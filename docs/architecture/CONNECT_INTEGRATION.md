# Connect Integration — Standalone Absorption

## What this doc is

`CONNECT_INTEGRATION_ADDENDUM.md` (at the repo root) was originally written to integrate a separate "Vibe Connect" appliance with TB through shared `@vibe/*` packages, two Postgres schemas, and a license entitlement gate. **TB ships standalone** — Connect-style features (engagement-level messaging, escrow files, document requests, unified portal) are absorbed directly into TB's own monorepo. There is no second appliance to install, no `vibeconnect` schema, no cross-product license check.

This doc explains the absorbed architecture so operators don't have to back-derive it from the addendum + migrations + scattered routers.

## What "Connect" means inside TB

Every feature the addendum describes lives inside this repo:

| Feature                             | Where it lives in TB                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| Engagement-level threads + messages | `apps/api/src/engagement-messaging/` + `apps/portal/src/pages/Messages.tsx`  |
| Document requests                   | `apps/api/src/requests/` + `apps/portal/src/pages/Requests.tsx`              |
| Escrow / pay-to-unlock files        | `files.visibility='escrow'` column + `apps/api/src/files/promote-on-paid.ts` |
| Unified portal (4 tabs)             | `apps/portal/src/App.tsx` (Invoices · Messages · Requests · Files)           |
| Envelope encryption at rest         | `packages/crypto/` + `apps/api/src/crypto/{manager,boot,store}.ts`           |
| Operator unlock surface             | `apps/api/src/admin/unlock.ts`                                               |

All of these compile into the single `vibe-time-billing:local` Docker image. There is no separate Connect process to run.

## What we did NOT inherit from the addendum

| Addendum item                                             | Why dropped                                                                                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vibeconnect` Postgres schema                             | We use a single `vibetb` schema (migration 0057). Operators don't have to worry about cross-schema coordination.                                                          |
| `@vibe/*` shared packages at runtime                      | Code was inlined into the TB monorepo rather than published to GHCR. Faster to ship; no version-skew between Connect and TB.                                              |
| License entitlement gate (`license.entitlements.connect`) | TB has no license gate (removed 2026-08-22); the portal and every Connect feature ship under PolyForm Small Business. Only the firm-level `portal_enabled` switch exists. |
| Peer discovery / appliance manifest                       | No second appliance exists; nothing to discover.                                                                                                                          |
| Connect's standalone staff app                            | TB's `apps/web` is the only staff app.                                                                                                                                    |
| Per-user Argon2id passphrases (E2EE)                      | Replaced by firm-managed envelope encryption at rest (Q34). See `docs/architecture/CRYPTO.md`.                                                                            |

The original addendum file is preserved at the repo root for traceability — it's the source spec, not a runtime concern.

## License gate

TB's portal has no license gate. The only switch is `firm_settings.portal_enabled`: when false, `/api/portal/*` routes return 503 `{error: 'portal_disabled', reason: 'firm_disabled'}` and the portal SPA renders a "portal unavailable" screen. The check sits in `apps/api/src/auth/portal-middleware.ts:portalAuthDeps`.

Messaging, escrow, and request features ride on portal access — when the portal is enabled, all four tabs are visible. There is no separate flag to disable them individually. (A firm can disable specific surfaces per-client via existing visibility rules in Files v2.)

## How to enable / disable the integration

- **Enable everything:** nothing to do — the portal is on by default.
- **Disable portal entirely:** set `firm_settings.portal_enabled = false` (Admin → Firm settings).
- **Disable AI egress:** `firm_config.ai_egress_enabled = false` (default). When true, all AI calls route through Vibe Shield (see `docs/architecture/AI_EGRESS_POLICY.md`).
- **Switch unlock mode:** `firm_config.unlock_mode = 'admin-passphrase'` (default `'sealed-on-disk'`). One-way switch via the admin UI (Stage P3 of the polish plan).

## Cross-references

- `docs/architecture/MESSAGING_VAULT.md` — entity diagram, lifecycle, escrow state machine
- `docs/architecture/CRYPTO.md` — three-tier key hierarchy, sentinel verification
- `docs/architecture/AI_EGRESS_POLICY.md` — Shield gate, opt-in flow
- `docs/ops/KEY_ROTATION.md` — MFK / KEK / passphrase rotation procedures
- `docs/ops/SCHEMA_LAYOUT.md` — why `vibetb`, search_path setup
- `docs/ops/MIGRATION_FROM_STANDALONE.md` — future path if a Connect-the-app deployment ever needs to fold into TB
- `CONNECT_INTEGRATION_ADDENDUM.md` (repo root) — original spec, kept for traceability
- `QUESTIONS.md` Section L (Q34–Q40) — locked decisions table

## Polish-pass status

The absorption shipped in five stages. Remaining items (test coverage, pre-bill UX, admin UI, portal step-up modal, MCP tools, reporting measure) are tracked in the active polish plan at `C:\Users\kwkcp\.claude\plans\image-9-we-velvet-shell.md`.
