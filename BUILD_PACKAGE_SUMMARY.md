# Autonomous build package — Vibe Time & Billing

This is the complete kickoff bundle. Five files at repo root, one seed file, and one reference document already in place.

## What's in the bundle

| File | Purpose | Goes at |
|---|---|---|
| `CLAUDE.md` | Standing operating manual for Claude Code | Repo root |
| `BUILD_PLAN.md` | 26 phases, ~513 items, acceptance criteria | Repo root (rename from `vibe-time-billing-build-plan.md`) |
| `QUESTIONS.md` | 30 locked decisions + open-question scratchpad | Repo root |
| `README.md` | User-facing front door | Repo root |
| `AUTONOMOUS_EXECUTION_PROMPT.md` | The prompt to paste into Claude Code each session | Repo root or `ops/` |
| `engagement-starter-pack.json` | Phase 5 seed: 8 engagement templates | `seed/` |
| `portal-schema.ts` | Phase 2 reference: portal-half of the Drizzle schema | `packages/db/src/schema/portal.ts` |

## How to use it

1. **Create the GitHub repo** `KisaesDevLab/Vibe-Time-Billing` (private at first; can flip public closer to launch).

2. **Initialize the repo locally:**
   ```sh
   mkdir vibe-time-billing && cd vibe-time-billing
   git init
   ```

3. **Drop these files into place:**
   ```sh
   # At root:
   cp /mnt/user-data/outputs/CLAUDE.md .
   cp /mnt/user-data/outputs/QUESTIONS.md .
   cp /mnt/user-data/outputs/README.md .
   cp /mnt/user-data/outputs/AUTONOMOUS_EXECUTION_PROMPT.md .
   cp /mnt/user-data/outputs/vibe-time-billing-build-plan.md ./BUILD_PLAN.md

   # In seed/:
   mkdir seed
   cp /mnt/user-data/outputs/engagement-starter-pack.json seed/

   # In packages/db/src/schema/ (you'll create this in Phase 2):
   # Just keep portal-schema.ts handy as reference until Phase 2 creates the directory
   ```

4. **Add the Elastic License 2.0 file:**
   ```sh
   curl -o LICENSE.md https://polyformproject.org/wp-content/uploads/2020/05/Elastic-2.0.txt
   # Or paste from polyformproject.org/licenses/internal-use/1.0.0/
   ```

5. **Initial commit:**
   ```sh
   git add .
   git commit -m "phase 0 · bootstrap · CLAUDE.md, BUILD_PLAN.md, QUESTIONS.md, README, license, seed"
   git remote add origin [email protected]:KisaesDevLab/Vibe-Time-Billing.git
   git push -u origin main
   ```

6. **Open a fresh Claude Code session** at the repo root. Paste the prompt from `AUTONOMOUS_EXECUTION_PROMPT.md`. Build begins.

## Expected first-session output

The first Claude Code session, starting cold, should:

1. Read CLAUDE.md, BUILD_PLAN.md, QUESTIONS.md
2. Notice there are no `phase` commits yet → start at Phase 1, Item 1
3. Initialize pnpm workspace structure
4. Create `apps/web`, `apps/portal`, `apps/api`, `apps/worker`, `packages/db`, `packages/types`, `packages/ui`, `packages/core`
5. Add `docker-compose.dev.yml` with postgres 16, redis 7, mailhog
6. Add base TypeScript configs, ESLint, Prettier, husky pre-commit
7. Add `LICENSE.md` header to every source file
8. Add the GitHub Actions workflow
9. Add Caddy templates for two-host routing
10. Commit each item separately
11. Run the Phase 1 acceptance smoke test
12. Commit `phase 1 · complete · monorepo and infra foundation`
13. Begin Phase 2 (schema)

Expect the first session to consume most of its context window completing Phase 1. Subsequent phases are smaller.

## Decision summary (the 30 locked choices)

For quick reference — full context in `QUESTIONS.md`.

**Schema:** Single-firm appliance · USD only · soft-delete always
**Auth:** 30-min step-up · TOTP required for all staff · phone reverify on new device
**Payments:** Firm-owned Stripe · no IOLTA · per-engagement fee passthrough
**Infra:** Subdomain routing · pluggable email (SMTP/Postmark/Resend/SES) · pg_dump nightly
**AI/MCP:** Full read+write MCP · hybrid AI cost cap · hardware-adaptive local LLM
**SMS/PDF:** Pluggable SMS (TextLink/Twilio/SNS) · visibility-only SMS cost · Puppeteer for PDFs
**Billing UX:** 0.25-hour default · per-entry scope tagging · custom-weighted toggle
**Engagement:** Hour-bank forfeit · partner-decides rollover collision · starter pack of 8 templates
**Business:** Per-firm unlimited annual · per-client invoice consolidation pref · $1K configurable approval threshold
**Operational:** Variable-only templates · standard enum mitigation · portal-view-only receipts

## Mockups (already produced)

For reference and reproduction in code:
- `/mnt/user-data/outputs/vibe-time-billing-mockups.html` — 14 sections of staff app UI
- `/mnt/user-data/outputs/vibe-time-billing-portal-mockups.html` — 6 sections of client portal UI

These are not part of the autonomous build package per se, but they're the visual reference for Phase 9 (time entry UI), Phase 11 (pre-bill review), Phase 12 (adjustment dialog), Phase 13 (invoice composer), Phase 16 (portal screens), Phase 17 (reporting cube), Phase 20 (admin). Drop them in `ops/docs/mockups/` if you want them inside the repo.

## Feature checklist (already produced)

`/mnt/user-data/outputs/vibe-time-billing-feature-checklist.md` — your thinned feature inventory. Useful as a sales-conversation companion document, not as a build artifact.

## What's NOT in this package

Deliberately deferred to the build phase itself:

- The full Drizzle schema (Phase 2 builds it — `portal-schema.ts` is the portal half reference)
- The repo skeleton (Phase 1 creates it)
- The Caddy configs (Phase 1 + Phase 25)
- The Docker images (Phase 1 + Phase 25)
- The actual marketing site / landing page (separate concern)
- Pricing page content (Phase 26, pre-launch)

## Quality bars

- Every phase commit should pass CI (typecheck + lint + tests)
- Every item commit should be atomic and reversible
- No `WIP` commits except at session-end stops
- Audit log row for every mutation, no exceptions
- Allocation method tests exhaustive (Phase 12)
- Cross-realm auth isolation E2E-tested (Phase 16)

## When you'll need to step in

The autonomous loop will pause and write `STOPPED_BECAUSE.md` if:

- A locked decision turns out to be internally contradictory with something in BUILD_PLAN.md
- A new architectural question arises that's irreversible (schema migration that can't be retracted, security model change)
- Test failures persist across attempts

Otherwise the build runs without you. Check in periodically (1-2x/day during active build) to read progress notes and update QUESTIONS.md if questions accumulate.

## Estimated timeline

Per BUILD_PLAN.md: 13–17 weeks autonomous, allowing for context-budget realities of large multi-phase work. MVP completion (Phases 1–17, 19, 20, 25, 26) is the first major milestone. Phases 18, 21–24 layer on after first release.

In wall-clock terms with active session-management: 8–12 weeks is realistic for MVP if Claude Code is operating most weekdays. Allow extra week padding for the Phase 12 allocation math test suite, which is the highest-correctness-risk surface in the entire build.

## Final pre-flight checklist

Before pasting the autonomous execution prompt:

- [ ] `KisaesDevLab/Vibe-Time-Billing` GitHub repo created
- [ ] Local repo initialized with the 5 root files + seed + license
- [ ] Initial commit pushed to origin/main
- [ ] Claude Code installed and authenticated
- [ ] Working directory is the repo root
- [ ] No other Claude Code sessions running against this repo
- [ ] `STOPPED_BECAUSE.md` does not exist
- [ ] You've skimmed CLAUDE.md and QUESTIONS.md and confirm the locked decisions still look right

When the checklist is clean, paste the prompt and let it run.
