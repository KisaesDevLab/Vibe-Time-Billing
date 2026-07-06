// SPDX-License-Identifier: Elastic-2.0
import { describe, expect, it } from 'vitest';

import { formatMailingAddress } from './mailing-print';

const base = {
  mailingStreet1: null,
  mailingStreet2: null,
  mailingCity: null,
  mailingState: null,
  mailingPostal: null,
  mailingCountry: null,
};

describe('formatMailingAddress', () => {
  it('returns empty when no mailing field is set', () => {
    expect(formatMailingAddress(base)).toBe('');
    expect(formatMailingAddress({ ...base, mailingCountry: 'US' })).toBe('');
  });

  it('composes a standard domestic block, omitting US country', () => {
    expect(
      formatMailingAddress({
        ...base,
        mailingStreet1: '42 Placeholder Lane',
        mailingCity: 'Springfield',
        mailingState: 'IL',
        mailingPostal: '62704',
        mailingCountry: 'US',
      }),
    ).toBe('42 Placeholder Lane\nSpringfield, IL 62704');
  });

  it('includes street2 and keeps a non-domestic country line', () => {
    expect(
      formatMailingAddress({
        ...base,
        mailingStreet1: '100 Example Ave',
        mailingStreet2: 'Suite 200',
        mailingCity: 'Toronto',
        mailingState: 'ON',
        mailingPostal: 'M5H 2N2',
        mailingCountry: 'Canada',
      }),
    ).toBe('100 Example Ave\nSuite 200\nToronto, ON M5H 2N2\nCanada');
  });

  it('tolerates partial city/state/zip without stray separators', () => {
    expect(formatMailingAddress({ ...base, mailingCity: 'Austin', mailingPostal: '78701' })).toBe(
      'Austin 78701',
    );
    expect(formatMailingAddress({ ...base, mailingState: 'TX' })).toBe('TX');
  });
});
