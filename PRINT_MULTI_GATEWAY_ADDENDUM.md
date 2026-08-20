# Vibe Time & Billing — Multi-Gateway Printing Addendum

> **Addendum to:** `BUILD_PLAN.md` + the 0185–0188 print-gateway migrations
> **Addendum label:** Phases PGW-1 through PGW-5
> **Insertion point:** Any time after the current phase closes; PGW phases are sequential
> **Total checklist items:** ~58
> **Status:** DRAFT — decisions D-PGW-01…08 proposed, review before build

---

## Why

The appliance supports one Vibe Print gateway per firm: a single `{baseUrl, apiKey}`
blob encrypted on `firm_settings.print_gateway_config_encrypted` (migration 0185),
resolved by `resolvePrintGateway(db, firmId)` — `firmId` is the only key. Offices
exist one level down: `printer_assignment` (migration 0186) maps a gateway printer
(bare integer id, unique per firm) to an office, and dispatch already routes to the
client's office printer. That design assumes every location's printers are reachable
from one gateway over one network path.

Multi-location firms whose sites do NOT share a network path to the printers need
**one gateway per office**: each site runs its own Vibe Print gateway on its own LAN,
and the appliance picks the gateway _and_ the printer from the office context.

The structural obstacles:

1. Gateway config is a scalar blob keyed by firm — no identity, no office.
2. `gateway_printer_id` is an opaque integer meaningful only within one gateway;
   the unique index `(firm_id, gateway_printer_id)` makes printer id 1 collide
   across two gateways.
3. Bare integer printer references are scattered on `app_user.default_printer_id`,
   `signature_print_rule.printer_id`, `notification_template.printer_id`,
   `terminal_readers.printer_id`, `print_log.printer_id`, and BullMQ job payloads —
   none carries a gateway.

---

## Decisions Log (proposed)

| ID       | Decision                                                                                                                                                                                                                                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D-PGW-01 | New `print_gateway` table, one row per gateway: nullable `office_id` (null = firm-wide), exactly one `is_default = true` row per firm (partial unique index). Office → gateway resolution: office's gateway → firm default.                                                                                                                            |
| D-PGW-02 | **No SQL backfill of the legacy blob** (it is AES-encrypted; SQL can't read it). Instead, `resolvePrintGateway` treats the legacy `firm_settings` blob as the implicit firm-default gateway whenever the `print_gateway` table is empty. First save in the new Admin UI writes a real default-gateway row and clears the blob. Zero-downtime cutover.  |
| D-PGW-03 | `printer_assignment` gains `gateway_id uuid NOT NULL`; unique index moves from `(firm_id, gateway_printer_id)` to `(gateway_id, gateway_printer_id)`. Existing rows backfill to the default gateway at first Admin save (app-layer, same moment the blob migrates) — until then the legacy index still holds because only one implicit gateway exists. |
| D-PGW-04 | Printer references stay bare integers but every reference gains a **paired `gateway_id` column** (nullable = "default gateway") rather than converting to `printer_assignment.id` surrogate FKs. Smaller blast radius; assignments remain a routing overlay, not identity.                                                                             |
| D-PGW-05 | Dispatch resolution order (per print): explicit `{gatewayId, printerId}` on the call → office's gateway + office printer → firm default gateway + its `default_printer_id`. The existing `resolveOfficePrinter` / `resolvePreselectPrinter` chain is preserved, just gateway-aware.                                                                    |
| D-PGW-06 | BullMQ print jobs and `print_log` rows carry `gateway_id`. A job enqueued for a gateway that has since been deleted fails that job with a logged `gateway_missing` error — no silent fallback to another site's printer.                                                                                                                               |
| D-PGW-07 | Env fallback `PRINT_GATEWAY_BASE_URL` / `PRINT_GATEWAY_API_KEY` remains supported and is treated as the firm-default gateway of last resort (lowest precedence). Documented as single-gateway-only.                                                                                                                                                    |
| D-PGW-08 | Fix in passing: `resolveOfficePrinter` / `resolvePreselectPrinter` select the office printer with `.limit(1)` and no `orderBy` — nondeterministic when an office has 2+ printers. Add `orderBy(createdAt)` plus an optional `is_office_default` flag on `printer_assignment`.                                                                          |

---

## Phase PGW-1 — Schema & gateway resolution

**Purpose:** Introduce gateway identity without breaking the running single-gateway
appliance for even one request.

### Database (migration 0218_print_multi_gateway.sql)

- [ ] `print_gateway` table: `id`, `firm_id` FK, `office_id` nullable FK (`ON DELETE SET NULL`), `name` text, `base_url` text, `api_key_encrypted` text, `enabled` boolean default true, `is_default` boolean default false, `default_printer_id` integer nullable, `auto_print_signature_confirmation` boolean default false, timestamps
- [ ] Partial unique index: one `is_default = true` per firm; index on `(firm_id, office_id)`
- [ ] `printer_assignment`: add `gateway_id uuid REFERENCES print_gateway(id) ON DELETE CASCADE` (nullable during transition), add `is_office_default boolean NOT NULL DEFAULT false`
- [ ] New unique index `(gateway_id, gateway_printer_id)` WHERE `gateway_id IS NOT NULL` (legacy `(firm_id, gateway_printer_id)` index stays until PGW-3 cutover completes; dropped in a follow-up migration)
- [ ] `print_log`: add `gateway_id uuid` nullable (null = legacy/default)
- [ ] Paired gateway columns (all nullable = default gateway): `app_user.default_printer_gateway_id`, `signature_print_rule.gateway_id`, `notification_template.printer_gateway_id`, `terminal_readers.printer_gateway_id`
- [ ] Drizzle schema in `packages/db/src/schema/core.ts` mirrors all of the above

### Config & resolution (`apps/api/src/print-gateway/config.ts`, `assignments.ts`)

- [ ] `StoredPrintGatewayConfig` → `ResolvedGateway { id: string | 'legacy' | 'env', baseUrl, apiKey, enabled, defaultPrinterId, autoPrintSignatureConfirmation, officeId }`
- [ ] `resolvePrintGateway(db, firmId, opts?: { gatewayId?, officeId? })`: rows in `print_gateway` win (officeId → its gateway, else firm default); empty table → legacy `firm_settings` blob; blob absent → env pair (D-PGW-02, D-PGW-07)
- [ ] `listGateways(db, firmId)` helper for admin + pickers
- [ ] `resolveOfficePrinter` / `resolvePreselectPrinter` become gateway-aware: return `{gatewayId, printerId}`; deterministic pick — `is_office_default DESC, created_at ASC` (D-PGW-08)
- [ ] Unit tests: resolution precedence (explicit > office > default > legacy blob > env), determinism of office-printer pick, cross-office isolation

**Phase PGW-1 checklist count: 12**

---

## Phase PGW-2 — Dispatch surfaces

**Purpose:** Every print reaches the right site's gateway; nothing silently
crosses sites.

- [ ] `send.ts` `sendToPrinter` / `sendGatewayTemplate` accept `{gatewayId?, officeId?}` and resolve through PGW-1; write `gateway_id` to `print_log`
- [ ] `client.ts` unchanged (it already takes a resolved base URL + key) — verify no module-level config caching survives per-gateway use
- [ ] Queue payloads (`queue.ts`) carry `gatewayId`; workers (`signature-confirmation-print.ts`, `terminal-receipt-print.ts`) resolve by payload gateway, fail with `gateway_missing` if deleted (D-PGW-06)
- [ ] Thread office/gateway context through all dispatch call sites: notifications PRINT channel (`print-channel.ts` `client_office` mode), staged worker (`staged-notification-send.ts`), signature rules (`signature-print.ts`), mailing return-address printing (`mailing-print.ts`), route sheets, payment receipts, invoice/statement/AR PRINT triggers, Stripe webhook auto-print
- [ ] Terminal readers: reader's `printer_gateway_id` + `printer_id` pair used for receipt auto-print
- [ ] Integration tests: two mocked gateways, office-A job never hits gateway-B; deleted-gateway job fails visibly with a `print_log` error row

**Phase PGW-2 checklist count: 10** (call-site item expands to ~8 sub-edits)

---

## Phase PGW-3 — Admin API & UI

**Purpose:** Firms manage N gateways; saving migrates the legacy blob.

### API (`apps/api/src/admin/print-gateway-keys.ts` → CRUD)

- [ ] `GET /api/staff/admin/print-gateways` — list (keys masked), including a synthetic `legacy` row when the blob is still live
- [ ] `POST` / `PUT /:id` / `DELETE /:id` — CRUD; first save with legacy blob present: create default-gateway row from submitted values, backfill `printer_assignment.gateway_id` for all existing rows, clear the blob (D-PGW-02/03, transactional)
- [ ] `POST /:id/test` — per-gateway `GET /v1/printers` probe
- [ ] `DELETE` guard: refuse (409) while assignments, terminal readers, print rules, or notification templates still reference the gateway
- [ ] `/assignments` endpoints filter by + write `gateway_id`; office picker per gateway
- [ ] Step-up TOTP on key writes (matches current behavior); audit rows for every mutation

### UI (`apps/web/src/pages/admin/Printing.tsx`)

- [ ] Single form → gateway list (name, office, URL, status, default badge) + add/edit drawer with per-gateway Test button
- [ ] Assignments table gains a gateway column/filter; `is_office_default` toggle per row
- [ ] One-time migration banner while the legacy blob is live: "Save to upgrade to multi-gateway"

**Phase PGW-3 checklist count: 9**

---

## Phase PGW-4 — Pickers & printer references

**Purpose:** Everywhere a printer is chosen or remembered, the choice is
`(gateway, printer)`, not a bare integer.

- [ ] `print-gateway/routes.ts` `/printers`: fan out across enabled gateways (parallel, per-gateway timeout; a down site degrades, not blocks), merge annotated with `gatewayId` + office label
- [ ] `/me` preselect + `/default-printer`: store and return the pair (`app_user.default_printer_gateway_id`)
- [ ] `PrintButton.tsx`: option value becomes `gatewayId:printerId`; existing office `<optgroup>` grouping kept
- [ ] Signature print rules editor + `signature_print_rule.gateway_id`
- [ ] Notification-template printer picker + `notification_template.printer_gateway_id`
- [ ] Terminal reader printer binding UI + `terminal_readers.printer_gateway_id`
- [ ] Null `gateway_id` anywhere continues to mean "firm default" — no forced re-save of existing rules/preferences

**Phase PGW-4 checklist count: 7**

---

## Phase PGW-5 — Ops, docs & acceptance

- [ ] `ops/docs/print-gateway.md`: multi-site topology (one gateway per LAN), env-pair = single-gateway-only, worker reachability note now per site
- [ ] Follow-up migration: drop legacy `(firm_id, gateway_printer_id)` unique index; make `printer_assignment.gateway_id` NOT NULL once no legacy blob remains
- [ ] E2E smoke: firm with 2 offices/2 gateways — office-scoped notification prints to its own site; interactive picker shows both sites grouped; terminal receipt prints at the reader's site
- [ ] `pnpm typecheck && pnpm lint && pnpm test` clean; per-package vitest workers bounded (root OOM caveat)

**Phase PGW-5 checklist count: 4**

---

## Explicit non-goals (v1)

- Gateway-initiated pull/polling (dispatch stays push-over-HTTP; a site's gateway must be reachable from the appliance — Tailscale/VPN per site is the supported topology)
- Printer discovery sync/caching (pickers query live, as today)
- Per-engagement or per-client gateway overrides (office is the routing grain)
- Load balancing / failover between gateways at one office

## Sizing

~58 checklist items across 5 phases. PGW-1+2 are the risk core (schema + dispatch);
3–5 are mechanical. Rough effort: PGW-1: 1 session, PGW-2: 1–2 sessions,
PGW-3: 1 session, PGW-4: 1 session, PGW-5: half. The legacy-blob-as-implicit-gateway
fallback (D-PGW-02) means the appliance never needs a maintenance window.
