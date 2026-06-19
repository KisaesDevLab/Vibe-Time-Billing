---
title: 'The audit trail'
slug: audit-log
category: security
audience: staff
tags: ['audit', 'log', 'compliance']
---

# The audit log

Every state-changing action writes a row to the `audit_log` table — client and engagement edits, sign-ins and sign-outs, step-ups, exports, payments, webhook deliveries, MCP calls, AI requests, backups, and database restores. The log is append-only at the database level: rows can be added but never altered or removed.

## Fields

Each audit row records:

- **occurredAt** — timestamp of the event.
- **action** — one of `CREATE`, `UPDATE`, `ARCHIVE`, `RESTORE`, `LOGIN`, `LOGOUT`, `STEP_UP`, `EXPORT`, `IMPERSONATE`, `PAYMENT`, `WEBHOOK_DELIVERY`, `MCP_CALL`, `AI_REQUEST`, `BACKUP`, `RESTORE_DATABASE`.
- **entityType / entityId** — what was acted on.
- **actor** — exactly one of `actorAppUserId` (staff), `actorPortalIdentityId` (portal client), or `actorMcpTokenId` (API/MCP token); system events may have none. The "at most one actor" rule is enforced by a database check constraint.
- **beforeJson / afterJson** — the before and after state.
- **ip / userAgent / requestId** — request source and correlation id.

## Steps

1. Open **Audit** in the staff app sidebar (requires `admin:audit:read`).
2. Use the **Filter audit log** card to narrow by **Entity type**, **Entity ID**, **Start**, and **End**, then **Apply**. Filters persist across reloads.
3. To search action / entity type / entity id / IP / user-agent text, use **Full-text search**: type at least two characters into **Search audit text** and click **Search**.
4. To export, request `/api/staff/audit/export.csv` (with your active filters). This requires the separate `admin:audit:export` permission.

## What you'll see

- The **Events** table lists each row with **When**, **Action** (a pill), **Type**, **Entity**, **Actor**, and **IP**. Newest first; the list view returns up to 200 rows.
- The **Entity** column shows the resolved **name** (for engagements, clients, invoices, and staff users) above the **full** identifier — no longer a shortened id.
- The **Actor** column shows a tone-coded pill — **staff**, **portal**, or **MCP** (for an API/MCP token) — the resolved person/token name, and the full actor id.
- Specialized read-only views exist for events by IP, by actor, by entity, recent webhook deliveries, recent outbound notifications, and worker alerts.

## Tips

- The log cannot be edited or deleted by the application — the app DB role has only INSERT and SELECT on `audit_log`; UPDATE/DELETE/TRUNCATE are revoked, with triggers as a backstop.
- Retention purges (if your firm runs them) must use a privileged maintenance role, never the running app.
- Use **Entity ID** filtering to reconstruct one record's full history, or actor filtering to review one user's activity.
