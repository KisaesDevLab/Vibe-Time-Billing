// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Invoice numbering. Atomic, gapless, per-firm. The actual atomicity is
// at the DB layer (unique index on (firm_id, invoice_number) + a sequence
// per firm); this module computes the formatted string.

import type { IsoDate } from '@vibe/types';

export interface NumberingConfig {
  prefix: string;
  yearPart: 'NONE' | 'TWO_DIGIT' | 'FOUR_DIGIT';
  officeCode?: string | null;
  separator?: string;
  pad?: number;
}

export function formatInvoiceNumber(args: {
  config: NumberingConfig;
  sequence: number;
  issueDate: IsoDate;
}): string {
  const sep = args.config.separator ?? '-';
  const parts: string[] = [args.config.prefix];

  if (args.config.officeCode) parts.push(args.config.officeCode);

  if (args.config.yearPart === 'FOUR_DIGIT') parts.push(args.issueDate.slice(0, 4));
  else if (args.config.yearPart === 'TWO_DIGIT') parts.push(args.issueDate.slice(2, 4));

  const padded = String(args.sequence).padStart(args.config.pad ?? 5, '0');
  parts.push(padded);
  return parts.join(sep);
}
