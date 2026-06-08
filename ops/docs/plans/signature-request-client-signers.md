# Plan: New signature request — pick client, pull associated people as signers, optional engagement

## Goal

Replace the free-text "Signers" entry in the **New signature request** dialog with a
client-driven flow:

1. **Select a client.**
2. **Pull the people associated with that client** (contacts + portal users).
3. **Select which of those people are signers** (checkbox), with name/email auto-filled.
4. **Optionally associate the request with an engagement** for that client.

Manual name/email entry stays available as a fallback (third-party signers — an IRS
agent, opposing counsel, a non-contact spouse — who aren't in the client's people list).

## What already exists (reuse, don't rebuild)

- **Create endpoint** `POST /api/staff/signatures` — `apps/api/src/signatures/routes.ts:202`.
  Body schema `CreateSchema` (`routes.ts:76`): `{ title, clientId?, formType?, sendInOrder?,
  pageGeometry?, signers: [{ name, email, role?, order? }] }`. Already accepts `clientId`.
- **Create dialog** `CreateSignatureDialog` — `apps/web/src/pages/Signatures.tsx:188`.
  Today collects title + form type + a free-text signer list and POSTs the above.
- **People-by-client endpoint** `GET /api/staff/clients/:id/people` —
  `apps/api/src/clients/people.ts:37`. Returns reconciled entries (`kind`:
  `linked | contact_only | portal_only | invited`) each with a `contact` block
  (`personId`, `fullName`, `email`, `roleId`, `isPrimary`…) and/or an `access` block
  (`portalIdentityId`, `fullName`, `primaryEmail`, `role`…). This is the signer source.
- **Engagements-by-client endpoint** `GET /api/staff/engagements/?clientId=<uuid>` —
  `apps/api/src/engagements/routes.ts:172`. Returns `{ items: [{ id, name, status, … }] }`.
- **Client search** — the existing client picker/search used by other staff forms
  (`GET /api/staff/clients?q=`). Reuse the same combobox pattern.
- **Signer storage** `signature_signers` — `packages/db/src/schema/signatures.ts:66`.
  `name` + `email` required; `role`, `order` optional. **No** person/contact FK today.

## Schema changes (migration 0133)

Two nullable additions, both backward-compatible:

1. `signature_requests.engagement_id uuid` — FK → `engagement(id)` `ON DELETE SET NULL`,
   nullable. Index `(firm_id, engagement_id)`. (`schema/signatures.ts:30` block +
   migration.)
2. `signature_signer` link columns (nullable), so a signer pulled from the people list
   carries provenance and we can self-heal/reconcile at send time:
   - `person_id uuid` → `person(id)` `ON DELETE SET NULL`
   - `client_contact_id uuid` → `client_contact(id)` `ON DELETE SET NULL`
   - `portal_identity_id uuid` → `portal_identity(id)` `ON DELETE SET NULL`

   These are **optional**. Manually-typed signers leave all three null (current behavior
   preserved). They're additive metadata — name+email remain the canonical fields OpenSign
   uses, so nothing downstream breaks if they're null.

> Scope note: the link columns are nice-to-have provenance. If we want the thinnest
> possible cut, ship only `engagement_id` in 0133 and defer the signer-link columns.
> Recommended to include them now since the UI already knows the personId/identityId at
> selection time and capturing it is free.

## Backend changes

`apps/api/src/signatures/routes.ts`

- **`CreateSchema`** (`:76`): add `engagementId: z.string().uuid().optional()`, and extend
  the signer item with optional `personId`, `clientContactId`, `portalIdentityId` (all
  `z.string().uuid().optional()`).
- **POST handler** (`:202`): persist `engagementId` on the `signature_requests` insert;
  pass the three optional link ids through on each `signature_signers` insert (`:236`).
- **Validation** (defense-in-depth, all firm-scoped):
  - If `engagementId` is provided, verify it belongs to `firmId` **and** to the given
    `clientId` (reject cross-client / cross-firm). Requires `clientId` to be present when
    `engagementId` is.
  - If a signer carries `personId`/`clientContactId`/`portalIdentityId`, verify it is one
    of the people actually associated with `clientId` (reuse the people.ts query logic, or
    a lightweight existence check scoped to the client). Drop/clear ids that don't match
    rather than hard-failing, so a stale client switch can't 500 the request.
- **`PatchSchema`** (`:479` block): allow editing `engagementId` on draft requests
  (same client/firm validation).

`apps/api/src/signatures/send.ts`

- No required change. Optionally, when reconciling OpenSign contacts at send time
  (`send.ts:151`), prefer the stored `person_id`/`portal_identity_id` over the email match.
  Out of scope for v1.

## Frontend changes — `CreateSignatureDialog` (`apps/web/src/pages/Signatures.tsx:188`)

Restructure into a short top-to-bottom flow (single dialog, no wizard needed):

1. **Client** (new, top): a client search combobox. On select, store `clientId` and fire
   two loads in parallel: `GET /clients/:id/people` and
   `GET /engagements/?clientId=:id&status=ACTIVE` (plus PROPOSED). Optional — leaving it
   blank keeps today's manual-only behavior.
2. **People → signers** (new): render the reconciled people list as checkbox rows. Each
   row shows `fullName`, email, and a role/kind hint (e.g. "Primary contact", "Portal —
   FULL"). Checking a row adds a signer pre-filled with that person's name + best email
   (`contact.email` ?? `access.primaryEmail`) and its `personId` / `clientContactId` /
   `portalIdentityId`. **Rows without any email are shown disabled** with a "no email on
   file" note (signers require email). De-dupe people that appear as both contact and
   portal access (the endpoint already returns one reconciled row per person via `key`).
3. **Signers list** (existing block, kept): shows the chosen signers; selected-from-people
   rows are editable (you can fix a name/role) and removable; **+ Add signer** still adds a
   blank manual row (third parties). Keep the existing per-row name/email/role inputs and
   the `order` implied by list position.
4. **Engagement** (new, optional): a combobox of the client's engagements
   (`{id} → name (status)`), with an explicit "— None —" option. Disabled/empty until a
   client is selected.
5. **Title + Form type** (existing): unchanged. Consider auto-suggesting a title from the
   selected engagement name when title is blank (nicety, optional).

**Submit** (`:210`): POST adds `clientId`, `engagementId || undefined`, and the per-signer
link ids. Keep the existing `valid` guard (title + ≥1 signer with name + valid email).

State additions: `clientId`, `people`, `engagements`, `engagementId`, plus loading/error
for the two fetches. Signer rows gain optional `personId` / `clientContactId` /
`portalIdentityId` carried through to submit (not shown as inputs).

## Tests

API (pglite, mirror `apps/api/src/__tests__/` signature/people patterns):

- Create with `clientId` + `engagementId`: persists both; rejects an `engagementId` whose
  client ≠ body `clientId`; rejects cross-firm `engagementId`.
- Create with signers carrying `personId`/`portalIdentityId` that belong to the client:
  persisted on `signature_signers`. Ids that don't belong to the client are cleared (or
  rejected) — assert the chosen policy.
- Patch a draft to set/clear `engagementId` with the same validation.
- Backward-compat: existing create (no clientId, free-text signers) still succeeds with
  null link columns.

Frontend (if component tests exist for this area; otherwise manual):

- Selecting a client loads people + engagements; checking a person adds a pre-filled,
  link-tagged signer; emailless people are non-selectable; manual add still works.

## Verification

- `pnpm -r typecheck`; eslint changed files; new + existing signature/people test suites.
- `docker build` + recreate `init-static api worker`; confirm clean boot + migration 0133
  applies.
- Manual: New request → pick a client with ≥2 contacts and a portal user → select two as
  signers → pick an active engagement → create → open detail/FieldEditor and confirm the
  signers + linked engagement are present; then create a request with a manually-typed
  third-party signer and confirm it still works.

## Out of scope

- Changing OpenSign send/field-placement logic (signers still flow by name+email).
- Auto-creating contacts from manually-typed signers.
- Bulk / multi-client signature requests.
- Portal-side changes — this is staff-only request creation.
