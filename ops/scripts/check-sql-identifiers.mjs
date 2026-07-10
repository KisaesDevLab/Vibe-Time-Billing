#!/usr/bin/env node
// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// SQL-identifier safety guard (security follow-up to the drizzle-orm
// 0.45 upgrade / advisory GHSA-gpj5-g38j-94v9 / CVE-2026-39356).
//
// drizzle-orm >= 0.45.2 escapes quoted identifiers correctly, so the
// library-level hole is closed. This guard is defense-in-depth against
// the *pattern* that made the advisory exploitable: building a SQL
// identifier / alias / raw fragment from request-controlled input
// (dynamic sort columns, report builders, CTE/alias names from params).
//
// Rule: `sql.identifier(` and `sql.raw(` must not appear in the API
// request-handling code under apps/api/src (excluding __tests__). Today
// there are zero such uses there — every existing sql.raw lives in worker
// jobs, seed/migration scripts, or tests, none on a request path. This is
// therefore a clean tripwire: if a future request handler introduces one,
// this fails so a human confirms the identifier can never be attacker-
// controlled (and, if legitimate, adds an explicit allowlist entry here).
//
// Deliberately simple (grep, not AST). It does not try to prove taint; it
// forces review of the one construct that can reintroduce the class of bug.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const SCAN_DIR = join(ROOT, 'apps', 'api', 'src');
const PATTERN = /\bsql\.(identifier|raw)\s*\(/;

// Files where a raw/identifier construct is reviewed-and-safe. Keep this
// list SHORT and justify every entry — an entry here is a promise that the
// identifier is a compile-time constant, never request input.
const ALLOWLIST = new Set([
  // (empty) — no request-path raw-identifier usage exists today.
]);

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue;
      out.push(...walk(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

const offenders = [];
for (const file of walk(SCAN_DIR)) {
  const rel = file.slice(ROOT.length + 1);
  if (ALLOWLIST.has(rel)) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (PATTERN.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
  });
}

if (offenders.length > 0) {
  console.error(
    'SQL-identifier guard: sql.identifier()/sql.raw() found in API request code.\n' +
      'Building a SQL identifier from request input can reintroduce SQL injection\n' +
      '(GHSA-gpj5-g38j-94v9). Confirm the value is a compile-time constant; if so,\n' +
      'add the file to the ALLOWLIST in ops/scripts/check-sql-identifiers.mjs with a\n' +
      'justification. Offenders:\n',
  );
  for (const o of offenders) console.error('  ' + o);
  process.exit(1);
}

console.log('SQL-identifier guard: OK (no raw identifier construction in API request code).');
