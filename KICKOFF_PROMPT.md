# Vibe Time & Billing — Retainer Addendum

## Claude Code Autonomous Execution Prompt

You are executing the **Vibe T&B Retainer Addendum Build Plan** against the existing `vibe-time-billing` repository. This is an addendum, not a rebuild — extend existing T&B code, do not replace it.

---

## §1 Repository context (read before doing anything else)

Run these commands first, in order, and record what you find in `RUN_LOG.md`:

```bash
cat CLAUDE.md                            # repo-level instructions
cat README.md                            # repo overview
ls db/migrations/ | tail -20             # latest migration numbers
cat db/schema/index.ts                   # current schema barrel
cat package.json | grep -E '"(name|version|scripts)"' -A 30
ls src/services/ | head -50              # existing service modules
ls src/routes/ | head -50                # existing routes
ls src/jobs/ | head -50                  # existing BullMQ jobs
cat .env.example | grep VIBETB_          # existing env contract
```

If any of those produce unexpected output (missing files, different directory layout, different ORM/stack version), STOP and write a Q1 entry in `QUESTIONS.md` before proceeding.

Then read the addendum build plan in full:

```bash
cat VIBE_TB_RETAINER_ADDENDUM_BUILD_PLAN.md
```

The build plan's §0.1 Fallback Hierarchy and §0.2 Locked Decisions are the authoritative source of business rules. Do not invent rules outside that document.

---

## §2 Execution mode

**Mode:** Phase-by-phase, sequential, with checkpointing after each phase.

For each phase:

1. Re-read the phase's checklist from `VIBE_TB_RETAINER_ADDENDUM_BUILD_PLAN.md`
2. Create a working branch: `git checkout -b retainer-addendum/phase-{N}-{slug}`
3. Implement every checklist item in order
4. Tick the checklist (rewrite the markdown file with `- [x]`) as you complete each item
5. Run the phase's test suite: `pnpm test -- --filter retainers`
6. Run `pnpm typecheck` and `pnpm lint` — must pass with zero errors
7. Commit incrementally with messages: `feat(retainers): phase N - {item description}`
8. At end of phase, write a `PHASE_{N}_SUMMARY.md` covering: what was built, deviations from plan, open follow-ups, test results
9. STOP and append to `CHECKPOINTS.md`:

```
## Phase {N} complete — {YYYY-MM-DD HH:MM}
- Files changed: {count}
- Tests added: {count}
- Tests passing: {n/m}
- Typecheck: pass/fail
- Lint: pass/fail
- Open questions: {ref QUESTIONS.md entries, or "none"}
- Ready for review: yes/no
```

Then wait for human review before opening the next phase, unless `AUTONOMOUS_MODE=full` is set (see §6).

---

## §3 Coding conventions (Vibe family — non-negotiable)

- **Language:** TypeScript strict mode, no `any`, no `@ts-ignore`
- **Monetary values:** `BIGINT` cents at DB and service layer; format for display only at UI boundary
- **Time values:** `numeric(8,2)` decimal hours at DB; `number` at service layer
- **IDs:** UUIDv4 only (`uuid` Postgres type, `crypto.randomUUID()` in code)
- **Timestamps:** `timestamp with time zone`, always UTC at DB, render in user TZ at UI
- **Migrations:** Drizzle, one per phase max, always include rollback
- **Errors:** Canonical Vibe error format:
  ```ts
  { code: 'VIBETB_RETAINER_ERR_{CASE}', message: string, retryable: boolean, details?: object }
  ```
- **Transactions:** Any multi-table write goes through `db.transaction(async (trx) => …)` — no exceptions
- **Race-sensitive reads:** Use `SELECT ... FOR UPDATE` on the retainer row inside the consumption transaction
- **Logging:** Pino, structured fields, never log PII or full client names at `info` level — use `client_id`
- **Tests:** Vitest for unit + service, Playwright for E2E. Every service function gets at least one happy-path and one failure-path test. Every UI page gets at least one Playwright smoke test.
- **API contracts:** Zod schemas at controller boundaries, exported types consumed by frontend
- **Component library:** Existing Vibe shadcn/ui components — do not introduce new UI dependencies
- **Env vars:** Prefix `VIBETB_RETAINER_` for any new vars; document each in `.env.example`
- **License headers:** New files get the standard Vibe PolyForm Internal Use 1.0.0 header
- **Docker:** No new base images; ride on existing distroless multi-stage build
- **No comments** except (a) JSDoc on exported functions, (b) explaining non-obvious business rules with `// D{N}` referencing the locked decision number

---

## §4 QUESTIONS.md protocol

If — and only if — you encounter an ambiguity that the §0.1 fallback hierarchy and §0.2 locked decisions do not resolve:

1. STOP the current task
2. Append a new entry to `QUESTIONS.md` in this exact format:

```markdown
## Q{NN} — Phase {N} — {Short title}

**Date:** {YYYY-MM-DD HH:MM}
**Context:** {what you were doing, file paths involved}
**Ambiguity:** {what specifically is unclear}
**Options considered:**

- A: {option with consequences}
- B: {option with consequences}
- C: {option with consequences}
  **Recommendation:** {your best guess if forced to pick, and why}
  **Blocker:** yes/no
  **Workaround if non-blocking:** {what you'll do in the meantime}
```

3. If `Blocker: yes`, halt the phase entirely and wait. If `Blocker: no`, proceed with your recommendation and mark the implementation site with `// TODO(Q{NN}): {brief}` so a reviewer can find it.

**Do not invent business rules.** Trivial implementation details (variable names, file organization within a service module, log level for a debug message) are not questions — use your judgment. Anything touching pricing, eligibility, expiry, ledger semantics, or money is a question.

---

## §5 Forbidden patterns

Do not, under any circumstance:

- Introduce `pypdf`, `PyMuPDF`, or any AGPL dependency
- Add `npm install` of any package not already approved in `package.json` without writing a Q entry first
- Modify the existing `time_entries` table beyond the three documented column additions (`retainer_id`, `retainer_hours`, `billable_hours`)
- Modify existing T&B invoice generation logic beyond the documented hook in Phase 3
- Hardcode tier prices, hours, or service codes anywhere — all of those come from `retainer_tier_configs`
- Skip the `SELECT FOR UPDATE` in consumption logic
- Allow `hours_consumed > hours_purchased` (DB CHECK constraint enforces this; do not bypass)
- Implement a tier upgrade flow (D19: out of scope for v1)
- Implement retroactive `extended_due_date` editing UI (D23: frozen at retainer creation)
- Recognize revenue on any basis other than cash at purchase date (D5)
- Add reasoning models to this build — Vibe family is non-reasoning-model only for tax/financial work
- Log full SSN, EIN, bank account, or routing numbers anywhere
- Commit secrets, `.env` files, or production credentials

---

## §6 Autonomy mode

Three settings, controlled by environment variable `VIBETB_RETAINER_AUTONOMY`:

- **`step`** (default): Halt after each phase, write checkpoint, wait for human "continue"
- **`phase`**: Halt only on QUESTIONS.md blocker or test failure; otherwise proceed to next phase
- **`full`**: Halt only on QUESTIONS.md blocker, test failure, or typecheck/lint failure. Implies a single PR at the end. Use only with explicit human authorization captured in `RUN_LOG.md`.

Read the env var at startup, log the mode chosen, and respect it for the whole run.

---

## §7 PR and commit hygiene

- Branch naming: `retainer-addendum/phase-{N}-{slug}`
- Commit messages: Conventional Commits, scope `(retainers)`, e.g. `feat(retainers): phase 3 - offer creation hook`
- One PR per phase by default. In `full` autonomy, one PR for the whole addendum with phase commits clearly separated
- PR description template:

```markdown
## Phase {N} — {Phase Title}

### What

{2-3 sentence summary}

### Locked decisions touched

{list D{NN} references}

### New tables / columns

{schema delta}

### New routes

{route list}

### Tests

- Unit: {n} added
- E2E: {n} added
- All passing: yes/no

### Open questions

{ref QUESTIONS.md or "none"}

### Reviewer checklist

- [ ] Phase checklist in build plan all ticked
- [ ] Decisions D{NN} not violated
- [ ] No forbidden patterns from §5
- [ ] CHECKPOINTS.md updated
```

---

## §8 Test data requirements

Before Phase 3, seed dev fixtures that the rest of the build depends on:

- One firm with retainer settings enabled
- Tier configs for `1040` and `1120` (both Tier 1 and Tier 2)
- Eligible service codes: `TAX-NOTICE`, `IRS-EXAM`, `AUDIT-DEFENSE`, `STATE-NOTICE`, `AMENDED-RETURN`
- Prep-fee service codes: `TAX-PREP-FED`, `TAX-PREP-STATE`, `TAX-PREP-K1`
- Non-prep service code: `ADVISORY` (used in tests to verify it does NOT contribute to basis)
- One special service code: `RETAINER` (the line item used on retainer purchase invoices)
- Two test clients with one engagement each, one with `extended_due_date` set, one without

Add a seed script `scripts/seed-retainer-fixtures.ts` that idempotently populates these.

---

## §9 Performance targets

- KPI strip endpoint: < 200ms P95 for a firm with up to 5,000 retainers
- Auto-split logic: < 50ms P95 per time entry
- Expiry sweep job: < 30s for a firm with up to 10,000 retainers
- Portal offer page: < 800ms LCP on a cold cache

If you cannot meet a target, add an index, denormalize, or write a Q entry — do not ship a slow path silently.

---

## §10 Success criteria (the human will verify these)

When you report the build complete, all of the following must be true:

1. All 14 phases in `VIBE_TB_RETAINER_ADDENDUM_BUILD_PLAN.md` show every checklist item ticked
2. `pnpm test` passes with zero failures and the new test count is at least 80 across unit + E2E
3. `pnpm typecheck` and `pnpm lint` pass with zero errors and zero warnings on new files
4. `QUESTIONS.md` has no entries with `Blocker: yes` still unresolved
5. The 12-step acceptance walkthrough at the bottom of the build plan executes end-to-end successfully against a fresh local stack (Postgres + Redis + app)
6. `CHECKPOINTS.md` shows a clean record for every phase
7. `.env.example` documents every new `VIBETB_RETAINER_` variable
8. Migration up + down both succeed against a fresh database
9. No forbidden patterns from §5 appear in the diff
10. Locked decisions D1–D24 are each referenced at least once in code comments (`// D{N}: …`) at the site they govern

---

## §11 Starting instruction

Read this entire prompt. Then read `VIBE_TB_RETAINER_ADDENDUM_BUILD_PLAN.md` in full. Then read `CLAUDE.md` in the repo. Then announce in your first response:

```
Vibe T&B Retainer Addendum — Build Start
Autonomy mode: {mode}
Repo state: {clean / dirty}
Existing migrations: {latest number}
Open questions: {count from QUESTIONS.md}
Beginning Phase 1: Schema migration & seed data
```

Then start Phase 1. Do not ask the human for permission to begin — the existence of this prompt is the authorization.

If at any point you are uncertain whether to proceed, default to writing a `QUESTIONS.md` entry rather than guessing. The cost of a one-hour pause for a human answer is far less than the cost of a wrong retainer business rule shipped to production.

Good luck. Build it cleanly.
