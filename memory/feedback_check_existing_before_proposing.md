---
name: feedback-check-existing-before-proposing
description: Before introducing a new module/table/feature, exhaustively check whether TB already has infrastructure that covers the use case. Default to extending existing systems, not parallel ones.
metadata:
  type: feedback
---

When planning a new feature — especially one that comes from an external proposal (like an addendum from a sibling product) — first inventory what TB already has that could cover the use case. Default to extending the existing system rather than introducing a parallel one.

**Why:** the user has invested in TB's existing infrastructure (Files v2, mail providers, SMS providers, audit log, RBAC, visibility rules, etc.). A parallel implementation duplicates surface area, splits the data model, and risks long-term drift. The user notices this fast and pushes back.

**How to apply:**

- Before proposing a new table, grep for similar concepts in `packages/db/src/schema/core.ts`.
- Before proposing a new router, look in `apps/api/src/` for the closest existing surface.
- Before proposing a new portal tab, check what's already mounted in `apps/portal/src/`.
- Concretely surfaced in CONNECT_INTEGRATION_ADDENDUM.md planning (2026-05-24): I proposed a Vault module with `vault_object` table, `vault/routes.ts`, separate portal tab. User correctly observed Vault duplicates the existing Files v2 (`files` table with `visibility` enum, `firm_folder_visibility_rules`, `file_access_log`, `invoice.pay_to_unlock_attachments`, Stripe webhook already emits `client.unlocked`). Right fix: extend Files v2's visibility enum with an `escrow` value and add the promotion logic — no new table, no parallel router.
- Don't introduce a vault, mail-v2, sms-v2, encryption-v2 module if TB already has one. Extend.
