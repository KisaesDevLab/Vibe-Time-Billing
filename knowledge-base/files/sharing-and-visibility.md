---
title: 'Sharing files & visibility rules'
slug: sharing-and-visibility
category: files
audience: staff
tags: ['files', 'share', 'visibility', 'escrow']
---

# Sharing files & visibility rules

A client file is `private` by default until staff publish it. This article covers flipping file visibility (single and bulk), the firm-level default rules that pre-set visibility per subfolder, the escrow / pay-to-unlock flow that releases deliverables when an invoice is paid, the client-side share links, and how to resolve folder-binding conflicts.

## Steps

1. In a client's **Files** tab, click a file's **Visibility** pill to flip between `🔒 private` and `👁 visible` (`client_visible`).
2. To flip many at once, select files and use the bulk **Make client visible** / **Make private** actions in the toolbar.
3. To set firm-wide defaults, an admin opens the visibility-rules editor, adds rows of subfolder pattern → default visibility with a priority, and saves the pack.
4. To gate a deliverable behind payment, set a file's visibility to `escrow` and supply the gating invoice; it auto-promotes to `client_visible` when that invoice is paid.
5. A partner can force-release or re-gate an escrow file via the escrow-override action (requires a reason of at least 10 characters).
6. To resolve a folder-binding conflict, open **Storage conflict resolution** and choose `keep_current`, `reassign`, or `unbind_both`.

## Fields

- File visibility values: `private`, `client_visible`, `escrow`. Escrow requires a gating invoice.
- Firm rule: subfolder pattern, default visibility (`private` or `client_visible`), priority (0–1000), enabled, notes.
- Escrow override: target visibility (`escrow` or `client_visible`) plus a reason (10–500 chars).
- Conflict resolution: action (`keep_current` / `reassign` / `unbind_both`) plus a reason (≥10 chars for reassign/unbind).
- Client share link (portal-created): expiry in days, access level (`view` or `download`), optional note.

## What you'll see

- Publishing requires `storage:file:publish`; making a file private requires `storage:file:unpublish` (asymmetric — buttons disable with a tooltip naming the missing permission).
- When an invoice is paid, every `escrow` file tied to it flips to `client_visible`, gets a promoted timestamp, and the firm can notify the client. Refunding or voiding the invoice reverts those auto-promoted files back to `escrow`.
- The conflict screen shows the currently-bound client, the challenger, name-match scores, and a recommended action with rationale.

## Tips

- Every visibility change is recorded to the file's event history for the portal "first viewed" audit and compliance exports.
- Escrow override audit rows are tagged so manual releases are distinguishable from natural payment-driven flips.
- Share links are created by the **client** in their portal, not by staff; the raw token appears exactly once and the row stores only its SHA-256 hash. Clients revoke a share via the revoke action (idempotent).
- Manual `client_visible` files (no gating invoice) are never touched by the refund/void revert.
