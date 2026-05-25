// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0

import { describe, expect, it } from 'vitest';

import { validateTree, addBlock, EMPTY_BLOCK_TREE } from '@vibe/core/proposals';

import { VALIDATORS } from './block-validators';

function block(
  id: string,
  type: string,
  props: Record<string, unknown>,
): {
  id: string;
  type: string;
  position: number;
  props: Record<string, unknown>;
} {
  return { id, type, position: 0, props };
}

describe('PP4b block validators', () => {
  it('text — empty string is allowed', () => {
    const t = addBlock(EMPTY_BLOCK_TREE, block('a', 'text', { md: '' }));
    expect(validateTree(t, VALIDATORS)).toEqual([]);
  });

  it('text — non-string md fails', () => {
    const t = addBlock(EMPTY_BLOCK_TREE, block('a', 'text', { md: 123 }));
    const errs = validateTree(t, VALIDATORS);
    expect(errs.length).toBe(1);
    expect(errs[0]!.code).toBe('invalid_props');
  });

  it('heading — empty text fails empty_heading', () => {
    const t = addBlock(EMPTY_BLOCK_TREE, block('a', 'heading', { text: '   ', level: 1 }));
    const errs = validateTree(t, VALIDATORS);
    expect(errs[0]!.code).toBe('empty_heading');
  });

  it('heading — invalid level fails invalid_level', () => {
    const t = addBlock(EMPTY_BLOCK_TREE, block('a', 'heading', { text: 'X', level: 4 }));
    const errs = validateTree(t, VALIDATORS);
    expect(errs[0]!.code).toBe('invalid_level');
  });

  it('divider — no props always passes', () => {
    const t = addBlock(EMPTY_BLOCK_TREE, block('a', 'divider', {}));
    expect(validateTree(t, VALIDATORS)).toEqual([]);
  });

  it('unknown type reports unknown_type', () => {
    const t = addBlock(EMPTY_BLOCK_TREE, block('a', 'mystery', {}));
    const errs = validateTree(t, VALIDATORS);
    expect(errs[0]!.code).toBe('unknown_type');
  });
});
