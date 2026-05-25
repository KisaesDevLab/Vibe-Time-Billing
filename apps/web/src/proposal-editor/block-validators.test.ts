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

describe('P05 block validators — markdown', () => {
  it('empty string is allowed', () => {
    const t = addBlock(EMPTY_BLOCK_TREE, block('a', 'markdown', { md: '' }));
    expect(validateTree(t, VALIDATORS)).toEqual([]);
  });
  it('non-string md fails', () => {
    const t = addBlock(EMPTY_BLOCK_TREE, block('a', 'markdown', { md: 123 }));
    expect(validateTree(t, VALIDATORS)[0]!.code).toBe('invalid_props');
  });
});

describe('P05 block validators — heading', () => {
  it('empty text fails empty_heading', () => {
    const t = addBlock(EMPTY_BLOCK_TREE, block('a', 'heading', { text: '   ', level: 1 }));
    expect(validateTree(t, VALIDATORS)[0]!.code).toBe('empty_heading');
  });
  it('invalid level fails invalid_level', () => {
    const t = addBlock(EMPTY_BLOCK_TREE, block('a', 'heading', { text: 'X', level: 4 }));
    expect(validateTree(t, VALIDATORS)[0]!.code).toBe('invalid_level');
  });
});

describe('P05 block validators — cover', () => {
  it('passes with title', () => {
    const t = addBlock(
      EMPTY_BLOCK_TREE,
      block('a', 'cover', { title: 'Hi', subtitle: '', heroImageUrl: '', firmLogoUrl: '' }),
    );
    expect(validateTree(t, VALIDATORS)).toEqual([]);
  });
  it('empty title fails empty_title', () => {
    const t = addBlock(EMPTY_BLOCK_TREE, block('a', 'cover', { title: '   ' }));
    expect(validateTree(t, VALIDATORS)[0]!.code).toBe('empty_title');
  });
});

describe('P05 block validators — video', () => {
  it('empty draft is allowed', () => {
    const t = addBlock(EMPTY_BLOCK_TREE, block('a', 'video', { url: '' }));
    expect(validateTree(t, VALIDATORS)).toEqual([]);
  });
  it('unrecognized url fails', () => {
    const t = addBlock(EMPTY_BLOCK_TREE, block('a', 'video', { url: 'https://example.com/x' }));
    expect(validateTree(t, VALIDATORS)[0]!.code).toBe('unrecognized_video_url');
  });
  it('YouTube watch URL passes', () => {
    const t = addBlock(
      EMPTY_BLOCK_TREE,
      block('a', 'video', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }),
    );
    expect(validateTree(t, VALIDATORS)).toEqual([]);
  });
});

describe('P05 block validators — services_list', () => {
  it('empty array fails empty_list', () => {
    const t = addBlock(EMPTY_BLOCK_TREE, block('a', 'services_list', { serviceIds: [] }));
    expect(validateTree(t, VALIDATORS)[0]!.code).toBe('empty_list');
  });
  it('non-array fails invalid_props', () => {
    const t = addBlock(EMPTY_BLOCK_TREE, block('a', 'services_list', { serviceIds: 'no' }));
    expect(validateTree(t, VALIDATORS)[0]!.code).toBe('invalid_props');
  });
  it('non-empty array passes', () => {
    const t = addBlock(
      EMPTY_BLOCK_TREE,
      block('a', 'services_list', { serviceIds: ['svc-1', 'svc-2'] }),
    );
    expect(validateTree(t, VALIDATORS)).toEqual([]);
  });
});

describe('P05 block validators — package_selector', () => {
  it('empty packageName fails no_package', () => {
    const t = addBlock(EMPTY_BLOCK_TREE, block('a', 'package_selector', { packageName: '' }));
    expect(validateTree(t, VALIDATORS)[0]!.code).toBe('no_package');
  });
  it('set packageName passes', () => {
    const t = addBlock(
      EMPTY_BLOCK_TREE,
      block('a', 'package_selector', { packageName: 'Small Biz Tax' }),
    );
    expect(validateTree(t, VALIDATORS)).toEqual([]);
  });
});

describe('P05 block validators — terms', () => {
  it('empty id fails no_template', () => {
    const t = addBlock(EMPTY_BLOCK_TREE, block('a', 'terms', { termsTemplateId: '' }));
    expect(validateTree(t, VALIDATORS)[0]!.code).toBe('no_template');
  });
});

describe('P05 block validators — signature', () => {
  it('empty label fails empty_label', () => {
    const t = addBlock(
      EMPTY_BLOCK_TREE,
      block('a', 'signature', { label: '', acceptanceCopy: 'I agree' }),
    );
    expect(validateTree(t, VALIDATORS)[0]!.code).toBe('empty_label');
  });
  it('empty acceptanceCopy fails empty_copy', () => {
    const t = addBlock(
      EMPTY_BLOCK_TREE,
      block('a', 'signature', { label: 'Sign here', acceptanceCopy: '' }),
    );
    expect(validateTree(t, VALIDATORS)[0]!.code).toBe('empty_copy');
  });
  it('full props pass', () => {
    const t = addBlock(
      EMPTY_BLOCK_TREE,
      block('a', 'signature', { label: 'Sign here', acceptanceCopy: 'I agree' }),
    );
    expect(validateTree(t, VALIDATORS)).toEqual([]);
  });
});

describe('P05 block validators — divider + unknown', () => {
  it('divider with no props passes', () => {
    const t = addBlock(EMPTY_BLOCK_TREE, block('a', 'divider', {}));
    expect(validateTree(t, VALIDATORS)).toEqual([]);
  });
  it('unknown type reports unknown_type', () => {
    const t = addBlock(EMPTY_BLOCK_TREE, block('a', 'mystery', {}));
    expect(validateTree(t, VALIDATORS)[0]!.code).toBe('unknown_type');
  });
});
