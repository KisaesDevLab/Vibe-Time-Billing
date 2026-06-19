---
title: 'Document & information requests'
slug: document-requests
category: files
audience: staff
tags: ['requests', 'documents', 'collection', 'pbc']
---

# Document & information requests

A client request is a checklist the firm sends to a client for documents, questions, or signatures, tracked against an engagement. This article covers creating requests (from scratch or a template), items, bulk-sending, reminders, how the client responds in the portal, and converting a fulfilled request into a time-entry suggestion.

## Steps

1. Create a request against an engagement. Provide a **title** (or a template whose pattern supplies one), optional body, priority, due date, assignee, and a list of items.
2. Add items, each with an ordinal, a **label**, optional body, an item kind of `QUESTION`, `DOCUMENT`, or `SIGNATURE`, and a **required** flag.
3. To send one template to many clients at once, use **bulk send**: pick a template and a list of targets (each client + engagement, with optional due-date / priority / assignee overrides).
4. Set **reminder days before** so the daily worker emails the client when the due date is within that many days.
5. The client opens the request in their portal and replies, marks it needs-info, attaches a file, or fulfills individual items.
6. When all required items are fulfilled, the request rolls up to `FULFILLED`. Staff can also fulfill, dismiss, or reopen a request.
7. On fulfill, a time-entry suggestion is queued for the assignee; in **suggestions/mine** you accept it (attaching a time entry) or dismiss it.

## Fields

- Request: engagement, title, body, assignee, due date, template, priority (`LOW`/`MEDIUM`/`HIGH`/`URGENT`), tags, reminder-days-before, items.
- Item: ordinal, label, body, item kind (`QUESTION`/`DOCUMENT`/`SIGNATURE`), required, due date.
- Template: key, name, title pattern, body pattern, default priority, default due offset, default reminder days, default assignee, item rows.

## What you'll see

- Request statuses are `OPEN`, `NEEDS_INFO`, `FULFILLED`, `DISMISSED`, and `EXPIRED` (a request past its window that was never fulfilled); the list's status filter offers all of them.
- A fulfilled request enriched with its linked time entry shows hours, entry date, and staff name in the list and detail.
- Reminder emails carry the subject "Reminder: <title> — due <date>" and are sent at most once per day per request.
- Explicit fields sent at create time always override template defaults.

## Drop-off requests

A request can be a **general** request (the default, which can re-send reminders while it stays open) or a **drop-off** request — an engagement hand-off tied to a specific date, such as a year-end document drop. A drop-off fires a single email-and-text reminder once its reminder window opens (rather than re-firing daily), and clients see it flagged as a drop-off in their portal.

## Tips

- Creating/editing requests requires `requests:manage`; reading requires `requests:read`. Template CRUD is gated by `taxonomy:write` (read by `taxonomy:read`).
- Bulk send skips targets whose engagement doesn't belong to the firm or doesn't match the given client, and reports them as skipped.
- A suggestion's expiration is firm-configurable (default 7 days); the queue is sorted by soonest expiry.
- Reopening a request clears its fulfilled / dismissed metadata and flips it back to `OPEN`.
