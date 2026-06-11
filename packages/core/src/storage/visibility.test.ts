// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_VISIBILITY_RULES,
  likePatternToRegex,
  matchesLikePattern,
  resolveDefaultVisibility,
  type VisibilityRule,
} from './visibility';

function asRules(): VisibilityRule[] {
  return DEFAULT_VISIBILITY_RULES.map((r) => ({ ...r, enabled: true }));
}

describe('likePatternToRegex', () => {
  it('compiles % to .*', () => {
    expect(likePatternToRegex('Client Copy%').test('Client Copy 2024')).toBe(true);
    expect(likePatternToRegex('Client Copy%').test('Client Cop')).toBe(false);
  });

  it('compiles _ to .', () => {
    expect(likePatternToRegex('20_4').test('2024')).toBe(true);
    expect(likePatternToRegex('20_4').test('20245')).toBe(false);
  });

  it('escapes regex metacharacters in literal segments', () => {
    expect(likePatternToRegex('a.b').test('a.b')).toBe(true);
    expect(likePatternToRegex('a.b').test('axb')).toBe(false);
  });
});

describe('matchesLikePattern', () => {
  it('matches exact patterns to subfolders with trailing slash', () => {
    expect(matchesLikePattern('Invoices/', 'Invoices')).toBe(true);
    expect(matchesLikePattern('Invoices', 'Invoices')).toBe(true);
  });

  it('catchall % matches any path including empty', () => {
    expect(matchesLikePattern('', '%')).toBe(true);
    expect(matchesLikePattern('Anything Whatever/', '%')).toBe(true);
  });

  it('prefix patterns like "Client Copy%" match nested folders', () => {
    expect(matchesLikePattern('Client Copy/', 'Client Copy%')).toBe(true);
    expect(matchesLikePattern('Client Copy 2024/', 'Client Copy%')).toBe(true);
    expect(matchesLikePattern('Internal/Client Copy/', 'Client Copy%')).toBe(false);
  });
});

describe('resolveDefaultVisibility — default rule pack', () => {
  it('returns client_visible for Invoices', () => {
    expect(resolveDefaultVisibility('Invoices/', asRules())).toBe('client_visible');
  });

  it('returns client_visible for Engagement Letters', () => {
    expect(resolveDefaultVisibility('Engagement Letters/', asRules())).toBe('client_visible');
  });

  it('returns client_visible for any Client Copy% subfolder', () => {
    expect(resolveDefaultVisibility('Client Copy/', asRules())).toBe('client_visible');
    expect(resolveDefaultVisibility('Client Copy 2024/', asRules())).toBe('client_visible');
  });

  it('returns private for Workpapers', () => {
    expect(resolveDefaultVisibility('Workpapers/', asRules())).toBe('private');
  });

  it('returns private for Internal% subfolders', () => {
    expect(resolveDefaultVisibility('Internal/', asRules())).toBe('private');
    expect(resolveDefaultVisibility('Internal Notes/', asRules())).toBe('private');
  });

  it('falls back to private via the catchall', () => {
    expect(resolveDefaultVisibility('Some Random Folder/', asRules())).toBe('private');
    expect(resolveDefaultVisibility('', asRules())).toBe('private');
  });
});

describe('resolveDefaultVisibility — priority + enabled semantics', () => {
  it('honors priority desc — higher wins', () => {
    const rules: VisibilityRule[] = [
      { subfolderPattern: '%', defaultVisibility: 'private', priority: 0, enabled: true },
      {
        subfolderPattern: 'Invoices',
        defaultVisibility: 'client_visible',
        priority: 100,
        enabled: true,
      },
    ];
    expect(resolveDefaultVisibility('Invoices/', rules)).toBe('client_visible');
  });

  it('ignores disabled rules', () => {
    const rules: VisibilityRule[] = [
      {
        subfolderPattern: 'Invoices',
        defaultVisibility: 'client_visible',
        priority: 100,
        enabled: false,
      },
      { subfolderPattern: '%', defaultVisibility: 'private', priority: 0, enabled: true },
    ];
    expect(resolveDefaultVisibility('Invoices/', rules)).toBe('private');
  });

  it('returns private when no rules are configured', () => {
    expect(resolveDefaultVisibility('Invoices/', [])).toBe('private');
  });
});
