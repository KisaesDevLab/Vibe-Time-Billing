---
title: 'Client status notifications & the approval queue'
slug: staged-notifications
category: messaging
audience: staff
tags: ['notifications', 'status', 'approvals', 'engagements', 'email', 'sms']
---

# Client status notifications & the approval queue

You can have the firm notify a client automatically when an engagement reaches a particular status — for example, "your return is ready for review." Each status can be configured to send immediately or to wait for staff approval first, so high-stakes messages get a second look before they go out.

## Configure which statuses notify

In **Admin → Engagement statuses**, edit a status and open its **client notifications** section:

- Turn on **notify the client when an engagement enters this status**.
- Choose **require approval** (queued for review) or **send immediately**.
- Pick the **channels** (email, text, portal notice) and **recipients** (billing contact, or all contacts).

## Approve, schedule, or cancel

When an engagement enters a configured status, the notification is created. Immediate ones are scheduled to send right away; approval ones wait in the queue.

1. Open **Approvals** and find the **Client notifications** card.
2. **Preview** any notification to see the rendered message per channel.
3. For each one (or in bulk) choose **Send now**, **Schedule** for a later time, or **Cancel**.
4. Sent, scheduled, cancelled, and failed notifications are visible for the audit trail; a failed one can be retried with **Send now**.

## Tips

- The recipients and message are **snapshotted when the notification is created**, so what you approve is exactly what sends — even if a template changes later.
- Only one pending/scheduled notification is kept per engagement and trigger: a newer status change automatically supersedes an unsent earlier one.
- Status changes made from the [[route-sheet]] feed this same pipeline.
