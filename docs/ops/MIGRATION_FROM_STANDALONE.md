# Migration from Standalone Connect — Operator Guide

## Current state — this is a stub

**There are no Connect-standalone customers to migrate today.** This document exists so the procedure is captured ahead of need; it will be fleshed out the first time a real Connect-the-app installation needs to fold into TB.

If you arrived here because you have actual Connect data to migrate, **stop and contact the maintainer** — the procedure below is the architectural sketch, not a tested runbook.

## When this would apply

A future scenario where:

1. A firm has been running the original Vibe Connect appliance as a standalone product (messaging + vault, separate Postgres, separate Tauri desktop wrapper).
2. The firm later adopts TB.
3. The firm wants their existing message history + vault objects to appear inside TB's unified portal rather than starting fresh.

Today neither (1) nor (2) is a live concern — the Connect-style features inside TB were absorbed directly (see `docs/architecture/CONNECT_INTEGRATION.md`), and no production Connect deployments exist.

## Architectural sketch (for when this becomes real)

The Connect-original data model used:

- Per-user X25519 keypairs with passphrase-derived KEK (true E2EE)
- A `vibeconnect.*` Postgres schema
- Per-recipient envelope encryption (one wrapped DEK per recipient per message)

TB's absorbed model uses:

- Firm-managed Master Firm Key (MFK) wrapped by a firm-level KEK
- `vibetb.*` schema only
- Per-thread DEK wrapped by MFK; messages encrypted under the thread's DEK

The migration would have to:

1. **Re-key everything.** Decrypt each Connect message with the recipient's per-user key, then re-encrypt under a freshly-generated TB thread DEK that is then wrapped by the firm's MFK. This is a one-way operation; the original per-user keys can be discarded after the rewrap. The firm signs off that they understand the post-migration model is "firm-managed at rest" rather than "end-to-end encrypted."
2. **Recreate thread mapping.** Each Connect conversation maps to one TB `thread` row, linked to the corresponding TB engagement via `engagement_thread_link`. Direct messages without an engagement context need a placeholder engagement or get dropped.
3. **Backfill membership.** Connect's `conversation_participants` rows translate to TB's `thread_member` rows. Staff get `appUserId` set; portal identities get `portalIdentityId` set.
4. **Migrate vault objects.** Move Connect's `vault_object` blobs into TB's `files` table with the appropriate `visibility`. The `escrow` zone equivalent in Connect maps cleanly to `visibility='escrow'` + `invoice_id`.
5. **Migrate read receipts.** Connect's per-recipient delivery state translates to TB's `message_read_receipt` rows.
6. **Migrate attachments.** Connect's attachment-to-message link translates to TB's `message_attachment` join row.
7. **Backfill audit_log entries.** Connect's audit entries that relate to the migrated data get re-emitted into TB's `audit_log` with `action='IMPORT'` and the original timestamp preserved in the JSON body.

## What this migration would NOT preserve

- **End-to-end encryption.** Once content is re-keyed under the firm MFK, the threat model changes from "no one with server access can read content" to "the firm operating the appliance can read content for any authenticated user." Firms must consent in writing.
- **Per-user device fingerprints.** Connect's device-trust model isn't reused; portal identity device verification kicks in fresh on first portal login post-migration.
- **Connect's standalone staff app history.** Staff-side message threads viewed via Connect's Tauri wrapper become readable via TB's engagement detail Messages tab, but the Connect app itself is no longer the canonical surface.

## Why not write a runbook now

Three reasons:

1. **No customer to test against.** Writing a runbook without an actual dataset means it would be theoretical and probably wrong in detail.
2. **Schema drift risk.** Both products' schemas keep evolving. A frozen runbook would go stale; better to write it against the actual schemas at migration time.
3. **Different firms might want different policies.** Some would want to drop direct-message threads (no engagement context); others would want to preserve them. The policy decisions belong in a per-customer scope-of-work, not a generic doc.

## What is documented for the standalone TB case

- `docs/ops/SCHEMA_LAYOUT.md` — current `vibetb` schema layout, search_path setup, backup procedure
- `docs/ops/KEY_ROTATION.md` — operator procedure for rotating the MFK
- `docs/ops/restore.md` — full restore-from-backup procedure (predates this absorption)
- `docs/architecture/MESSAGING_VAULT.md` — current entity model + escrow state machine

Use those for day-to-day operations. Return to this doc only when a real Connect-standalone migration is on the table.
