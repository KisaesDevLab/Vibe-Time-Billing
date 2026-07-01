// SPDX-License-Identifier: Elastic-2.0
import { describe, expect, it } from 'vitest';

import {
  buildLetterContext,
  nextYmd,
  renderLetterHtml,
  zonedDayStartUtc,
  type ClientLetterData,
} from './letter-merge';

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
  recipientEmail: 'dana@riverside.test',
  recipientName: 'Dana Whitfield',
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

  it('exposes appointment + drop-off tokens when present', () => {
    const ctx = buildLetterContext(
      {
        ...client,
        dropOffDate: '03/20/2026',
        appointment: {
          datetime: '03/15/2026 at 2:00 PM',
          date: '03/15/2026',
          time: '2:00 PM',
          title: 'Tax review',
          location: 'In person',
        },
      },
      firm,
      now,
    ) as { client: Record<string, string>; appointment: Record<string, string> };
    expect(ctx.client.drop_off_date).toBe('03/20/2026');
    expect(ctx.appointment.datetime).toBe('03/15/2026 at 2:00 PM');
    expect(ctx.appointment.location).toBe('In person');
  });

  it('renders appointment/drop-off tokens empty when absent', () => {
    const ctx = buildLetterContext(client, firm, now) as {
      client: Record<string, string>;
      appointment: Record<string, string>;
      engagement: Record<string, string>;
    };
    expect(ctx.client.drop_off_date).toBe('');
    expect(ctx.appointment.datetime).toBe('');
    expect(ctx.engagement.name).toBe('');
  });

  it('exposes the engagement name token (engagements flow)', () => {
    const ctx = buildLetterContext({ ...client, engagementName: '2025 Form 1040' }, firm, now) as {
      engagement: Record<string, string>;
    };
    expect(ctx.engagement.name).toBe('2025 Form 1040');
  });

  it('falls back to legal name when no client-facing name', () => {
    const ctx = buildLetterContext({ ...client, clientFacingName: null }, firm, now) as {
      client: Record<string, string>;
    };
    expect(ctx.client.display_name).toBe('Riverside Holdings LLC');
  });
});

describe('date-range helpers (appointment filter)', () => {
  it('nextYmd rolls months and years correctly', () => {
    expect(nextYmd('2026-03-15')).toBe('2026-03-16');
    expect(nextYmd('2026-02-28')).toBe('2026-03-01'); // 2026 not a leap year
    expect(nextYmd('2026-12-31')).toBe('2027-01-01');
  });

  it('zonedDayStartUtc converts a local calendar day to the right UTC instant', () => {
    // UTC: local midnight == the same instant.
    expect(zonedDayStartUtc('2026-03-15', 'UTC').toISOString()).toBe('2026-03-15T00:00:00.000Z');
    // America/Chicago on 2026-03-15 is CDT (UTC-5, DST began Mar 8) →
    // local midnight is 05:00 UTC.
    expect(zonedDayStartUtc('2026-03-15', 'America/Chicago').toISOString()).toBe(
      '2026-03-15T05:00:00.000Z',
    );
    // Before DST (CST, UTC-6) → 06:00 UTC.
    expect(zonedDayStartUtc('2026-01-15', 'America/Chicago').toISOString()).toBe(
      '2026-01-15T06:00:00.000Z',
    );
  });

  it('is correct for an ahead-of-UTC zone on DST-transition days (double-correction)', () => {
    // Sydney DST ends Apr 5 2026 (midnight is still AEDT +11) → prev day 13:00Z.
    expect(zonedDayStartUtc('2026-04-05', 'Australia/Sydney').toISOString()).toBe(
      '2026-04-04T13:00:00.000Z',
    );
    // Sydney DST starts Oct 4 2026 (midnight is AEST +10) → prev day 14:00Z.
    expect(zonedDayStartUtc('2026-10-04', 'Australia/Sydney').toISOString()).toBe(
      '2026-10-03T14:00:00.000Z',
    );
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

  it('applies the default letter stylesheet to fragment (WYSIWYG) letters', () => {
    const html = renderLetterHtml('<h1>{{ firm.name }}</h1><p>Hi</p>', client, firm, now);
    expect(html).toContain('@page { size: Letter; margin: 1in; }');
  });

  it('does not inject default CSS into a full-document letter (self-styled)', () => {
    const fullDoc =
      '<!doctype html><html><head><style>body{color:red}</style></head><body>{{ client.name }}</body></html>';
    const html = renderLetterHtml(fullDoc, client, firm, now);
    expect(html).not.toContain('@page { size: Letter; margin: 1in; }');
    expect(html).toContain('body{color:red}');
  });
});
