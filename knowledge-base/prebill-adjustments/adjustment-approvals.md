---
title: 'Adjustment approvals & step-up'
slug: adjustment-approvals
category: prebill-adjustments
audience: staff
tags: ['adjustments', 'approval', 'step-up', 'threshold']
---

# Adjustment approvals & step-up

Two gates protect adjustments.

## Step-up (fresh second factor)

Creating any adjustment requires a recent second-factor verification (the step-up window is **30 minutes** from your last verification). If it's stale, the create is rejected with "Your session needs a fresh TOTP step-up before creating adjustments. Verify in Account → Two-factor." Re-verify and retry. A passkey sign-in can itself satisfy step-up.

## Approval threshold

On submit, the amount is compared to the firm's **Adjustment approval threshold** (Admin → Firm settings; default **$1,000** when unset).

- **Over** the threshold → the adjustment is created **PENDING_APPROVAL**, routed to the client's **partner in charge** (with a ~48h SLA and an email if mail is configured). It doesn't affect the billed total until approved.
- **At/under** the threshold → applied immediately.

The approver acts in the **Approvals** queue (**Approve** / **Reject**).

## Tips

- Re-verify your second factor before a billing session so step-up doesn't interrupt you mid-adjustment.
- Lower the threshold for more partner oversight of small write-offs; raise it to reduce friction.
