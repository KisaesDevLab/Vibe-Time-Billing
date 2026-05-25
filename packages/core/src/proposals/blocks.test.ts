// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0

import { describe, expect, it } from 'vitest';

import {
  addBlock,
  BlockValidationError,
  duplicateBlock,
  EMPTY_BLOCK_TREE,
  isBlock,
  isBlockTree,
  moveBlock,
  removeBlock,
  reorderBlocks,
  updateBlock,
  validateTree,
  type BlockTypeValidator,
  type ProposalBlock,
} from './blocks';

function block(id: string, type = 'text', props: Record<string, unknown> = {}): ProposalBlock {
  return { id, type, position: 0, props };
}

describe('block tree shape', () => {
  it('EMPTY_BLOCK_TREE passes isBlockTree', () => {
    expect(isBlockTree(EMPTY_BLOCK_TREE)).toBe(true);
  });
  it('rejects wrong schemaVersion', () => {
    expect(isBlockTree({ schemaVersion: 2, blocks: [] })).toBe(false);
  });
  it('rejects non-array blocks', () => {
    expect(isBlockTree({ schemaVersion: 1, blocks: 'no' })).toBe(false);
  });
  it('isBlock requires id + type + props', () => {
    expect(isBlock({ id: 'a', type: 't', position: 0, props: {} })).toBe(true);
    expect(isBlock({ id: '', type: 't', position: 0, props: {} })).toBe(false);
    expect(isBlock({ id: 'a', type: 't', position: 0, props: [] })).toBe(false);
  });
});

describe('add / remove / update', () => {
  it('add appends and re-sequences positions', () => {
    let t = EMPTY_BLOCK_TREE;
    t = addBlock(t, block('a'));
    t = addBlock(t, block('b'));
    t = addBlock(t, block('c'));
    expect(t.blocks.map((b) => [b.id, b.position])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
  });

  it('remove collapses positions', () => {
    let t = EMPTY_BLOCK_TREE;
    t = addBlock(t, block('a'));
    t = addBlock(t, block('b'));
    t = addBlock(t, block('c'));
    t = removeBlock(t, 'b');
    expect(t.blocks.map((b) => [b.id, b.position])).toEqual([
      ['a', 0],
      ['c', 1],
    ]);
  });

  it('update merges props without losing id', () => {
    let t = addBlock(EMPTY_BLOCK_TREE, block('a', 'text', { md: 'hello' }));
    t = updateBlock(t, 'a', { props: { md: 'world' } });
    expect(t.blocks[0]!.props['md']).toBe('world');
    expect(t.blocks[0]!.id).toBe('a');
  });
});

describe('move / reorder', () => {
  it('moveBlock up/down swaps adjacent', () => {
    let t = EMPTY_BLOCK_TREE;
    t = addBlock(t, block('a'));
    t = addBlock(t, block('b'));
    t = addBlock(t, block('c'));
    t = moveBlock(t, 'c', 'up');
    expect(t.blocks.map((b) => b.id)).toEqual(['a', 'c', 'b']);
    t = moveBlock(t, 'a', 'down');
    expect(t.blocks.map((b) => b.id)).toEqual(['c', 'a', 'b']);
  });

  it('moveBlock no-op at edges', () => {
    let t = EMPTY_BLOCK_TREE;
    t = addBlock(t, block('a'));
    t = addBlock(t, block('b'));
    const same = moveBlock(t, 'a', 'up'); // already at top
    expect(same.blocks.map((b) => b.id)).toEqual(['a', 'b']);
    const same2 = moveBlock(t, 'b', 'down'); // already at bottom
    expect(same2.blocks.map((b) => b.id)).toEqual(['a', 'b']);
  });

  it('reorderBlocks moves by index', () => {
    let t = EMPTY_BLOCK_TREE;
    t = addBlock(t, block('a'));
    t = addBlock(t, block('b'));
    t = addBlock(t, block('c'));
    t = addBlock(t, block('d'));
    t = reorderBlocks(t, 3, 0); // d → front
    expect(t.blocks.map((b) => b.id)).toEqual(['d', 'a', 'b', 'c']);
  });
});

describe('duplicate', () => {
  it('inserts a deep copy after the source with the supplied id', () => {
    let t = addBlock(EMPTY_BLOCK_TREE, block('a', 'text', { md: 'hi' }));
    t = duplicateBlock(t, 'a', 'a-2');
    expect(t.blocks.map((b) => b.id)).toEqual(['a', 'a-2']);
    // Mutating the copy must not affect the original.
    const copy = t.blocks.find((b) => b.id === 'a-2');
    (copy!.props as Record<string, unknown>)['md'] = 'changed';
    const orig = t.blocks.find((b) => b.id === 'a');
    expect(orig!.props['md']).toBe('hi');
  });
});

describe('validateTree', () => {
  const passing: BlockTypeValidator = {
    type: 'text',
    validate(props) {
      if (typeof props['md'] !== 'string') {
        throw new BlockValidationError('', 'text', 'invalid_props', 'md must be string');
      }
    },
  };
  const validators = new Map<string, BlockTypeValidator>([['text', passing]]);

  it('reports unknown_type for missing validator', () => {
    const tree = addBlock(EMPTY_BLOCK_TREE, block('a', 'unregistered'));
    const errs = validateTree(tree, validators);
    expect(errs.length).toBe(1);
    expect(errs[0]!.code).toBe('unknown_type');
  });

  it('passes when validator is happy', () => {
    const tree = addBlock(EMPTY_BLOCK_TREE, block('a', 'text', { md: 'ok' }));
    expect(validateTree(tree, validators)).toEqual([]);
  });

  it('surfaces validator errors', () => {
    const tree = addBlock(EMPTY_BLOCK_TREE, block('a', 'text', { md: 123 }));
    const errs = validateTree(tree, validators);
    expect(errs.length).toBe(1);
    expect(errs[0]!.code).toBe('invalid_props');
    expect(errs[0]!.message).toMatch(/md must be string/);
  });
});
