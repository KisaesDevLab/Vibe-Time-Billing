# Vibe Time & Billing — System Template Library (moved)

> **The library data now lives in `packages/db/src/seed-helpers/system-templates/`.**
> It was relocated there so the API and `@vibe/db` can import it within their
> TypeScript `rootDir`. This directory is kept only for historical context.

## What it is

The system-shipped CPA starter templates: 6 service categories, ~40 service
templates, 6 package skeletons (tiered/duo), 6 AICPA-aligned engagement-letter
(terms) scaffolds, and 5 proposal email templates. They give a firm a working
starting point without authoring everything from scratch.

## How firms get them now

There are **no read-only `system_*` tables**. Instead, each admin catalog page has an
**"Import defaults from library"** link that clones the shipped defaults straight into
the firm's own editable tables:

```
SYSTEM_SERVICE_TEMPLATES  → services_catalog
SYSTEM_PACKAGE_TEMPLATES  → packages + package_services   (one firm package per tier)
SYSTEM_TERMS_TEMPLATES    → terms_templates
SYSTEM_EMAIL_TEMPLATES    → notification_template (EMAIL channel)
```

- Import is **idempotent**: firm-owned clones carry `cloned_from_slug`
  (migration `0123_template_clone_tracking.sql`); re-importing skips rows already
  present, and emails upsert on `(firm_id, kind, channel)`.
- The clone engine + endpoints live in `apps/api/src/template-library/`
  (`GET /api/staff/template-library/:area`, `POST /api/staff/template-library/:area/import`).

## Adding / editing templates

1. Edit the relevant file under `packages/db/src/seed-helpers/system-templates/`
   (`services.ts`, `packages.ts`, `terms.ts`, `emails.ts`, `categories.ts`).
2. Pick a stable kebab-case `slug` — never change it once shipped (it's the
   idempotency key).
3. Bump `TEMPLATES_PACK_VERSION` in that folder's `index.ts`.

## Disclaimer shipped with terms templates

> These templates are **starting points only**. Review with your professional
> liability carrier before use. Vibe Time & Billing does not provide legal advice and
> these templates do not substitute for engagement letter language reviewed by counsel
> familiar with your jurisdiction, services, and risk profile.
