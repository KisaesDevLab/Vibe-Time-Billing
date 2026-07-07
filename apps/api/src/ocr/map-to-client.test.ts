// SPDX-License-Identifier: Elastic-2.0
import { describe, expect, it } from 'vitest';

import { ExtractedSchema, mapExtractedToClient, type ExtractedFields } from './map-to-client';

function fields(partial: Partial<ExtractedFields>): ExtractedFields {
  // Round-trips through the schema so defaults ('') fill every field.
  return ExtractedSchema.parse(partial);
}

describe('mapExtractedToClient', () => {
  it('maps a 1040 to INDIVIDUAL with "Last, First" name and filing status', () => {
    const { client, contact } = mapExtractedToClient(
      fields({
        entityForm: '1040',
        firstName: 'Jane',
        middleInitial: 'Q',
        lastName: 'Smith',
        filingStatus: 'Married filing jointly',
        address1: '1 Main St',
        city: 'Austin',
        state: 'TX',
        zip: '78701',
        daytimePhone: '512-555-0100',
        email: 'jane@example.com',
      }),
    );
    expect(client.clientType).toBe('INDIVIDUAL');
    expect(client.name).toBe('Smith, Jane Q');
    expect(client.filingStatus).toBe('MFJ');
    expect(client.mailingStreet1).toBe('1 Main St');
    expect(client.mailingCity).toBe('Austin');
    expect(client.mailingState).toBe('TX');
    expect(client.mailingPostal).toBe('78701');
    expect(contact).toEqual({
      name: 'Jane Smith',
      email: 'jane@example.com',
      phone: '512-555-0100',
    });
  });

  it('maps a 1120S to BUSINESS and stashes entity extras in customFields', () => {
    const { client } = mapExtractedToClient(
      fields({
        entityForm: '1120S',
        clientName: 'Acme Widgets Inc',
        stateOfIncorporation: 'DE',
        dateIncorporated: '2019-03-01',
        dateSElection: '2019-04-15',
        businessCode: '423990',
        filingStatus: 'Single', // ignored for a business
      }),
    );
    expect(client.clientType).toBe('BUSINESS');
    expect(client.name).toBe('Acme Widgets Inc');
    expect(client.filingStatus).toBeUndefined();
    expect(client.customFields).toMatchObject({
      entityForm: '1120S',
      stateOfIncorporation: 'DE',
      dateIncorporated: '2019-03-01',
      dateSElection: '2019-04-15',
      businessCode: '423990',
    });
  });

  it('normalizes assorted filing-status spellings', () => {
    const map: Array<[string, string]> = [
      ['Single', 'SINGLE'],
      ['MFS', 'MFS'],
      ['Head of Household', 'HOH'],
      ['Qualifying widow(er)', 'QW'],
    ];
    for (const [raw, expected] of map) {
      const { client } = mapExtractedToClient(
        fields({ entityForm: '1040', lastName: 'X', filingStatus: raw }),
      );
      expect(client.filingStatus).toBe(expected);
    }
  });

  it('infers INDIVIDUAL from a lastName when the form is blank', () => {
    const { client } = mapExtractedToClient(fields({ lastName: 'Doe', firstName: 'John' }));
    expect(client.clientType).toBe('INDIVIDUAL');
    expect(client.name).toBe('Doe, John');
  });

  it('carries the detected form into customFields', () => {
    const { client } = mapExtractedToClient(fields({ entityForm: '1120', clientName: 'Acme Co' }));
    expect(client.customFields).toEqual({ entityForm: '1120' });
  });

  it('omits customFields when no form/extras, and contact when fully blank', () => {
    const noExtras = mapExtractedToClient(fields({ clientName: 'NoExtra Co' }));
    expect(noExtras.client.customFields).toBeUndefined();

    const blank = mapExtractedToClient(fields({}));
    expect(blank.contact).toBeNull();
    expect(blank.client.name).toBe('');
  });

  it('never surfaces a tax-id field (schema has none)', () => {
    expect(Object.keys(ExtractedSchema.shape)).not.toContain('ssn');
    expect(Object.keys(ExtractedSchema.shape)).not.toContain('ein');
  });
});
