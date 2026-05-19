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
4. Run `git log --oneline --grep='^phase'` to find the last completed item. If empty, start at Phase 1, Item 1.

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
- Standard rate snapshot: time entries capture rate at creation; historical reports never shift
- Per-timekeeper allocation grain: adjustment_allocation rows at (adjustment_id, time_entry_id, app_user_id)
- Customer-owned external resources: firm owns Stripe, Cloudflare, domain — Kisaes never holds customer credentials
- License gate on portal: commercial license token check at boot and on critical portal routes
- PolyForm Internal Use 1.0.0 license header on every source file

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
  - `LICENSE.md` (PolyForm Internal Use 1.0.0)
  - `package.json` with `name: "vibe-time-billing"` and pnpm workspace config
- **First session is the longest.** Phase 1 sets up the monorepo and CI; expect it to take the most context. Subsequent phases are smaller.
- **Watch for STOPPED_BECAUSE.md.** If it appears at repo root between sessions, the autonomous build paused and needs your input. Answer the question in QUESTIONS.md, delete `STOPPED_BECAUSE.md`, and start a new session with the same prompt.

## Resuming mid-phase

If a previous session ended mid-phase (token exhaustion, no STOPPED_BECAUSE.md), the start sequence handles it: `git log` reveals the last committed item, and Claude Code picks up at the next item in the current phase.

## When to re-read this prompt

Each new Claude Code session needs the prompt pasted again. The session-start re-orientation is part of how autonomous mode survives across context windows.
