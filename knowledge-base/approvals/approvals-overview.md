---
title: 'Approvals & the approval queue'
slug: approvals-overview
category: approvals
audience: staff
tags: ['approvals', 'queue', 'workflow', 'multi-step']
---

# Approvals dashboard

The **Approvals** page is where designated approvers act on items that exceed firm-configured thresholds or rules — most commonly write-up/write-down adjustments over the firm's dollar threshold. Approvers can approve or reject, leave comments, and (where multi-step routing applies) advance an item to the next approver.

## Steps

1. Open **Approvals** from the staff navigation. The card is titled **Pending approvals (N)**.
2. Scan the table: **Type**, **Requested by**, **When**, **Entity**, and **Step**.
3. Click **Review** on a row to open the inline decision controls.
4. Optionally type into the **Optional comments** field.
5. Click **Approve** to approve, or **Reject** to reject. Click **Cancel** to back out.
6. The row leaves the pending list once decided; the table refreshes automatically.

## Fields

- **Type** — the entity under review, shown lower-cased (e.g. `adjustment`, `rate change`).
- **Requested by** — the staff member who submitted the item.
- **When** — when it was requested.
- **Entity** — the first 8 characters of the entity's ID.
- **Step** — for multi-step routing, a "current / total" pill (highlighted on the final step); single-step items show `—`.
- **Optional comments** — free text saved with the decision.

## What you'll see

- Entity types that can appear: `ADJUSTMENT`, `PRE_BILL`, `INVOICE`, `ENGAGEMENT_LETTER`, `RATE_CHANGE`.
- Adjustments over the firm's adjustment-approval threshold (default $1,000, firm-configurable) are created in `PENDING_APPROVAL` and routed to the client's partner-in-charge with a default 48-hour SLA. Final-step approval flips the adjustment to `APPLIED`; rejection flips it to `REJECTED`.
- Your queue shows items assigned to you plus any unassigned pending items.
- On a multi-step item, approving an intermediate step advances it to the next approver and it stays pending; only a final-step approval or any rejection closes it.

## Other things that land here

The Approvals page also hosts dedicated cards for **portal access requests** (clients asking to be let into the portal — see [[portal-access-requests]]) and **client notifications** (status-change messages awaiting send — see [[staged-notifications]]). Each is gated by its own permission.

## Tips

- Approving or rejecting requires the `approval:act` permission; viewing the queue requires `approval:queue:read`.
- Approval **rules** (entity type, conditions, approver resolution, SLA and auto-escalate hours, priority) are configured on the admin **Approval rules** page.
- Auto-rollover collisions do **not** appear in this queue. They surface as read-only items on the **Alerts** page (`engagement_rollover`); the partner then drives the rollover from the engagement rather than an approve/reject decision here.
- Decisions are audit-logged with the approver, step, and comments.
