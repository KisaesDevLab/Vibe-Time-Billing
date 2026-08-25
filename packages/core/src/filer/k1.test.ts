// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import { clientNameVariants, parseK1Recipient } from './k1';

describe('parseK1Recipient', () => {
  it('extracts the recipient name and drops trailing entity-id tokens', () => {
    const r = parseK1Recipient('Parkway, LLC_2025_1120S_K1_Package_Joe Black_6111_PARK.pdf');
    expect(r).not.toBeNull();
    expect(r!.recipientName).toBe('Joe Black');
    expect(r!.raw).toBe('Joe Black_6111_PARK');
  });

  it('handles marker casing and separator variants', () => {
    expect(parseK1Recipient('X_2025_1065_k1_package_Jane Doe_1234.pdf')?.recipientName).toBe(
      'Jane Doe',
    );
    expect(parseK1Recipient('X_2025_1065_K-1_Package_Jane Doe.pdf')?.recipientName).toBe(
      'Jane Doe',
    );
    expect(parseK1Recipient('X_2025_1065_K1 Package_Jane Doe.pdf')?.recipientName).toBe('Jane Doe');
  });

  it('uses the LAST marker when an entity name contains one', () => {
    const r = parseK1Recipient('K1 Package_ LLC_2025_1065_K1_Package_Jane Doe_9999.pdf');
    expect(r?.recipientName).toBe('Jane Doe');
  });

  it('joins underscore-separated name tokens', () => {
    expect(parseK1Recipient('E_2025_1120S_K1_Package_Joe_Black_6111_PARK.pdf')?.recipientName).toBe(
      'Joe Black',
    );
  });

  it('returns null without a marker', () => {
    expect(parseK1Recipient('Parkway, LLC_2025_1120S_Tax_Return_6111.pdf')).toBeNull();
  });

  it('returns null when only id-shaped tokens follow the marker', () => {
    expect(parseK1Recipient('E_2025_1120S_K1_Package_6111.pdf')).toBeNull();
  });

  it('keeps a name with no trailing ids intact', () => {
    expect(parseK1Recipient('E_2025_1120S_K1_Package_Joe Black.pdf')?.recipientName).toBe(
      'Joe Black',
    );
  });
});

describe('clientNameVariants', () => {
  it('reorders Last, First', () => {
    expect(clientNameVariants('Black, Joe')).toEqual(['Joe Black']);
  });

  it('expands spouse names on & and "and"', () => {
    expect(clientNameVariants('Black, Joe & Jane')).toEqual(['Joe Black', 'Jane Black']);
    expect(clientNameVariants('Black, Joe and Jane')).toEqual(['Joe Black', 'Jane Black']);
  });

  it('preserves middle initials', () => {
    expect(clientNameVariants('Black, Joe A')).toEqual(['Joe A Black']);
  });

  it('passes through names without a comma', () => {
    expect(clientNameVariants('Parkway LLC')).toEqual(['Parkway LLC']);
  });

  it('does not treat an entity suffix as a given name', () => {
    expect(clientNameVariants('Parkway, LLC')).toEqual(['Parkway, LLC']);
    expect(clientNameVariants('Smith & Sons, Inc.')).toEqual(['Smith & Sons, Inc.']);
  });
});
