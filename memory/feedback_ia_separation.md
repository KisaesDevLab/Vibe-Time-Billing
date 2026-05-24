---
name: feedback-ia-separation
description: Distinct features get distinct nav sections in the UI, not nested-under-the-closest-cousin. When a feature feels "related to" another but has its own workflow + intent, default to giving it its own top-level surface.
metadata:
  type: feedback
---

When planning UI information architecture, default to giving each functional area its own dedicated section/tab/route rather than nesting it under the closest cousin. The user dislikes hidden / sub-menu placements for features that have their own workflow.

**Why:** features with their own workflow get easier to discover, more linkable, and easier to extend later. Bundling them under a parent tab signals "this is a minor subfeature of the parent" — wrong signal when the user thinks of them as peers.

**How to apply:**

- Portal IA in the absorbed-Connect-features plan (2026-05-24): user corrected my Phase E proposal where Vault tab also showed "pending requests." Fix: portal becomes 4 top-level tabs (Invoices, Messages, Requests, Vault), not 3.
- Same on the staff side: engagement detail page should give Requests its own tab (or peer-section) alongside Messages — not a panel inside Messages.
- When in doubt, ask the user whether two related features should share a tab or split; default to split.
- Backend separation: route prefixes / routers stay independent regardless of UI nesting (already the case here with `apps/api/src/messaging/`, `apps/api/src/vault/`, `apps/api/src/requests/`).
