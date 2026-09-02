// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import { extractSmsTemplateVars, firstNameOf, renderSmsTemplate } from './template';

describe('renderSmsTemplate', () => {
  it('substitutes known vars and reports unresolved ones', () => {
    const r = renderSmsTemplate(
      'Hi {client_first}, this is {staff_first} from {firm} re {engagement_name}.',
      { client_first: 'Pat', staff_first: 'Sarah', firm: 'Acme CPA' },
    );
    expect(r.text).toBe('Hi Pat, this is Sarah from Acme CPA re {engagement_name}.');
    expect(r.unresolved).toEqual(['engagement_name']);
  });
  it('treats null/empty as unresolved and leaves unknown placeholders literal', () => {
    const r = renderSmsTemplate('{client_first} {nope}', { client_first: null });
    expect(r.text).toBe('{client_first} {nope}');
    expect(r.unresolved).toEqual(['client_first', 'nope']);
  });
  it('extracts placeholder names once each', () => {
    expect(extractSmsTemplateVars('{firm} and {firm} and {client_first}')).toEqual([
      'firm',
      'client_first',
    ]);
  });
  it('firstNameOf handles "Last, First & Spouse" and "First Last"', () => {
    expect(firstNameOf('Smith, John & Jane')).toBe('John');
    expect(firstNameOf('John Smith')).toBe('John');
    expect(firstNameOf('  ')).toBe('');
    expect(firstNameOf(null)).toBe('');
  });
});
