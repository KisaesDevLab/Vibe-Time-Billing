// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Shared 1040 filing-status normaliser. Accepts the enum codes
// (SINGLE/MFJ/MFS/HOH/QW) as well as the spelled-out labels tax software
// emits — UltraTax data-mining exports say "Married filing joint" /
// "Head of household", the OCR'd General Information screen says
// "Married filing jointly", IRS forms say "Qualifying surviving spouse".
// Used by the CSV/XLSX client importer and the UltraTax OCR intake mapper.

export type FilingStatusCode = 'SINGLE' | 'MFJ' | 'MFS' | 'HOH' | 'QW';

export function normalizeFilingStatus(
  raw: string | null | undefined,
): FilingStatusCode | undefined {
  const s = (raw ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return undefined;
  if (s === 'single' || s === 's') return 'SINGLE';
  if (s === 'mfj' || s === 'j' || s.includes('joint')) return 'MFJ';
  if (s === 'mfs' || s.includes('separate')) return 'MFS';
  if (s === 'hoh' || s === 'h' || s.includes('household')) return 'HOH';
  if (
    s === 'qw' ||
    s === 'qss' ||
    s.includes('widow') ||
    s.includes('surviving') ||
    s.includes('qualifying')
  )
    return 'QW';
  return undefined;
}
