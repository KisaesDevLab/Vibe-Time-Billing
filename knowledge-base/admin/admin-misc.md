---
title: 'Holidays, required fields & other settings'
slug: admin-misc
category: admin
audience: staff
tags: ['admin', 'holidays', 'required fields']
---

# The admin area at a glance

The admin sidebar collapses into seven semantic groups; each expands to a list of tabs. The landing route `/admin` redirects to **Firm → Settings**. This is a map of what each tab does so you can find things fast.

## What you'll see

- **Firm**: **Settings** (firm-wide defaults), **Offices** (locations + per-office overrides), **Holidays** (firm holidays + PTO).
- **People**: **Users** (invite + staff list), **Roles** (system + custom roles), **Permissions** (editable per-firm permission matrix).
- **Catalog**: **Taxonomy**, **Engagement statuses**, **Templates**, **Recurring engagements**, **Services catalog**, **Packages**, **Payment methods**, **Tax payments**, **Terms templates**, **Milestones**, **Engagement letters**.
- **Billing**: **Rate codes**, **Rates**, **Recurring plans**, **Hour banks**, **Hour-bank tx**, **Retainer tiers**, **Appointments**, **Approval rules**, **Required fields**, **Stripe Connect**.
- **Messaging**: **Email + SMS providers**, **Notification templates**, **Notifications log**, **Webhooks**.
- **AI & Integrations**: **AI usage**, **API tokens**, **Saved reports**.
- **Operations**: **Jobs**, **Data**, **Backup**, **Compliance**, **Storage settings**, **Storage onboarding**, **Storage conflicts**, **Cloudflare Tunnel**.
- **Support**: **Knowledge Base**.

## Tips — key Operations & Integrations tabs

- **Jobs** (`/admin/jobs`): lists scheduled worker jobs (recurring-billing, ar-aging-snapshot, dunning-sweep, late-fee-accrual, late-entry-alert, milestone-date-trigger, hour-bank-expiration, approval-escalation, view-refresh) with queue stats and a **Run now** button.
- **Notifications log** (`/admin/notifications`): outbound dunning/invoice/payment deliveries — one row per attempt, with **Sent**, **Invoice**, **Step**, **Channel**, **Recipient**, **Outcome**, and error text; filter by window.
- **AI usage** (`/admin/ai-usage`): **AI status**, a usage summary (Requests, Failed, tokens, Cost) over a 7/30/90/180-day window, a per-feature filter, a request log, and a pricing-suggestions card.
- **API tokens** (`/admin/api-tokens`): create MCP/REST tokens for AI agents and integrators (Label + Allowed tools); the plaintext is shown once. **Revoke** disables a token.
- **Data** (`/admin/data`): **Load demo dataset** seeds a sample firm; **Reset to blank** wipes operational data (type `delete everything` to enable). Both need `firm:settings:write` and a fresh step-up.
- **Backup** (`/admin/backup`): backups run via nightly cron to `/backups` (30-day retention); restore via `ops/docs/restore.md`.
- **Compliance** (`/admin/compliance`): a firm snapshot of record counts and a downloadable WISP starter template.
- **Storage settings / onboarding / conflicts**: configure the file-storage backend (B2 / MinIO), match client folders, and resolve reconciliation conflicts.

## Steps

1. Click a group header in the left admin nav to expand or collapse it (your state is remembered per browser).
2. Click a tab to open that page.
3. Use **Firm → Settings** as your starting point — `/admin` redirects there.
