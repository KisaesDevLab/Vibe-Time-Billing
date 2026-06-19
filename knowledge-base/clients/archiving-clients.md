---
title: 'Archiving and legal holds'
slug: archiving-clients
category: clients
audience: staff
tags: ['clients', 'archive', 'legal hold', 'retention']
---

# Archiving & legal holds

Vibe never hard-deletes a client — archiving sets its status to **ARCHIVED** and the audit log records it; engagements, invoices, and history are preserved.

## How it works today

- Find archived clients by setting the **Status** filter to **Archived** on the Clients page.
- The archive path exposed in the staff app is the **Merge / dedup** tool on a client's **Engagements** tab: choose a source client, confirm, and the source is archived after its records re-point onto the target.
- Before any archive, the client's **legal-hold** flag is checked.

## Legal hold

When legal hold is active, archiving (and merge) is **refused with a 409** (`legal_hold_active`) — the Merge card notes "Refuses when either client is under legal hold." Use it to preserve records for litigation or audit.

## Tips

- Because archiving is a soft-delete, it's reversible at the data level (status back to ACTIVE); nothing is erased.
- A standalone "Archive client" button / legal-hold toggle may not be present on the client cards in your build — archiving happens via the merge flow (or by an admin via the API). Confirm with your firm admin.
