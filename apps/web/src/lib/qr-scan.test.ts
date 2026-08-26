// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import { extractUuid } from './qr-scan';

const UUID = '4f9c2a10-7b3d-4e21-9c5f-8a6b1d2e3f40';

describe('extractUuid', () => {
  it('accepts a bare uuid', () => {
    expect(extractUuid(UUID)).toBe(UUID);
  });

  it('accepts a uuid embedded in a URL', () => {
    expect(extractUuid(`https://app.example.com/clients/${UUID}?tab=files`)).toBe(UUID);
  });

  it('lowercases an uppercase uuid', () => {
    expect(extractUuid(UUID.toUpperCase())).toBe(UUID);
  });

  it('returns the first uuid when several are present', () => {
    const other = '00000000-1111-2222-3333-444444444444';
    expect(extractUuid(`${UUID} ${other}`)).toBe(UUID);
  });

  it('rejects payloads without a uuid', () => {
    expect(extractUuid('')).toBeNull();
    expect(extractUuid('hello world')).toBeNull();
    expect(extractUuid('4f9c2a10-7b3d-4e21-9c5f')).toBeNull(); // truncated
  });
});
