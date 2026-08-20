// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0

import { describe, expect, it } from 'vitest';

import { resolveMergeTokens } from './merge-tokens';

describe('merge token resolver', () => {
  it('resolves nested paths', () => {
    const r = resolveMergeTokens('Hello {{ client.name }}, from {{ firm.name }}', {
      client: { name: 'Acme Co' },
      firm: { name: 'Smith CPAs' },
    });
    expect(r.output).toBe('Hello Acme Co, from Smith CPAs');
    expect(r.unresolvedTokens).toEqual([]);
  });

  it('handles scalar today token', () => {
    const r = resolveMergeTokens('Date: {{today}}', { today: '2026-05-25' });
    expect(r.output).toBe('Date: 2026-05-25');
  });

  it('tolerates whitespace inside braces', () => {
    const r = resolveMergeTokens('{{  client.name  }}', { client: { name: 'X' } });
    expect(r.output).toBe('X');
  });

  it('renders unresolved tokens as empty string and reports them', () => {
    const r = resolveMergeTokens('Hi {{client.unknown}} and {{firm.name}}', {
      client: { name: 'X' },
      firm: { name: 'Y' },
    });
    expect(r.output).toBe('Hi  and Y');
    expect(r.unresolvedTokens).toEqual(['client.unknown']);
  });

  it('treats missing scopes as unresolved', () => {
    const r = resolveMergeTokens('Hi {{ engagement.name }}', { client: { name: 'X' } });
    expect(r.unresolvedTokens).toEqual(['engagement.name']);
    expect(r.output).toBe('Hi ');
  });

  it('does not match malformed tokens', () => {
    const input = '{{}} {{ . }} {{ 1abc }} {{ client. }} normal {{client.name}}';
    const r = resolveMergeTokens(input, { client: { name: 'X' } });
    expect(r.output).toBe('{{}} {{ . }} {{ 1abc }} {{ client. }} normal X');
  });

  it('coerces non-string scalar values', () => {
    const r = resolveMergeTokens('Year {{engagement.tax_year}} = {{engagement.fee}}', {
      engagement: { tax_year: 2026, fee: 1200.5 },
    });
    expect(r.output).toBe('Year 2026 = 1200.5');
  });

  it('ignores tokens whose final segment lands on an object', () => {
    const r = resolveMergeTokens('{{ client }}', { client: { name: 'X' } });
    expect(r.unresolvedTokens).toEqual(['client']);
    expect(r.output).toBe('');
  });

  it('unwraps tokens auto-linked as markdown links (editor autolink mangling)', () => {
    const r = resolveMergeTokens('Hi {{ [client.name](http://client.name) }}!', {
      client: { name: 'Acme Co' },
    });
    expect(r.output).toBe('Hi Acme Co!');
    expect(r.unresolvedTokens).toEqual([]);
  });

  it('unwraps tokens auto-linked as HTML anchors (letter templates)', () => {
    const r = resolveMergeTokens('<p>{{ <a href="http://client.name">client.name</a> }}</p>', {
      client: { name: 'Acme Co' },
    });
    expect(r.output).toBe('<p>Acme Co</p>');
  });

  it('leaves genuine links outside token braces alone', () => {
    const input = 'See [our site](https://example.com) — {{ firm.name }}';
    const r = resolveMergeTokens(input, { firm: { name: 'Smith CPAs' } });
    expect(r.output).toBe('See [our site](https://example.com) — Smith CPAs');
  });
});
