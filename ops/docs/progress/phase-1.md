# Phase 1 — Repo & infrastructure foundation

## Items completed

1. pnpm workspace at root (apps/_, packages/_). Already in repo from bootstrap.
2. `apps/web` — React 18 + Vite + TS strict scaffold. Includes BrowserRouter + minimal Home route.
3. `apps/portal` — React 18 + Vite + TS strict scaffold, distinct port (5174) and HTML title.
4. `apps/api` — Express + TS + tsx dev, with `/health` endpoint, env-validated config (Zod), pino structured logging, request-ID logging via pino-http.
5. `apps/worker` — Node + pino boot loop; queues land in Phase 10.
6. `packages/db` — Drizzle wiring (`createDb`), migration runner (`tsx src/scripts/migrate.ts`) that applies hand-written SQL from `packages/db/migrations/` and tracks applied filenames in `schema_migrations`.
7. `packages/types` — shared domain enums (FeeStructure, AllocationMethod, AppUserRole, etc.).
8. `packages/ui` — design tokens + a `Pill` component used by both apps.
9. Dockerfile — pre-existing from bootstrap; references the package layout established here.
10. `ops/docker/docker-compose.dev.yml` — pre-existing.
11. ESLint + Prettier + lint-staged + husky already installed; added `.prettierignore` so bootstrap markdowns and large schema files don't trip the format check in CI.
12. License/README/CLAUDE.md/QUESTIONS.md — pre-existing.
13. CI workflow — pre-existing.
14. Caddy templates — pre-existing for `app.*` + `portal.*` two-host routing.
15. `.env.example` — pre-existing; the API's `loadConfig` validates a subset of these at boot.

## Acceptance criteria

- `pnpm typecheck` clean across all 8 workspace projects.
- `pnpm lint` clean (only an informational note about the `react` settings package).
- `pnpm test` clean — API has 5 passing tests (config validation + `/health`).
- `pnpm prettier --check` clean.
- Phase 12 allocation suite is intentionally excluded from vitest runs (see `packages/core/vitest.config.ts`) until Phase 12 implements the methods. TDD: tests ship now, implementation lands later.

## Decisions deferred

None. All Phase 1 questions either inherit locked decisions from QUESTIONS.md or are resolved by the pre-existing bootstrap.

## Surprises

- The Phase 12 test file shipped in the bootstrap expects `AllocationResult.appUserRole` and `CustomWeightedInput.weights[].weight` + `weightingMode` — slightly different from the BUILD_PLAN.md prose. The stub in `packages/core/src/adjustment-allocation.ts` matches the test file so TS compiles cleanly.
- TypeScript project references (`tsc -b`) clash with workspace `paths` pointing into sibling package sources; resolved by using flat `tsc --noEmit` in app tsconfigs and dropping `rootDir` from package tsconfigs.

## Next

Phase 2 — database schema & migrations. The hand-written Drizzle schemas in `packages/db/src/schema/{core,portal}.ts` and the two hand-written SQL migrations are pre-staged from the bootstrap. Phase 2 wires up `pnpm db:migrate` end-to-end and produces query helpers.
