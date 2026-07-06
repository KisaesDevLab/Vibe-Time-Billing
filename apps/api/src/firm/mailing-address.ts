// SPDX-License-Identifier: Elastic-2.0
//
// Compose the firm's mailing-address columns (firm_settings.mailing_*) into the
// single multi-line `firm.address` string that invoice / statement / letter /
// email templates already render.

export interface FirmMailingParts {
  mailingStreet1?: string | null;
  mailingStreet2?: string | null;
  mailingCity?: string | null;
  mailingState?: string | null;
  mailingPostal?: string | null;
  mailingCountry?: string | null;
}

/** Returns a newline-joined address, or '' when no parts are set. */
export function composeFirmMailingAddress(a: FirmMailingParts | null | undefined): string {
  if (!a) return '';
  const lines: string[] = [];
  const s1 = a.mailingStreet1?.trim();
  const s2 = a.mailingStreet2?.trim();
  if (s1) lines.push(s1);
  if (s2) lines.push(s2);
  const cityState = [a.mailingState?.trim(), a.mailingPostal?.trim()].filter(Boolean).join(' ');
  const cityLine = [a.mailingCity?.trim(), cityState].filter(Boolean).join(', ');
  if (cityLine) lines.push(cityLine);
  const country = a.mailingCountry?.trim();
  if (country) lines.push(country);
  return lines.join('\n');
}
