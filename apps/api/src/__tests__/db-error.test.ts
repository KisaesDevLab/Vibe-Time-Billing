// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Regression guard for the drizzle-orm 0.31+ error-wrapping behavior.
// A failed query is wrapped in a DrizzleQueryError whose `.cause` holds
// the original driver error carrying the pg `.code`. pgErrorCode must walk
// that chain so unique/check-violation handling (409 responses) keeps
// working. Reading `err.code` directly would regress 409 → 500.

import { describe, expect, it } from 'vitest';

import { pgErrorCode } from '../db-error';

describe('pgErrorCode', () => {
  it('reads the code off a bare driver error', () => {
    expect(pgErrorCode({ code: '23505' })).toBe('23505');
  });

  it('reads the code off a wrapped DrizzleQueryError (code on .cause)', () => {
    const wrapped = Object.assign(new Error('Failed query: INSERT INTO …'), {
      cause: Object.assign(new Error('duplicate key value'), { code: '23505' }),
    });
    expect(pgErrorCode(wrapped)).toBe('23505');
  });

  it('walks a multi-level cause chain', () => {
    const inner = Object.assign(new Error('check_violation'), { code: '23514' });
    const mid = Object.assign(new Error('mid'), { cause: inner });
    const outer = Object.assign(new Error('outer'), { cause: mid });
    expect(pgErrorCode(outer)).toBe('23514');
  });

  it('returns undefined when no code is present', () => {
    expect(pgErrorCode(new Error('boom'))).toBeUndefined();
    expect(pgErrorCode(null)).toBeUndefined();
    expect(pgErrorCode(undefined)).toBeUndefined();
  });
});
