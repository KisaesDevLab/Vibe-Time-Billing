// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0

import { describe, expect, it } from 'vitest';

import { canonicalize, contentHash, sha256Hex } from './canonical-json';

describe('canonical JSON', () => {
  it('sorts object keys lexicographically', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });

  it('produces identical output regardless of input order', () => {
    const a = { id: '1', props: { md: 'hi', alt: 'x' }, type: 't' };
    const b = { type: 't', props: { alt: 'x', md: 'hi' }, id: '1' };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('preserves array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('emits compact JSON with no whitespace', () => {
    expect(canonicalize({ a: [1, 2], b: { c: 'x' } })).toBe('{"a":[1,2],"b":{"c":"x"}}');
  });

  it('drops undefined values inside objects', () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('preserves nulls', () => {
    expect(canonicalize({ a: null })).toBe('{"a":null}');
  });

  it('handles unicode safely', () => {
    expect(canonicalize({ name: 'Café — 山' })).toBe('{"name":"Café — 山"}');
  });

  it('throws on BigInt', () => {
    expect(() => canonicalize({ n: BigInt(1) })).toThrow();
  });
});

describe('sha256Hex', () => {
  it('hashes the empty string to the canonical value', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('hashes "abc" to the canonical value', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('contentHash', () => {
  it('is stable across key order', () => {
    const a = { b: 1, a: 2 };
    const b = { a: 2, b: 1 };
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it('changes when content changes', () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });

  it('returns a 64-char lowercase hex string', () => {
    expect(contentHash({ x: 1 })).toMatch(/^[a-f0-9]{64}$/);
  });
});
