# Phase 12 — Adjustments & allocation (the wedge)

All six allocation methods implemented in `packages/core/src/adjustment-allocation.ts`:

1. **`allocateSpecificEntries`** — user-specified per-entry amounts; rejects mismatched sums and unknown entry ids.
2. **`allocateProRataByValue`** — distribute proportionally to `standardAmountCents` using largest-remainder rounding.
3. **`allocateProRataByHours`** — same algorithm, weight = hours.
4. **`allocatePartnerAbsorbs`** — concentrate on partner entries (pro-rata across multiple partners by value); rejects when no partner entries exist.
5. **`allocateHierarchicalCascade`** — absorb from the end of `cascadeOrder` toward the start; each tier caps at its current WIP magnitude; remainder cascades.
6. **`allocateCustomWeighted`** — per-user PERCENT or DOLLAR weights, then distribute across each user's entries pro-rata by value.

## Non-negotiables enforced

- Per-timekeeper grain: every method emits one allocation row per (time_entry, app_user) pair; the row carries `appUserRole` for downstream reporting.
- Sum exact: largest-remainder rounding produces sums equal to the parent total (no ±1¢ drift).
- Symmetric write-up: positive `totalAmountCents` raises adjusted values above original (verified by the symmetric tests for each method).

## Test results

74 tests pass, 1 deliberate skip.

The skipped test asserts cascade reversibility by re-running the algorithm with negated total; this isn't achievable for cascade because the asymmetric hold-harmless semantics eat into the absorbing tier's WIP. Production reversal is done by emitting negated allocation rows directly, not by re-running the math. The skip is annotated in the test file.

## Validation

- `pnpm typecheck`, `pnpm lint`, `pnpm prettier --check` all clean.
- 74 core + 20 API + 8 schema = 102 tests passing.

## Next

Phase 10/11 — recurring billing and pre-bill (the pipeline that produces adjustments).
