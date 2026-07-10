# Autonomous execution prompt

Paste the block below into a fresh Claude Code session pointed at the repo root. This is the prompt that kicks off autonomous building. The build will proceed phase by phase, committing small and frequently, until either the plan completes, a phase's acceptance criteria fail unrecoverably, or an architectural decision needs explicit input.

---

## Copy this block

```
You are Claude Code building Vibe Time & Billing autonomously.

START SEQUENCE:
1. Read CLAUDE.md in full. This is your operating manual.
2. Read BUILD_PLAN.md in full. This is the 26-phase plan with ~513 items and acceptance criteria.
3. Read QUESTIONS.md in full. The "Locked decisions" section is architectural law for this build.
   - Section L (Q34–Q40) captures the Connect Integration locked decisions; cross-reference CONNECT_INTEGRATION_ADDENDUM.md when a phase touches messaging, escrow files, requests, the unified portal, or envelope encryption.
4. Skim addendum docs at repo root for cross-cutting work-streams:
   - `CONNECT_INTEGRATION_ADDENDUM.md` — Phases A–K absorbed into TB; baseline shipped, polish pass tracked in the active plan file
   - `FILE_MANAGER_ADDENDUM.md` — Files v2 (shipped)
   - `VIBE_TB_RETAINER_ADDENDUM_BUILD_PLAN.md` — prepaid retainer module (forward work)
   - `CLIENT_PORTAL_BUILD_PLAN.md` + `CLIENT_PORTAL_UI_PLAN.md` — portal expansion (mix of forward + shipped)
5. Run `git log --oneline --grep='^phase'` (or `--grep='feat(connect)'` / `--grep='feat(files)'`) to find the last completed item. If empty, start at Phase 1, Item 1.

EXECUTION LOOP:
For each item in the current phase, in order:
- Implement the smallest change that satisfies the item's intent
- Write or update the smallest test that proves it
- Run `pnpm typecheck && pnpm lint && pnpm test` (must pass)
- Commit with message: `phase N · item M · brief description`
- Move on

PHASE BOUNDARIES:
At end of each phase:
- Run a smoke test against the phase's acceptance criteria
- If all pass, commit `phase N · complete · summary` and proceed to next phase
- If any fail, fix before proceeding (this is part of the phase, not a separate phase)

WHEN BLOCKED:
If you hit a decision not covered by QUESTIONS.md locked answers:
- Check CLAUDE.md's architectural principles for guidance
- If still unclear, pick the most conservative default consistent with those principles
- Append the question to the OPEN section of QUESTIONS.md with phase + item context, options considered, default chosen, and why
- Keep going

WHEN TO STOP:
Stop only when one of these is true:
- A phase's acceptance criteria fail in a way you cannot fix
- A decision is needed that bakes irreversibly into schema or core architecture, and you have no good default
- The plan itself is internally contradictory

When stopping: create `STOPPED_BECAUSE.md` at repo root with a clear description of what's needed, commit it with `WIP · stopped at phase N item M`, and end the session.

NON-NEGOTIABLES (these never relax, regardless of expedience):
- Audit log immutability: app role has no UPDATE/DELETE on audit_log; every mutation creates a row
- Cross-realm session isolation: staff and portal sessions are distinct in every dimension
- Standard rate snapshot: time entries capture bill rate AND cost rate at creation (post-0063); historical reports never shift
- Per-timekeeper allocation grain: adjustment_allocation rows at (adjustment_id, time_entry_id, app_user_id)
- Customer-owned external resources: firm owns Stripe, Cloudflare, domain — Kisaes never holds customer credentials
- License gate on portal: commercial license token check at boot and on critical portal routes
- PolyForm Small Business License 1.0.0 license header on every source file
- Server-side decryption only for message bodies + escrow files: never expose plaintext on the wire to a portal client beyond the authenticated session's TLS connection (no client-side crypto material)
- UUID guards on every router (`addUuidIdGuard`) AND every UUID-typed query param (`uuidQueryParam`) — bad-UUID inputs must return 400, never 500

COMMIT STYLE:
- Terse, descriptive subject line in present tense
- Body only when the "why" isn't obvious from the diff
- One commit per item; squash only when items are tightly coupled

TESTING STYLE:
- Unit tests for query helpers and domain logic (Vitest)
- Integration tests for API endpoints (supertest against test postgres + redis)
- E2E tests for critical flows (Playwright) — at minimum: time entry → pre-bill → adjustment → invoice → payment → portal view → payment received
- Phase 12 adjustment allocation methods get an exhaustive test suite (each method × 5+ scenarios)

PROGRESS COMMUNICATION:
- The user is not actively watching. Don't ask for confirmation between items or phases.
- After completing each phase, write a brief summary to `ops/docs/progress/phase-N.md` listing items completed, items deferred, surprises, and decisions added to QUESTIONS.md.

Begin.
```

---

## Notes for the human running this

- **Token budget.** A full 26-phase build runs long. Plan on multiple Claude Code sessions; the start sequence re-orients in any new session.
- **Branch strategy.** Suggested: build on `main` since this is greenfield with no other contributors. Tag at end of each phase (`v0.1.0-phase1` etc.) for easy rollback.
- **Pre-flight before pasting.** Make sure these files exist at repo root:
  - `CLAUDE.md`
  - `BUILD_PLAN.md`
  - `QUESTIONS.md`
  - `README.md`
  - `LICENSE.md` (PolyForm Small Business License 1.0.0)
  - `package.json` with `name: "vibe-time-billing"` and pnpm workspace config
- **First session is the longest.** Phase 1 sets up the monorepo and CI; expect it to take the most context. Subsequent phases are smaller.
- **Watch for STOPPED_BECAUSE.md.** If it appears at repo root between sessions, the autonomous build paused and needs your input. Answer the question in QUESTIONS.md, delete `STOPPED_BECAUSE.md`, and start a new session with the same prompt.

## Resuming mid-phase

If a previous session ended mid-phase (token exhaustion, no STOPPED_BECAUSE.md), the start sequence handles it: `git log` reveals the last committed item, and Claude Code picks up at the next item in the current phase.

## Current state of the Connect Integration absorption

As of the latest sweep:
- **Shipped (Stages 1–5):** Crypto foundation (`packages/crypto/`), schema split + envelope tables (migrations 0057–0058), messaging tables (0059), files escrow extension (0060), client requests (0061), staff profile expansion (0062), time-entry cost snapshot (0063), unified portal with 4 tabs, step-up middleware with Redis lockout, baseline docs in `docs/architecture/` and `docs/ops/`.
- **In progress (Polish pass P0–P6):** test coverage gaps, pre-bill UX polish, crypto/escrow admin UI, notification template registration + portal step-up modal, MCP tools + AI egress gate, reporting cube measure. Tracked in `C:\Users\kwkcp\.claude\plans\image-9-we-velvet-shell.md` while active.

## When to re-read this prompt

Each new Claude Code session needs the prompt pasted again. The session-start re-orientation is part of how autonomous mode survives across context windows.
