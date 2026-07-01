// SPDX-License-Identifier: Elastic-2.0
import { describe, expect, it } from 'vitest';

import { buildLetterContext, renderLetterHtml, type ClientLetterData } from './letter-merge';

const client: ClientLetterData = {
  id: 'c1',
  name: 'Riverside Holdings LLC',
  clientFacingName: 'Riverside',
  mailingStreet1: '123 Main St',
  mailingStreet2: 'Suite 400',
  mailingCity: 'Springfield',
  mailingState: 'IL',
  mailingPostal: '62704',
  mailingCountry: 'US',
  primaryContactName: 'Dana Whitfield',
};
const firm = { name: 'Northwind Tax', support_email: 'hi@northwind.test' };
const now = new Date('2026-02-03T10:00:00');

describe('buildLetterContext', () => {
  it('exposes client + firm + today tokens', () => {
    const ctx = buildLetterContext(client, firm, now) as {
      client: Record<string, string>;
      firm: Record<string, string>;
      today: string;
    };
    expect(ctx.client.display_name).toBe('Riverside');
    expect(ctx.client.primary_contact).toBe('Dana Whitfield');
    expect(ctx.client.mailing_address).toBe('123 Main St\nSuite 400\nSpringfield, IL 62704');
    expect(ctx.client.address_block_html).toBe('123 Main St<br>Suite 400<br>Springfield, IL 62704');
    expect(ctx.client.city_state_zip).toBe('Springfield, IL 62704');
    expect(ctx.firm.name).toBe('Northwind Tax');
    expect(ctx.today).toBe('02/03/2026');
  });

  it('falls back to legal name when no client-facing name', () => {
    const ctx = buildLetterContext({ ...client, clientFacingName: null }, firm, now) as {
      client: Record<string, string>;
    };
    expect(ctx.client.display_name).toBe('Riverside Holdings LLC');
  });
});

describe('renderLetterHtml', () => {
  it('substitutes tokens, conditionals, and raw address block', () => {
    const body =
      '<body><p>{{ today }}</p>' +
      '<p>Dear {{ client.primary_contact }},</p>' +
      '{{#if client.primary_contact}}<p>Hi {{ client.display_name }}</p>{{else}}<p>Hello</p>{{/if}}' +
      '<div class="addr">{{{ client.address_block_html }}}</div>' +
      '<p>{{ firm.name }}</p></body>';
    const html = renderLetterHtml(body, client, firm, now);
    expect(html).toContain('02/03/2026');
    expect(html).toContain('Dear Dana Whitfield,');
    expect(html).toContain('Hi Riverside');
    expect(html).toContain('123 Main St<br>Suite 400<br>Springfield, IL 62704');
    expect(html).toContain('Northwind Tax');
  });

  it('escapes HTML-unsafe client names in the {{ }} path', () => {
    const html = renderLetterHtml(
      '<body>{{ client.name }}</body>',
      { ...client, name: 'A & B <Co>' },
      firm,
      now,
    );
    expect(html).toContain('A &amp; B &lt;Co&gt;');
  });
});
