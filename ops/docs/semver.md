# Semver policy

Vibe Practice Management follows strict semver from `v1.0.0` onward. While in
beta (`v0.MINOR.PATCH`), the rules below apply with the asterisks noted.

## Versions

| Component | Rule |
|-----------|------|
| `MAJOR` | Bump for **breaking** API or schema changes that require manual operator action. |
| `MINOR` | Bump for new features, additive endpoints, additive columns. **Never** for breaking. |
| `PATCH` | Bug fixes only. No new endpoints, no schema changes. |

## During the `v0.x` beta

- A `v0.MINOR` bump may include schema migrations but **always** runs
  cleanly via `pnpm migrate` from the previous version.
- A `v0.MINOR` rollback is only supported via the most recent backup
  taken before the upgrade — see `ops/docs/restore.md`.
- `v0.PATCH` releases never touch the schema and never break wire
  compatibility.

## What "breaking" means here

A change is **breaking** if any of the following are true:
1. A previously-accepted API request body now returns a non-2xx response
2. A previously-returned field is removed or renamed
3. A migration is irreversible (cannot be rolled back via a future
   migration without data loss)
4. The audit log schema is mutated (its append-only invariant means we
   never break that table)

## Compatibility windows

After `v1.0.0`:
- `v1.MINOR` bumps support **N-1** rollback for 12 months
- `v1.MAJOR` bumps publish a migration guide; rollback only via backup
- `v1.PATCH` bumps are always forward + backward compatible

## Tag conventions

- Every release ships a git tag of the form `vMAJOR.MINOR.PATCH`
- Beta milestones: `v0.1.0-rc1`, `v0.1.0-rc2`, etc.
- The GHCR image tag matches the git tag exactly
- A floating `latest` tag tracks the most recent stable release (never a
  prerelease)

## Deprecation

When an endpoint or column is slated for removal in the next `MAJOR`:
1. Add a deprecation header `X-Deprecated: <reason>` on responses
2. Document the replacement in `ops/docs/migration-NEXT.md`
3. Surface a banner in the admin dashboard for affected firms
4. Wait at least one `MINOR` cycle before actually removing
