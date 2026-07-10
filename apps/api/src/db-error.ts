// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Extract a PostgreSQL error code (e.g. '23505' unique_violation, '23514'
// check_violation) from a thrown database error.
//
// drizzle-orm >= 0.31 wraps failed queries in a `DrizzleQueryError` whose
// `.cause` holds the original driver error (postgres-js `PostgresError`)
// that carries the `.code`. Older versions threw the driver error
// directly. This walks the `cause` chain so callers behave the same
// regardless of whether the error is wrapped — do NOT read `err.code`
// directly, or unique-violation handling silently breaks (409 → 500)
// under the wrapped error.
export function pgErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur != null; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}
