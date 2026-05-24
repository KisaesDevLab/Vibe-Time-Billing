---
name: feedback-product-independence
description: When two products share lineage (e.g., Vibe TB + Vibe Connect), they must ship as independent runtime artifacts. Code can be lifted/vendored from the sibling repo, but no runtime dependency on the other product is allowed.
metadata:
  type: feedback
---

When a feature description sounds like "integrate product A with product B," the user does NOT want runtime cross-app coupling (shared services, peer discovery, separate appliance dependencies, license-gated entitlements that key off the other product being installed). The user wants each product to be a standalone artifact that can be installed alone and works fully.

**Why:** users buy/install one product at a time. Forcing them to install both, or making one degrade when the other is absent, is a non-starter for the appliance distribution model. Treats them as independent SKUs.

**How to apply:**

- When an addendum or shared plan proposes `@vibe/*` shared runtime packages, treat that as a development convenience, not a runtime requirement. The receiving product vendors / lifts / rebuilds the code in its own monorepo.
- When the plan proposes shared Postgres / separate schemas with cross-schema references, default to no cross-schema. Both products own their own schemas / DBs; FKs stay internal.
- When the plan proposes license entitlements that gate features by which product is installed, default to skipping entitlement gating. Features ship in whichever artifact contains them.
- Concretely surfaced in CONNECT_INTEGRATION_ADDENDUM.md planning (2026-05-24): user rejected the plan that treated `vibe-connect-postgres` + `@vibe/*` shared packages as runtime deps. Reinterpreted as "absorb the Connect feature set into TB natively; Connect's repo is a development reference."
