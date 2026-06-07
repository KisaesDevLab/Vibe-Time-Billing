# Vibe Time & Billing — System Template Library (Seed)

This directory contains the **system-shipped starter templates** that Vibe Time & Billing loads into every appliance. They give a firm a working starting point on day one without forcing them to author services, packages, and engagement letters from scratch.

## What's in here

| File | Purpose | Loads into |
|---|---|---|
| `types.ts` | Shared TypeScript types for all system templates | n/a |
| `categories.ts` | The 6 hard-coded service categories with metadata | `system_service_categories` |
| `services.ts` | ~40 generic CPA service templates | `system_service_templates` |
| `packages.ts` | 6 generic package skeletons (tiered + duo formats) | `system_package_templates` + `system_package_template_items` |
| `terms.ts` | 6 engagement-letter scaffolds aligned to AICPA SSARS / AU-C / SQMS standards | `system_terms_templates` |
| `emails.ts` | 5 generic transactional email templates | `system_email_templates` |
| `migration.sql` | Drizzle migration for the `system_*` tables | n/a |
| `index.ts` | Master loader; idempotent on slug | n/a |

## How it works at runtime

1. On first appliance boot, the loader (`pnpm seed:templates`) populates the `system_*` tables. These are **read-only** to firms.
2. The firm's onboarding wizard shows a "Templates Library" view backed by these tables.
3. When a firm clicks "Import to my catalog," the system template is **cloned** into the firm's own `services_catalog` / `packages` / `terms_templates` tables. From that point the firm owns and edits the copy.
4. Re-running the loader is safe (`ON CONFLICT (slug) DO UPDATE`) so we can ship new templates with appliance upgrades without overwriting firm-customized copies.

## Attribution and philosophy

These templates are written from generic CPA industry knowledge and AICPA-aligned compliance scaffolding. Where the materials touch the **methodology** of tiered packaging — differentiating tiers by experience and access rather than by stacking deliverables — that idea is industry-standard and appears across most modern proposal tooling.

Firms who want richer, opinionated, niche-specific packs (dental, construction, fiduciary, controller, vCFO heavy, etc.) should buy them as licensed add-on packs. The Template Packs loader described in `ADDENDUM-PROPOSAL-MODULE.md` §P-future will support importing licensed third-party JSON packs into the firm's catalog. Vendors who publish such packs include She Counts LLC (Geraldine Carter), AICPA, and state CPA societies.

## Disclaimers shipped with these templates

Every terms-template scaffold and every package skeleton renders with a banner the firm cannot delete (only edit):

> These templates are **starting points only**. Review with your professional liability carrier before use. Vibe Time & Billing does not provide legal advice and these templates do not substitute for engagement letter language reviewed by counsel familiar with your jurisdiction, services, and risk profile.

## Schema notes

The `system_*` tables sit *alongside* the firm-owned tables defined in P01 of the addendum build plan. The relationship is:

```
system_service_templates    → firm clones →   services_catalog
system_package_templates    → firm clones →   packages + package_services
system_terms_templates      → firm clones →   terms_templates (firm-owned)
system_email_templates      → firm clones →   firm_email_templates
```

System templates carry a `slug` as their stable identifier across appliance upgrades. Firm-owned clones carry a ULID and a `cloned_from_slug` reference for audit traceability.

## Adding new templates

1. Add the new template object to the relevant file (`services.ts`, `packages.ts`, etc.).
2. Pick a stable kebab-case `slug` — never change it once shipped.
3. Run `pnpm seed:templates` locally; verify idempotency.
4. Bump the `templatesPackVersion` constant in `index.ts`.
5. Ship in the next appliance release. Firms keep their existing clones; new firms get the updated library.
