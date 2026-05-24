# Vibe Time & Billing — Connect Integration Addendum (v2, decisions locked)

**Status:** Pre-build addendum to `BUILD_PLAN.md`
**Adds:** 11 phases (A–K), 141 checklist items
**Inserts into:** TB's original 26-phase plan at specified seams
**Prerequisites:** Connect-side package extraction work (see §0)
**Revision:** v2 — all open questions from v1 §5 now locked; see §5 for the decisions log

---

## Purpose

This addendum extends `BUILD_PLAN.md` to fully integrate Vibe Connect's messaging, vault, document-request, and notification capabilities into Vibe Time & Billing — not as a link-out, but as first-class features inside the staff and portal UIs. The two products continue to ship as independent appliances; this addendum makes them share code through privately-published `@vibe/*` packages and lights up the integration features inside TB whenever a Connect entitlement is present in the firm's license.

This addendum also locks in two crypto-policy changes that diverge from Connect's original design:

1. **Firm-wide encryption key** instead of per-staff Argon2id-derived passphrases.
2. **No client-side decryption passphrase**; portal clients decrypt server-side via authenticated session.

These changes pivot Connect's security model from end-to-end encryption to **firm-managed envelope encryption at rest**. The implications are spelled out in §2 and must be reflected in Connect's README and threat model docs.

---

## Locked decisions reference

| ID   | Decision                     | Locked value                                                                |
| ---- | ---------------------------- | --------------------------------------------------------------------------- |
| D-01 | Integration shape            | Build-time, license-gated runtime toggle                                    |
| D-02 | Both products ship           | Yes, share `@vibe/*` packages                                               |
| D-03 | Database arrangement         | Shared Postgres, separate schemas (`vibetb`, `vibeconnect`)                 |
| D-04 | Encryption model             | Firm-managed envelope encryption at rest (not E2EE)                         |
| D-05 | Connect licensing            | Sold separately; TB lights up features when entitlement present             |
| D-06 | Schema ownership             | Drizzle schemas live in `@vibe/*` shared packages                           |
| Q1   | Appliance unlock mode        | Sealed-on-disk default; admin-passphrase as per-firm opt-in                 |
| Q2   | Time-entry message link cap  | Unlimited; paginate in pre-bill UI                                          |
| Q3   | Suggestion expiration        | Configurable per firm; default 7 days                                       |
| Q4   | Escrow zone staff visibility | Firm-configurable; default: any staff with engagement access                |
| Q5   | Step-up rate limit           | 5 attempts / 15 min → 30 min lockout                                        |
| Q6   | MCP egress policy            | Local-only default; per-firm API opt-in; **Vibe Shield required if API on** |
| Q7   | TB native portal-auth        | Replaced by `@vibe/portal-auth` (folded into Phase E)                       |

---

## §0. Prerequisites (Connect-side work)

This work must complete in `Vibe-Connect` before TB's autonomous build can pick up the integration phases. Tracked in a separate `CONNECT_EXTRACTION_PLAN.md` in the Connect repo; summarized here so this addendum is self-contained.

- [ ] Migrate Connect workspace from yarn to pnpm
- [ ] Migrate Connect data layer from Knex to Drizzle (preserve all schema; no behavior change)
- [ ] Bump Connect runtime from Node 20 to Node 24
- [ ] Refactor Connect's crypto: replace per-user Argon2id passphrase flow with `FirmKeyManager` (see §2)
- [ ] Extract `@vibe/messaging-server` package (message persistence, thread model, Socket.io gateway as Express middleware)
- [ ] Extract `@vibe/vault` package (file storage with staff-only/shared/escrow zones, promotion API)
- [ ] Extract `@vibe/notifications` package (Postmark, TextLink, Twilio behind provider interfaces)
- [ ] Extract `@vibe/portal-auth` package (magic-link + SSN/EIN step-up, identity-multiple-entity model)
- [ ] Extract `@vibe/ui-messaging` package (React components: ThreadView, MessageComposer, RequestPanel, FilePicker)
- [ ] Extend `@vibe/crypto` with `FirmKeyManager`, envelope helpers, and session key issuance API
- [ ] Update `@vibe/shared-types` with cross-app message, thread, and vault types
- [ ] Publish all `@vibe/*` packages to GHCR npm registry with semver pinning
- [ ] Update Connect README: replace "end-to-end encrypted" framing with "firm-managed envelope encryption at rest"
- [ ] Update Connect threat model doc to match new key model

---

## §1. Locked decisions for this addendum

1. **Build-time integration with license-gated runtime toggle.** TB always imports `@vibe/*` packages and ships with the messaging UI compiled in. If the firm's license payload lacks the `connect` entitlement, all messaging/vault/request features are hidden at the router level. Single artifact; no peer-discovery between appliances.
2. **Both products continue to ship as independent appliances.** Connect's own staff app and portal continue to exist for firms that license Connect alone. TB integration is additive, not replacive.
3. **Shared Postgres, separate schemas.** Both apps run against the shared Vibe Appliance Postgres instance. TB owns the `vibetb` schema; Connect-sourced tables live in `vibeconnect`. Cross-schema references use opaque UUID FKs, not Postgres-level foreign key constraints (avoids hard coupling).
4. **Firm-wide encryption key, sealed at rest.** No per-staff passphrase. No per-client passphrase. Default unlock mode is `sealed-on-disk` (unattended boot); `admin-passphrase` is available as a per-firm opt-in for security-conscious deployments. Details in §2.
5. **Connect license sold separately.** Pricing model unchanged: customer buys TB license and Connect license independently. TB lights up Connect features when the entitlement is present; absence is silent (no upsell prompts).
6. **Drizzle schemas live in the shared packages.** `@vibe/messaging-server`, `@vibe/vault`, etc. own their Drizzle schema definitions. TB imports and migrates them through TB's `@vibe/db` workspace.
7. **AI tools that read message content default to local-LLM egress only.** Firms can opt in to Anthropic API egress, but doing so requires a reachable `vibe-shield` appliance on the same Vibe Appliance host. If Shield is unreachable when egress is enabled, MCP tools that would egress deregister at startup with a warning banner shown to the firm admin.

---

## §2. Crypto model: firm-managed envelope encryption at rest

### What changes from Connect's original design

| Element                                      | Connect original                                        | This addendum                                                  |
| -------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| Per-user keypair                             | Yes, X25519, encrypted by Argon2id-stretched passphrase | **Removed**                                                    |
| Per-user passphrase                          | Yes                                                     | **Removed**                                                    |
| Master key                                   | None — keys are per-user                                | **Master Firm Key (MFK), one per firm**                        |
| Content encryption                           | XChaCha20-Poly1305 with per-recipient envelope          | **XChaCha20-Poly1305 with per-thread DEK, DEK wrapped by MFK** |
| Server can read content                      | No (true E2EE)                                          | **Yes (server decrypts on behalf of authenticated session)**   |
| Client portal passphrase                     | Yes (separate from magic-link)                          | **Removed**                                                    |
| DB dump exposes plaintext                    | No                                                      | **No (still ciphertext)**                                      |
| Compromised live appliance exposes plaintext | No (per-user keys on devices)                           | **Yes (MFK in appliance memory)**                              |
| Server-side AI features can read content     | No                                                      | **Yes** ← enables TB's advertised AI surface                   |

### Hierarchy

```
                Appliance unlock secret  (sealed-on-disk default; admin passphrase if opted in)
                          │
                          ▼  (Argon2id KEK derivation only in passphrase mode)
                       KEK (32 bytes)
                          │
                          ▼  (XChaCha20-Poly1305 unwrap)
              Master Firm Key — MFK (32 bytes, one per firm)
                          │
                          ▼  (XChaCha20-Poly1305 unwrap)
        Thread / Vault-Object Data Encryption Keys (T-DEKs)
                          │
                          ▼  (XChaCha20-Poly1305)
                   Message bodies, file blobs
```

### Appliance unlock modes

Both modes implemented; firm chooses at onboarding. Default is `sealed-on-disk`; firm admin can switch to `admin-passphrase` from the appliance settings (one-way migration ritual that re-seals the MFK).

- **`sealed-on-disk`** (default): The KEK that wraps the MFK is a random 32-byte key stored in `${DATA_DIR}/.firm-key.seal` with file mode `0400` owned by the appliance process user. Restart-survivable without operator interaction. Trust boundary: anyone with root on the host can recover the MFK. Suitable for firms that prioritize uptime and operational simplicity.

- **`admin-passphrase`** (opt-in): The KEK is derived from an admin-supplied passphrase via Argon2id (libsodium defaults). On appliance boot, the admin must POST the passphrase to `/admin/unlock` before any encrypted resource becomes accessible. Until unlocked, the app serves a 503 with a clear message. Trust boundary: someone with host root cannot recover the MFK without the passphrase. **Lost passphrase = unrecoverable data.** Documented prominently in the migration UI.

### Session model

- Staff: standard session cookie (HTTP-only, SameSite=Lax, Secure). After auth, server holds MFK in memory and decrypts on behalf of the session. **No key material crosses the wire.**
- Portal clients: magic-link auth from `@vibe/portal-auth`. After auth, same server-side decryption model. **No client-side passphrase. Ever.** Step-up auth (SSN/EIN challenge) is used for sensitive actions (payment method changes, large refunds) but does not gate decryption.

### Key rotation

- **MFK rotation:** Operator-triggered. A background job re-wraps every T-DEK in the database with the new MFK. Tractable because T-DEKs are small and few (one per thread + one per vault object). Schedule: annually or on suspected compromise.
- **T-DEK rotation:** Not routine. Operator-triggered per-thread on suspected thread compromise. Requires re-encrypting all messages in the thread.

### Positioning implications

The Connect README's "end-to-end encrypted" language is **no longer accurate** with this model. Connect-side docs need to be updated. Suggested replacement framing: _"Messages and files are encrypted at rest with a firm-managed key. The appliance decrypts content for authenticated users over TLS. The threat model protects against external compromise of the database, backups, and disk; it explicitly does not protect content from the firm operating the appliance."_

This is a legitimate and common model for self-hosted business software (analogous to AWS S3 SSE-KMS or GCP CMEK). It is **not** what most users mean when they hear "E2EE." Calling it E2EE would be misleading.

---

## §3. Suggested insertion order vs original TB phases

The phases below are designated A–K to keep them visually distinct from TB's existing Phases 1–26. Recommended insertion points in the original plan:

| Addendum phase                          | Insert relative to original TB phase                                 |
| --------------------------------------- | -------------------------------------------------------------------- |
| A — Crypto & key management             | Before Phase 1 (foundation; affects all subsequent persistence work) |
| B — Schema reconciliation               | Inside Phase 2 (DB setup)                                            |
| C — Engagement-thread provisioning      | After Phase 5 (engagements)                                          |
| D — Time-entry ↔ message linking        | Inside Phase 7 (time entry)                                          |
| E — Unified portal                      | Replaces TB's standalone portal phase (re-scope, not add)            |
| F — Pay-to-unlock Vault                 | Inside Phase 16 (payment processing)                                 |
| G — Client requests → time entry        | Inside Phase 7 (time entry, late)                                    |
| H — Notification provider reuse         | Inside Phase 18 (notifications)                                      |
| I — Step-up auth on financial actions   | Inside Phase 16 (payment processing, late)                           |
| J — MCP tool surface for integration    | Inside TB's MCP server phase                                         |
| K — Product positioning & documentation | End of plan, before release gate                                     |

---

## Phase A — Crypto & key management

**Goal:** Stand up the firm-keyed envelope encryption foundation that all subsequent persistence relies on.

- [ ] A.1 Add `@vibe/crypto` dep to TB workspace; import `FirmKeyManager`, `EnvelopeCodec`, `SessionKeyContext`
- [ ] A.2 Implement `FirmKeyManager.bootstrap()` — generates 32-byte MFK on first run, wraps with KEK, writes to `${DATA_DIR}/.firm-key.seal`, persists wrapped MFK + KEK metadata in `vibetb.firm_key_envelope` table
- [ ] A.3 Implement firm-onboarding UI step that selects unlock mode: `sealed-on-disk` (default, pre-selected) or `admin-passphrase` (opt-in, requires passphrase entry + confirmation + understanding-of-irreversibility checkbox)
- [ ] A.4 Implement `FirmKeyManager.unseal()` — branches on `vibetb.firm_config.unlock_mode`; sealed-on-disk reads the on-disk KEK; admin-passphrase blocks on `/admin/unlock` POST; holds MFK in process memory only after success
- [ ] A.5 Implement `/admin/unlock` endpoint for passphrase mode; serves 503 with `{error: "appliance-locked"}` JSON on all routes until unsealed; rate-limit passphrase attempts (3 / 5 min before backoff)
- [ ] A.6 Implement unlock-mode migration: firm admin in sealed-on-disk mode can opt into admin-passphrase via Settings → Security; ritual re-seals the MFK with the new KEK; documented as one-way (migration back to sealed-on-disk requires destructive re-keying)
- [ ] A.7 Implement `EnvelopeCodec.encrypt(plaintext, tDek)` and `EnvelopeCodec.decrypt(ciphertext, tDek)` using XChaCha20-Poly1305 from libsodium
- [ ] A.8 Implement `FirmKeyManager.wrapTDek(plaintextKey)` and `unwrapTDek(wrappedKey)` — both call libsodium with MFK; both throw if MFK not loaded
- [ ] A.9 Implement `FirmKeyManager.rotateMFK(newMFK)` — re-wraps every row in `vibetb.firm_key_envelope` and every `wrapped_dek` column across schemas; runs as a single BullMQ job with checkpointing
- [ ] A.10 Add ops runbook `docs/ops/KEY_ROTATION.md` covering MFK rotation procedure, restore from backup, lost-passphrase recovery (explicit "data is unrecoverable in admin-passphrase mode" disclaimer)
- [ ] A.11 Add startup integrity check: verify MFK can unwrap a known sentinel ciphertext in `vibetb.firm_key_envelope` before declaring readiness on `/health`
- [ ] A.12 Unit tests: encrypt/decrypt round-trip, wrap/unwrap round-trip, rotation correctness, sealed-on-disk vs passphrase mode parity, 503 behavior when locked, unlock-mode migration ritual

---

## Phase B — Schema reconciliation

**Goal:** Cleanly model the shared-Postgres-separate-schemas arrangement and define how TB references Connect-sourced objects.

- [ ] B.1 Confirm Postgres bootstrap creates both `vibetb` and `vibeconnect` schemas if either app is installed; document in `docs/ops/POSTGRES_BOOTSTRAP.md`
- [ ] B.2 Run `@vibe/messaging-server`, `@vibe/vault`, and `@vibe/portal-auth` migrations from TB's `@vibe/db` workspace; ensure idempotency when Connect-the-app is also installed against the same DB
- [ ] B.3 Add `vibetb.engagement_thread_link` table: `(engagement_id UUID, thread_id UUID, created_at, archived_at)`; thread_id is an opaque reference to `vibeconnect.threads.id` with no FK
- [ ] B.4 Add `vibetb.time_entry_message_link` table: `(time_entry_id UUID, message_id UUID, sequence INT, created_at, created_by_user_id)`; `sequence` enables stable ordering in pre-bill rendering since the cap is unlimited
- [ ] B.5 Add `vibetb.invoice_vault_link` table: `(invoice_id UUID, vault_object_id UUID, current_zone TEXT, promoted_at NULL)`
- [ ] B.6 Add `vibetb.client_request_time_entry_link` table: `(request_id UUID, time_entry_id UUID, suggested_at, accepted_at NULL, dismissed_at NULL, expires_at)`
- [ ] B.7 Add `vibetb.firm_config` table for integration-specific config knobs (unlock_mode, escrow_visibility, suggestion_expiration_days, ai_egress_enabled, etc.)
- [ ] B.8 Document cross-schema query patterns and the deliberate absence of FKs in `docs/architecture/CROSS_SCHEMA.md`
- [ ] B.9 Implement Drizzle relations on TB side that join across schemas via the link tables, with TypeScript types imported from `@vibe/shared-types`
- [ ] B.10 Migration safety: every cross-schema query must tolerate the referenced object being absent (Connect disabled, license revoked, manual cleanup). Add a `safeLoad` helper that returns `null` instead of throwing on missing references.

---

## Phase C — Engagement-thread provisioning

**Goal:** Every TB engagement auto-provisions a Connect thread with the right staff roster and client contact.

- [ ] C.1 Wire engagement-created event in TB engagement service to call `messagingServer.createThread({ name, members, metadata: { engagementId } })`
- [ ] C.2 Insert link row in `vibetb.engagement_thread_link` after thread creation; persist within the same Drizzle transaction as the engagement record (using outbox pattern if thread creation is async)
- [ ] C.3 Implement member-sync: when staff are assigned to / removed from an engagement, mirror those changes on the linked thread via `messagingServer.addMember()` / `removeMember()`
- [ ] C.4 Implement primary-client-contact sync: thread's portal-side membership reflects the engagement's primary contact and any additional authorized contacts
- [ ] C.5 Engagement archive: when an engagement is archived in TB, archive the linked thread (`messagingServer.archiveThread()`); messages remain readable but no new posts are accepted
- [ ] C.6 Engagement deletion: hard-delete the thread and its messages; cascade via the link table
- [ ] C.7 Multi-entity client handling: one thread per engagement (not one thread per identity); link table FK is to the engagement, not the client
- [ ] C.8 UI: add "Messages" tab to TB engagement detail page; mount `<ThreadView />` from `@vibe/ui-messaging` with the linked `thread_id`
- [ ] C.9 Feature gate: if `license.entitlements.connect !== true`, the Messages tab is not rendered and event handlers are no-ops (but link table rows still preserved for license-reactivation scenarios)
- [ ] C.10 Integration test: create engagement → assert thread exists, members match, message round-trips, archive cascades, deletion cascades

---

## Phase D — Time-entry ↔ message linking

**Goal:** Time entries can reference one or more messages from the engagement thread (unlimited). Pre-bill review renders linked conversation as paginated context for write-down decisions.

- [ ] D.1 Add `linkedMessageIds: UUID[]` (no fixed cap) field to time-entry create/update DTOs in TB's API
- [ ] D.2 Persist links in `vibetb.time_entry_message_link` with sequence number from B.4; reject link creation if target message's thread isn't on the engagement
- [ ] D.3 Timer UI: add "Link conversation" affordance that opens a thread picker scoped to the current engagement's thread; recent messages shown chronologically; multi-select supported; selected messages show as chips above the time-entry form
- [ ] D.4 Pre-bill view: render the first 5 linked messages inline beneath each time entry; if more exist, render a "Show N more linked messages" pagination control that loads in batches of 10 via server-side pagination (no full-list materialization)
- [ ] D.5 Pre-bill aggregate panel: "Untracked client interactions" lists messages in the engagement thread during the billing period not linked to any time entry; itself paginated (50/page) since high-volume engagements can produce thousands
- [ ] D.6 Convert-to-time-entry shortcut: from the untracked panel, partner clicks → creates time entry with the message auto-linked and description pre-populated from message body
- [ ] D.7 Realization-defense PDF export: time-entry-detail export includes linked message bodies as appendix; for high-link-count entries, appendix paginates with table-of-contents anchors; firm-only document, never sent to client
- [ ] D.8 Permission check: only users who are members of the engagement thread can create links to its messages
- [ ] D.9 Audit log: every link create/delete recorded in `vibetb.audit_log` with actor, time-entry-id, message-id
- [ ] D.10 Performance: index `(time_entry_id, sequence)` on link table; cap pre-bill rendering query depth via `LIMIT/OFFSET` not in-memory slicing
- [ ] D.11 Feature gate behavior when Connect entitlement is absent: linkedMessageIds field accepted by API but always empty in responses; pre-bill panels hidden

---

## Phase E — Unified portal

**Goal:** Replace TB's standalone client portal with a unified portal that combines Invoices, Messages, and Vault under a single magic-link auth flow.

This phase **replaces** TB's original portal phase rather than adding to it. Re-scope, not addition.

- [ ] E.1 Adopt `@vibe/portal-auth` as the sole auth provider for `@vibe/portal`; remove TB's planned native magic-link implementation (this resolves Q7 from v1 inline)
- [ ] E.2 Implement portal app shell with three top-level tabs: Invoices, Messages, Vault; tab visibility driven by license entitlement (Messages and Vault hidden if no Connect entitlement)
- [ ] E.3 Identity-multiple-entity navigation: top-bar entity switcher driven by `portalAuth.getEntitiesForIdentity()`; tab content scopes to selected entity
- [ ] E.4 Invoices tab: TB's existing invoice-view, statement-view, and payment surfaces; no changes to billing logic, only host inside the unified shell
- [ ] E.5 Messages tab: mount `<PortalThreadView />` from `@vibe/ui-messaging`; lists all threads the client identity is a member of, scoped to selected entity
- [ ] E.6 Vault tab: mount `<PortalVaultBrowser />` from `@vibe/ui-messaging`; lists files in Shared zone for the entity's engagements, plus any pending requests
- [ ] E.7 Step-up auth integration: payment method changes, ACH authorization, large refund acceptance trigger SSN/EIN challenge via `portalAuth.requireStepUp()`; integrate at the action handler level, not the route level
- [ ] E.8 No-passphrase confirmation: portal session decrypts content server-side; client never sees, enters, or stores any encryption material. Verify by browser-side audit: no IndexedDB writes from `@vibe/crypto` in portal context
- [ ] E.9 Branding: TB's existing portal branding config (firm logo, color scheme, custom domain) applies to the unified shell
- [ ] E.10 Domain routing: `portal.firm.com` (Domain mode) and Tailscale serve URL (Tailscale modes) both route to the unified portal app; document in `docs/ops/PORTAL_DEPLOYMENT.md`
- [ ] E.11 Session timeout policy: shared across tabs; configurable per firm via `@vibe/portal-auth` settings
- [ ] E.12 E2E test: client logs in via magic-link → sees three tabs → views invoice → reads message → downloads Shared-zone file → pays an invoice → ACH change triggers step-up → step-up completes → no passphrase prompts anywhere in the flow

---

## Phase F — Pay-to-unlock Vault

**Goal:** Implement the "pay-to-unlock deliverables" feature from TB's roadmap using Connect's Vault zones.

- [ ] F.1 Add `vibetb.firm_config.escrow_visibility` enum column: `'engagement-access'` (default) | `'partner-and-assigned-only'`; firm admin toggles in Settings → Vault
- [ ] F.2 Add `escrow` zone to `@vibe/vault` schema: visibility query driven by `escrow_visibility` config; never visible to portal clients regardless of mode
- [ ] F.3 When a TB engagement deliverable is uploaded with `payToUnlock: true`, store it in `@vibe/vault` under zone `escrow`; link in `vibetb.invoice_vault_link` with `current_zone = 'escrow'`
- [ ] F.4 On invoice paid event (Stripe webhook, CPACharge webhook, or manual mark-paid), enqueue BullMQ job `vault.promote-on-payment` with `{invoice_id}`
- [ ] F.5 Promotion job: looks up linked vault objects via `vibetb.invoice_vault_link`, calls `vault.promote(object_id, 'shared')`, updates `current_zone` and `promoted_at` columns
- [ ] F.6 Promotion job is idempotent: if object already in `shared`, no-op; if invoice has been voided/refunded since payment, revert to `escrow`
- [ ] F.7 Admin override: TB staff with `billing:override` permission can manually promote (or demote) without payment via a UI action; logged in audit trail with required justification text
- [ ] F.8 Partial-payment policy: deliverable promotes only when invoice balance reaches zero. If partial payment is allowed by firm policy, deliverable stays in escrow until balance is fully paid
- [ ] F.9 Portal UX: when a client opens a pending deliverable, show "Payment required to unlock — pay invoice INV-1234 to access" with deep link to invoice
- [ ] F.10 Notification: on promotion, send `deliverable-unlocked` notification via `@vibe/notifications` to portal client
- [ ] F.11 Audit log: every zone transition (escrow → shared, shared → escrow on refund, admin override) recorded with actor, object_id, invoice_id, old_zone, new_zone, reason

---

## Phase G — Client requests → time entry suggestions

**Goal:** When a Connect client request is fulfilled, surface a "log time for this?" suggestion in the timer. Expiration window configurable per firm.

- [ ] G.1 Subscribe to `request.fulfilled` event from `@vibe/messaging-server` in TB's time-entry service
- [ ] G.2 On fulfilled event, insert a `vibetb.client_request_time_entry_link` row with `suggested_at = now()`, `expires_at = now() + firm_config.suggestion_expiration_days`, no `time_entry_id` yet
- [ ] G.3 Add `vibetb.firm_config.suggestion_expiration_days` column with default 7; firm admin configures in Settings → Billing → Time Capture
- [ ] G.4 Timer UI: "Suggested entries" section shows pending suggestions for the active staff member's engagements where `expires_at > now() AND dismissed_at IS NULL AND accepted_at IS NULL`; each suggestion shows request title, fulfillment timestamp, days-until-expiration, and one-click "Log time" CTA
- [ ] G.5 One-click conversion: opens timer pre-populated with description ("Completed request: {request.title}"), engagement set, time-entry-link to request established on save
- [ ] G.6 Dismiss action: staff can dismiss a suggestion without logging time; `dismissed_at` recorded
- [ ] G.7 Expiration sweep: BullMQ scheduled job runs hourly, marks suggestions past `expires_at` as `dismissed_at = expires_at, dismissed_reason = 'expired'`
- [ ] G.8 Request-side surfacing: in Connect's request view (rendered inside TB engagement page when entitlement present), show "Linked time entry: 1.2 hrs, logged by Kurt" as confirmation
- [ ] G.9 Reporting: new dimensional measure on the reporting cube — `client_request_billable_capture_rate = linked_time_entries / fulfilled_requests`
- [ ] G.10 Feature gate: G.\* phases all no-op when Connect entitlement absent
- [ ] G.11 Integration test: create request → mark fulfilled → assert suggestion appears with correct expires_at → accept → assert time entry created and linked → assert reporting cube updates; also test expiration sweep

---

## Phase H — Notification provider reuse

**Goal:** TB-side billing notifications (overdue, threshold, payment received) route through `@vibe/notifications` instead of a parallel TB notification system.

- [ ] H.1 Replace any planned TB-native email/SMS plumbing with `@vibe/notifications` adapter; configure providers via shared appliance config
- [ ] H.2 Register TB-specific notification templates: `invoice-sent`, `invoice-overdue-tier-1`, `invoice-overdue-tier-2`, `invoice-overdue-tier-3`, `payment-received`, `wip-threshold-exceeded`, `recurring-invoice-generated`, `deliverable-unlocked`
- [ ] H.3 Template registration includes channel preference (email, SMS, or both), priority, and per-firm override capability
- [ ] H.4 Notification preference UI: portal clients can opt in/out of SMS notifications; staff can opt in/out of WIP-threshold alerts in user settings
- [ ] H.5 SMS opt-in language complies with TCPA — explicit consent capture, persisted with timestamp and consent text version
- [ ] H.6 Dunning sequence engine schedules tier-1/2/3 reminders via BullMQ delayed jobs; cancellable on payment
- [ ] H.7 Provider failure handling: `@vibe/notifications` already implements fallback (TextLink → Twilio); TB uses default fallback chain
- [ ] H.8 Notification audit log: every send recorded with template, recipient identity, channel, provider, delivery status (received from provider webhook)
- [ ] H.9 Test mode: dev/staging notifications routed to a mock provider; no real sends. Production gate via env var
- [ ] H.10 Feature gate: when Connect entitlement absent, only email channel is available (the `@vibe/notifications` package's Postmark provider works standalone; SMS providers depend on Connect's broader provider config UI)

---

## Phase I — Step-up auth on financial actions

**Goal:** High-risk financial actions in TB require step-up auth via `@vibe/portal-auth`. Rate limit locked at 5 attempts / 15 min → 30 min lockout.

- [ ] I.1 Define gated action set in `vibetb.config`: `refund.process`, `write_off.apply` (above configurable dollar threshold), `payment_method.change`, `invoice.void`, `credit_memo.apply` (above configurable dollar threshold)
- [ ] I.2 For each gated action, server-side handler calls `portalAuth.requireStepUp(sessionId)` before executing; on failure returns 403 with `{error: "step-up-required", challengeUrl}`
- [ ] I.3 Frontend handler catches `step-up-required` response and opens the challenge modal; on success retries the original action
- [ ] I.4 Step-up challenge type per firm config: `ssn-last-4`, `ein`, or `email-otp` (the last is the fallback when neither SSN nor EIN is on file for the entity)
- [ ] I.5 Audit log: every step-up challenge (success or fail) recorded with actor, action, challenge type, outcome, IP, user agent
- [ ] I.6 Rate limiting: after **5 failed step-up attempts within 15 minutes**, lock further attempts for **30 minutes**; alert firm admin via `@vibe/notifications` on lockout
- [ ] I.7 Lockout state stored in Redis with TTL matching the 30-minute window; survives appliance restart (Redis persistence configured)
- [ ] I.8 Configurable thresholds UI: firm admin sets dollar threshold for `write_off.apply` and `credit_memo.apply`; default $500
- [ ] I.9 Staff-side step-up: same package, same flow, different challenge factors (TOTP or email-OTP since staff don't have SSN/EIN registered); same 5/15/30 rate limit
- [ ] I.10 Bypass mode for sandbox/test environments via env var; **must be impossible to enable in production builds** (compile-time check)
- [ ] I.11 E2E test: portal client attempts refund → step-up modal opens → enters wrong SSN 5x → 6th attempt blocked with 30-min countdown → wait → succeeds; staff member attempts write-off above threshold → TOTP prompt → success

---

## Phase J — MCP tool surface for Connect integration

**Goal:** TB's MCP server exposes tools that read and act on the integrated Connect surface, enabling Claude Code, Cowork, and third-party agents to reason about engagements holistically. AI egress defaults to local-LLM only; Anthropic API egress is opt-in and requires Vibe Shield in the path.

- [ ] J.1 Add MCP tool `summarize_engagement_thread(engagement_id: UUID, since?: ISODate) → text`: returns a structured summary of the linked thread's messages; uses TB's configured multi-provider AI; respects egress policy
- [ ] J.2 Add MCP tool `list_unresolved_client_requests(engagement_id?: UUID) → Request[]`: returns pending requests with age, last activity, and assigned staff
- [ ] J.3 Add MCP tool `link_message_to_time_entry(time_entry_id: UUID, message_id: UUID) → boolean`: programmatic link creation; same permission checks as the UI path
- [ ] J.4 Add MCP tool `suggest_billable_messages(engagement_id: UUID, period: ISODateRange) → Message[]`: returns messages in the period not linked to any time entry, with an AI-generated "billable likelihood" score
- [ ] J.5 Add MCP tool `draft_pre_bill_narrative(invoice_id: UUID) → text`: generates a client-facing narrative based on time entries and linked messages
- [ ] J.6 Permission boundary: every MCP tool requires a TB session token; tools inherit the calling session's RBAC; cross-engagement reads require explicit `engagement:read:any` permission
- [ ] J.7 Add `vibetb.firm_config.ai_egress_enabled` boolean column, default `false`; firm admin opts in via Settings → AI; opt-in flow surfaces the implications and confirms Shield is installed
- [ ] J.8 Add `vibetb.firm_config.vibe_shield_endpoint` text column; populated automatically from Vibe Appliance manifest when Shield is installed on the same host; manual override available
- [ ] J.9 Egress routing: when `ai_egress_enabled = true`, tools that call Anthropic API route through the configured Shield endpoint (`POST {shield_endpoint}/v1/messages` with Anthropic-compatible payload); direct calls to `api.anthropic.com` are blocked at the AI-provider layer
- [ ] J.10 Shield availability check at startup: if `ai_egress_enabled = true`, ping `{shield_endpoint}/health`; on failure, deregister all egress-requiring tools from MCP server and surface a banner in the staff app admin view ("AI egress enabled but Vibe Shield is unreachable — API tools disabled until Shield is reachable")
- [ ] J.11 Shield availability re-check: BullMQ scheduled job runs every 5 minutes; on Shield becoming reachable, re-register tools; on Shield becoming unreachable, deregister
- [ ] J.12 Local-only tool routing: when `ai_egress_enabled = false`, all AI calls route to TB's configured local-LLM provider (Ollama / Qwen3-8B); if no local provider configured, the tool returns `{error: "ai-not-configured", remediation: "Configure a local model in Settings → AI or enable API egress"}`
- [ ] J.13 Audit log: every MCP tool call recorded with session, tool name, inputs (PII-redacted via `vibe-shield` policy if active), and result hash; egress destination (local vs shield) also recorded
- [ ] J.14 Tool schema documentation auto-generated to `docs/mcp/CONNECT_TOOLS.md`
- [ ] J.15 Feature gate: J.1–J.5 deregister from the MCP server at startup if Connect entitlement absent; J.7–J.12 still apply for non-Connect AI tools if any exist

---

## Phase K — Product positioning & documentation

**Goal:** Update product-facing and developer-facing docs to reflect the integration, the crypto-model pivot, and the Shield dependency for API egress.

- [ ] K.1 Update TB README: replace "Pair with Vibe Connect — secure messaging and client document vault" with description of integrated features (messaging, vault, requests) lighting up when Connect is licensed
- [ ] K.2 Update TB README "What it does" section: add "engagement-level secure messaging," "pay-to-unlock deliverables," "in-app document collection," "unified portal" as Connect-licensed capabilities
- [ ] K.3 Update Connect README: replace "end-to-end-encrypted" framing with "firm-managed envelope encryption at rest"; rewrite security blurb to match the actual threat model
- [ ] K.4 Update Connect threat model doc (`docs/THREAT_MODEL.md`): rewrite key-management section; explicitly enumerate what the model does and does not protect against; document sealed-on-disk vs admin-passphrase trust boundaries
- [ ] K.5 Update TB pricing page: Connect license remains separately purchased; document "what unlocks when Connect license added to TB" feature matrix
- [ ] K.6 Update Connect pricing page: clarify that TB integration features (engagement-thread provisioning, pay-to-unlock, request-driven time entries) require both licenses
- [ ] K.7 Update `LICENSE.md` in TB repo: portal access already gated by commercial license; clarify Connect features additionally gated by Connect entitlement
- [ ] K.8 Write `docs/architecture/CONNECT_INTEGRATION.md` — operator-facing doc explaining how the two products interact, how to enable/disable the integration, and how license entitlement is checked
- [ ] K.9 Write `docs/architecture/AI_EGRESS_POLICY.md` — explains local-only default, the opt-in flow, the Shield dependency, and what happens when Shield becomes unreachable
- [ ] K.10 Write `docs/ops/MIGRATION_FROM_STANDALONE.md` — for firms currently running Connect standalone who add TB later; covers data continuity, member sync backfill, and any one-time migration jobs
- [ ] K.11 Update `AUTONOMOUS_EXECUTION_PROMPT.md` to reference this addendum and instruct Claude Code to execute Phases A–K at their designated insertion points
- [ ] K.12 Update `QUESTIONS.md` to include the locked decisions table from this addendum (so it's discoverable alongside other TB architectural locks)

---

## §4. Out of scope

Explicitly **not** part of this addendum:

- True end-to-end encryption mode for Connect or TB. The crypto pivot in §2 is one-way; the per-user keypair flow is removed, not made optional.
- HSM / TPM integration for MFK sealing. Future work; current scope is software-only `sealed-on-disk` and `admin-passphrase` modes.
- Customer-managed encryption keys (BYOK). Not on the appliance roadmap.
- Migrating existing Connect customers' E2EE-encrypted message history to the new firm-keyed model. Connect-side work; covered in `CONNECT_EXTRACTION_PLAN.md` under a separate migration phase.
- Connect's Tauri desktop app integration with TB. Connect's desktop wrapper continues to wrap Connect's standalone staff app, not TB.
- Multi-firm tenancy on a single appliance. Vibe Appliance assumption is one firm per host; MFK is a single key per appliance install.
- Direct Anthropic API egress without Vibe Shield in the path. When egress is enabled, Shield is mandatory; bypass is not configurable.
- Per-tool egress overrides. Egress policy is firm-wide; a firm cannot enable Anthropic API for `summarize_engagement_thread` while keeping `draft_pre_bill_narrative` local-only.

---

## §5. Decisions log (locked)

All v1-open questions and their final values, for reference and for downstream consumption by `QUESTIONS.md`.

| ID  | Question                              | Decision                                                                                          |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Q1  | Default appliance unlock mode         | Sealed-on-disk default; admin-passphrase as per-firm opt-in (Phase A.3, A.6)                      |
| Q2  | Max messages linkable to a time entry | Unlimited; paginate in pre-bill UI (Phase B.4, D.4, D.5)                                          |
| Q3  | Suggestion expiration window          | Configurable per firm; default 7 days (Phase G.2, G.3)                                            |
| Q4  | Escrow zone staff visibility          | Firm-configurable; default: any staff with engagement access (Phase F.1, F.2)                     |
| Q5  | Step-up rate limit                    | 5 attempts / 15 min → 30 min lockout (Phase I.6, I.7, I.11)                                       |
| Q6  | MCP egress policy default             | Local-only default; per-firm API opt-in; **Vibe Shield required if API enabled** (Phase J.7–J.12) |
| Q7  | TB native portal-auth                 | Replaced by `@vibe/portal-auth`; folded into this addendum (Phase E.1)                            |

Insertion procedure: copy this table into TB's `QUESTIONS.md` as a new "Connect Integration Decisions" section.

---

## §6. References

- `BUILD_PLAN.md` (TB repo, current) — original 26-phase plan
- `AUTONOMOUS_EXECUTION_PROMPT.md` (TB repo) — autonomous build kickoff prompt
- `QUESTIONS.md` (TB repo) — locked architectural decisions (this addendum's §5 to be appended)
- `CONNECT_EXTRACTION_PLAN.md` (Connect repo, to be drafted) — prerequisite Connect-side work
- `Vibe-Shield` repo — local PII redaction / tokenization gateway, prerequisite for API egress mode (Phase J)
- Connect repo: https://github.com/KisaesDevLab/Vibe-Connect
- Vibe Appliance meta-installer docs — shared Postgres/Redis architecture and multi-app endpoint discovery
