// SPDX-License-Identifier: Elastic-2.0
import { describe, expect, it } from 'vitest';

import { composeInvoiceHtml, renderInvoiceTemplate } from './template-engine';

describe('renderInvoiceTemplate', () => {
  it('substitutes flat dotted tokens and escapes by default', () => {
    const out = renderInvoiceTemplate('Hi {{ client.name }}', {
      client: { name: 'A & B <Co>' },
    });
    expect(out).toBe('Hi A &amp; B &lt;Co&gt;');
  });

  it('emits raw HTML for triple-brace tokens', () => {
    const out = renderInvoiceTemplate('{{{ invoice.footer }}}', {
      invoice: { footer: '<b>Pay now</b>' },
    });
    expect(out).toBe('<b>Pay now</b>');
  });

  it('collapses unknown tokens to empty string', () => {
    expect(renderInvoiceTemplate('x{{ nope.here }}y', {})).toBe('xy');
  });

  it('applies the default() filter when the value is empty', () => {
    expect(
      renderInvoiceTemplate('{{ invoice.due_terms | default("Due Upon Receipt") }}', {
        invoice: {},
      }),
    ).toBe('Due Upon Receipt');
    expect(
      renderInvoiceTemplate('{{ invoice.due_terms | default("Due Upon Receipt") }}', {
        invoice: { due_terms: 'Net 30' },
      }),
    ).toBe('Net 30');
  });

  it('iterates arrays with {{#each}} and `this`', () => {
    const out = renderInvoiceTemplate(
      '{{#each line_items}}<li>{{ this.description }}={{ this.amount }}</li>{{/each}}',
      {
        line_items: [
          { description: 'Tax prep', amount: '$350.00' },
          { description: 'Filing', amount: '$50.00' },
        ],
      },
    );
    expect(out).toBe('<li>Tax prep=$350.00</li><li>Filing=$50.00</li>');
  });

  it('renders nothing for an empty collection', () => {
    expect(renderInvoiceTemplate('a{{#each surcharges}}x{{/each}}b', { surcharges: [] })).toBe(
      'ab',
    );
    expect(renderInvoiceTemplate('a{{#each surcharges}}x{{/each}}b', {})).toBe('ab');
  });

  it('handles {{#if}}/{{else}} truthiness', () => {
    const tpl = '{{#if invoice.notes}}NOTE:{{ invoice.notes }}{{else}}none{{/if}}';
    expect(renderInvoiceTemplate(tpl, { invoice: { notes: 'hi' } })).toBe('NOTE:hi');
    expect(renderInvoiceTemplate(tpl, { invoice: { notes: '' } })).toBe('none');
    expect(renderInvoiceTemplate(tpl, { invoice: {} })).toBe('none');
  });

  it('supports nested blocks (if inside each)', () => {
    const out = renderInvoiceTemplate(
      '{{#each line_items}}{{ this.description }}{{#if this.amount}} ({{ this.amount }}){{/if}}; {{/each}}',
      {
        line_items: [
          { description: 'A', amount: '$1' },
          { description: 'B', amount: '' },
        ],
      },
    );
    expect(out).toBe('A ($1); B; ');
  });

  it('still resolves root scopes inside an each block', () => {
    const out = renderInvoiceTemplate(
      '{{#each line_items}}{{ firm.name }}:{{ this.description }} {{/each}}',
      { firm: { name: 'CPA' }, line_items: [{ description: 'X' }] },
    );
    expect(out).toBe('CPA:X ');
  });
});

describe('composeInvoiceHtml', () => {
  it('injects CSS into an existing <head> and substitutes tokens in both', () => {
    const html = composeInvoiceHtml(
      '<html><head><title>Invoice {{ invoice.number }}</title></head><body>{{ client.name }}</body></html>',
      ':root{--accent:{{ firm.accent_color }}}',
      { invoice: { number: '123' }, client: { name: 'Acme' }, firm: { accent_color: '#abc' } },
    );
    expect(html).toContain('<title>Invoice 123</title>');
    expect(html).toContain('<style>');
    expect(html).toContain('--accent:#abc');
    expect(html).toContain('Acme');
  });

  it('wraps a fragment body in a minimal document shell', () => {
    const html = composeInvoiceHtml('<p>{{ client.name }}</p>', 'p{color:red}', {
      client: { name: 'Bob' },
    });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<style>');
    expect(html).toContain('<p>Bob</p>');
  });
});
