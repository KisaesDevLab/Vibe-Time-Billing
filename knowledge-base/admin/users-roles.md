---
title: 'Users, roles & permissions'
slug: users-roles
category: admin
audience: staff
tags: ['rbac', 'roles', 'permissions', 'users']
---

# Users, roles & permissions

Staff accounts live under **Admin → People**: **Users** (`/admin/users`), **Roles** (`/admin/roles`), and **Permissions** (`/admin/permissions`). Access is RBAC-gated — inviting a user requires `app_user:invite`, editing requires `app_user:write`, and archiving requires `app_user:archive` (all carried by the **admin** role template).

## What you'll see

- **Users** page: an **Invite staff** card and a **Staff** table showing Name, Email, a **TOTP** pill (enrolled / pending), **Status**, **Std hrs/wk**, and **Billable target**.
- **User detail**: tabs **Main**, **Contact Info**, **Rates**, **Skill Set**, **Targets**, **Notes**, plus **Roles**, **Authentication**, and **Lifecycle** cards.

## Steps

1. Go to **Admin → People → Users**.
2. In the **Invite staff** card, enter **Full name** and **Email**, then click **Send invite**.
3. Click a staff row to open their detail page.
4. On the **Main** tab click **Edit** to set names, hire/leave dates, **Status**, **Default office**, **Standard hours / week**, and **Billable target / month**; click **Save**.
5. In the **Roles** card, use the **+ Assign role…** picker to attach one or more roles.
6. To create a non-standard role, go to **People → Roles**, enter a **Role name**, click **Create**, then click **Permissions** to check the exact permission keys, and **Save permissions**.

## Tips — role templates (the union of all assigned roles applies)

- **admin** — full access (every permission key).
- **partner** — broad client/engagement/billing/approval rights; can read firm settings, manage rates, void invoices, refund payments, `billing:override`, partner-level reports.
- **manager** — write clients/engagements, build billing batches, create (not approve) adjustments; no invoice void / payment refund / partner-data reports.
- **senior** — read clients/engagements, create + edit own time, read billing batches and realization/utilization.
- **staff** — read clients/engagements, create + edit own time only.

## Other notes

- **Second factor is mandatory**: every staff user must enroll a second factor (passkey, TOTP, email OTP, or SMS OTP). The **TOTP** column shows `pending` until enrolled. On the **Authentication** card an admin can **Reset TOTP** — the user re-enrolls at next sign-in.
- The 5 system roles cannot be edited or deleted, but the **Permissions** page is an **editable** matrix: click a cell to grant (✓) or revoke (✗) a permission for a role. Changes save as per-firm overrides and take effect immediately; a dot marks any cell that differs from the role's default. (The Admin column stays locked so you can't lock yourself out.)
- A user with no role has read-only baseline access and will hit 403s on most actions. Use **Archive** to disable sign-in (soft delete; users are never hard-deleted).
