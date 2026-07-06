// SPDX-License-Identifier: Elastic-2.0
//
// Builds the namespaced context the statement template-engine resolves
// tokens against, plus the catalog for the admin variable picker / docs.
// Parallels invoicing/context.ts (invoices).

import type { Cents } from '@vibe/types';

import { formatDateUS as fmtDate, formatMoneyCents } from './format';
import type { StatementTemplateInput } from './templates';
import type { TemplateContext } from './template-engine';

const cents = (c: Cents): string => formatMoneyCents(c);

function validAccent(color: string | null | undefined): string {
  return color && /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(color) ? color : '#111';
}

function formatAddress(c: StatementTemplateInput['client']): string {
  const out: string[] = [];
  if (c.mailingStreet1) out.push(c.mailingStreet1);
  if (c.mailingStreet2) out.push(c.mailingStreet2);
  const cityState = [c.mailingCity, c.mailingState].filter(Boolean).join(', ');
  const lastLine = [cityState, c.mailingPostal].filter(Boolean).join('  ');
  if (lastLine) out.push(lastLine);
  if (c.mailingCountry) out.push(c.mailingCountry);
  if (out.length === 0 && c.billingAddress) out.push(c.billingAddress);
  return out.join('\n');
}

export function buildStatementTemplateContext(input: StatementTemplateInput): TemplateContext {
  const isActivity = input.mode === 'activity' && input.periodStart != null;
  return {
    firm: {
      name: input.firm.name,
      logo_url: input.firm.logoUrl ?? '',
      address: input.firm.address ?? '',
      phone: input.branding?.supportPhone ?? '',
      email: input.branding?.supportEmail ?? '',
      fax: input.branding?.supportFax ?? '',
      web: input.branding?.supportWeb ?? '',
      accent_color: validAccent(input.branding?.accentColor),
    },
    client: {
      name: input.client.name,
      address: formatAddress(input.client),
      external_id: input.client.externalId ?? '',
      mailing_street1: input.client.mailingStreet1 ?? '',
      mailing_street2: input.client.mailingStreet2 ?? '',
      mailing_city: input.client.mailingCity ?? '',
      mailing_state: input.client.mailingState ?? '',
      mailing_postal: input.client.mailingPostal ?? '',
      mailing_country: input.client.mailingCountry ?? '',
    },
    statement: {
      date: fmtDate(input.statementDate),
      mode: input.mode ?? 'outstanding',
      // Period fields are populated only in activity mode; the default
      // template gates activity-only UI on `statement.period_start`.
      period_start: isActivity ? fmtDate(input.periodStart) : '',
      period_end: isActivity ? fmtDate(input.periodEnd) : '',
      opening_balance: isActivity ? cents(input.openingBalanceCents ?? 0) : '',
      charges: isActivity ? cents(input.chargesCents ?? 0) : '',
      payments: isActivity ? cents(input.paymentsCents ?? 0) : '',
      closing_balance: isActivity ? cents(input.closingBalanceCents ?? 0) : '',
      total_due: cents(input.totalAmountDueCents),
    },
    aging: {
      d_0_30: cents(input.aging.d_0_30),
      d_31_60: cents(input.aging.d_31_60),
      d_61_90: cents(input.aging.d_61_90),
      d_91_120: cents(input.aging.d_91_120),
      d_121_plus: cents(input.aging.d_121_plus),
    },
    lines: input.lines.map((l) => ({
      date: fmtDate(l.date),
      type: l.type,
      reference: l.reference,
      debit: l.debitCents != null ? cents(l.debitCents) : '',
      credit: l.creditCents != null ? cents(l.creditCents) : '',
      balance: cents(l.balanceCents),
    })),
    // Safe-HTML — emit with {{{ footer }}}.
    footer: input.branding?.footerHtml ?? '',
    policy_notice: input.policyNotice ?? '',
  };
}

export interface StatementTokenEntry {
  token: string;
  scope: 'firm' | 'client' | 'statement' | 'aging' | 'lines' | 'safe_html';
  description: string;
  raw?: boolean;
}

export const STATEMENT_TEMPLATE_TOKENS: StatementTokenEntry[] = [
  { token: 'firm.name', scope: 'firm', description: 'Firm / business display name' },
  { token: 'firm.logo_url', scope: 'firm', description: 'Firm logo image URL' },
  { token: 'firm.address', scope: 'firm', description: 'Firm address (multi-line)' },
  { token: 'firm.phone', scope: 'firm', description: 'Support phone number' },
  { token: 'firm.email', scope: 'firm', description: 'Support email address' },
  { token: 'firm.fax', scope: 'firm', description: 'Support fax number' },
  { token: 'firm.web', scope: 'firm', description: 'Firm website' },
  { token: 'firm.accent_color', scope: 'firm', description: 'Brand accent color (hex)' },

  { token: 'client.name', scope: 'client', description: 'Client name' },
  { token: 'client.address', scope: 'client', description: 'Formatted mailing address block' },
  { token: 'client.external_id', scope: 'client', description: 'Client external ID ("ID:")' },
  { token: 'client.mailing_street1', scope: 'client', description: 'Mailing street line 1' },
  { token: 'client.mailing_street2', scope: 'client', description: 'Mailing street line 2' },
  { token: 'client.mailing_city', scope: 'client', description: 'Mailing city' },
  { token: 'client.mailing_state', scope: 'client', description: 'Mailing state' },
  { token: 'client.mailing_postal', scope: 'client', description: 'Mailing postal code' },
  { token: 'client.mailing_country', scope: 'client', description: 'Mailing country' },

  { token: 'statement.date', scope: 'statement', description: 'Statement date (as-of)' },
  { token: 'statement.mode', scope: 'statement', description: 'outstanding | activity' },
  {
    token: 'statement.period_start',
    scope: 'statement',
    description: 'Activity period start (activity mode)',
  },
  {
    token: 'statement.period_end',
    scope: 'statement',
    description: 'Activity period end (activity mode)',
  },
  {
    token: 'statement.opening_balance',
    scope: 'statement',
    description: 'Opening balance (activity mode)',
  },
  {
    token: 'statement.charges',
    scope: 'statement',
    description: 'Charges in period (activity mode)',
  },
  {
    token: 'statement.payments',
    scope: 'statement',
    description: 'Payments in period (activity mode)',
  },
  {
    token: 'statement.closing_balance',
    scope: 'statement',
    description: 'Closing balance (activity mode)',
  },
  { token: 'statement.total_due', scope: 'statement', description: 'Total amount due (formatted)' },

  { token: 'aging.d_0_30', scope: 'aging', description: '0–30 days past due' },
  { token: 'aging.d_31_60', scope: 'aging', description: '31–60 days past due' },
  { token: 'aging.d_61_90', scope: 'aging', description: '61–90 days past due' },
  { token: 'aging.d_91_120', scope: 'aging', description: '91–120 days past due' },
  { token: 'aging.d_121_plus', scope: 'aging', description: '121+ days past due' },

  { token: 'this.date', scope: 'lines', description: 'Row date (inside #each lines)' },
  { token: 'this.type', scope: 'lines', description: 'Row type — Invoice / Payment' },
  { token: 'this.reference', scope: 'lines', description: 'Row reference (invoice #, payment id)' },
  { token: 'this.debit', scope: 'lines', description: 'Charge amount (blank on payment rows)' },
  { token: 'this.credit', scope: 'lines', description: 'Payment amount (blank on invoice rows)' },
  { token: 'this.balance', scope: 'lines', description: 'Running balance after the row' },

  { token: 'footer', scope: 'safe_html', description: 'A/R terms / footer (HTML)', raw: true },
  {
    token: 'policy_notice',
    scope: 'safe_html',
    description: 'Policy notice banner under the table',
  },
];
