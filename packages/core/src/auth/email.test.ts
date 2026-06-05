// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { describe, expect, it } from 'vitest';

import { normalizeEmail } from './email';

describe('normalizeEmail', () => {
  it('trims and lowercases valid addresses', () => {
    expect(normalizeEmail('  Jane.Doe@Example.COM ')).toBe('jane.doe@example.com');
  });
  it('rejects invalid or empty input', () => {
    expect(normalizeEmail('not-an-email')).toBeNull();
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail('a@b')).toBeNull();
  });
});
