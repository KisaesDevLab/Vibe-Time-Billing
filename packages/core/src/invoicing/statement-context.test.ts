// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import { buildStatementTemplateContext } from './statement-context';
import { DEFAULT_STATEMENT_BODY_HTML, DEFAULT_STATEMENT_CSS } from './default-statement-template';
import { renderStatementDocument, type StatementTemplateInput } from './templates';

const base: StatementTemplateInput = {
  statementDate: '2025-12-31',
  firm: { name: 'The CPA Group, PC', logoUrl: null, address: 'PO Box 68\nMonett, MO' },
  branding: {
    accentColor: '#1a1a1a',
    supportEmail: 'billing@cpa2web.com',
    supportPhone: '866-991-1272',
    supportFax: null,
    supportWeb: 'cpa2web.com',
    footerHtml: '<strong>Remit to PO Box 68</strong>',
  },
  client: {
    name: 'Acme & Sons',
    externalId: 'ACME01',
    mailingStreet1: '1 Main St',
    mailingCity: 'Monett',
    mailingState: 'MO',
    mailingPostal: '65708',
  },
  lines: [
    {
      date: '2025-12-05',
      type: 'Invoice',
      reference: '2001',
      debitCents: 35000,
      balanceCents: 35000,
    },
    {
      date: '2025-12-18',
      type: 'Payment',
      reference: 'abcd1234',
      creditCents: 35000,
      balanceCents: 0,
    },
  ],
  totalAmountDueCents: 50000,
  aging: { d_0_30: 50000, d_31_60: 0, d_61_90: 0, d_91_120: 0, d_121_plus: 0 },
  policyNotice: 'Balances over 90 days will have work suspended.',
};

describe('buildStatementTemplateContext', () => {
  it('maps outstanding-mode scopes and lines', () => {
    const ctx = buildStatementTemplateContext(base);
    expect((ctx.statement as Record<string, unknown>).total_due).toBe('$500.00');
    expect((ctx.statement as Record<string, unknown>).period_start).toBe('');
    expect((ctx.aging as Record<string, unknown>).d_0_30).toBe('$500.00');
    const lines = ctx.lines as Array<Record<string, string>>;
    expect(lines[0]).toEqual({
      date: '12/05/2025',
      type: 'Invoice',
      reference: '2001',
      debit: '$350.00',
      credit: '',
      balance: '$350.00',
    });
    expect(lines[1]!.credit).toBe('$350.00');
    expect(lines[1]!.debit).toBe('');
    expect(ctx.footer).toBe('<strong>Remit to PO Box 68</strong>');
  });

  it('populates period/opening/closing only in activity mode', () => {
    const ctx = buildStatementTemplateContext({
      ...base,
      mode: 'activity',
      periodStart: '2025-12-01',
      periodEnd: '2025-12-31',
      openingBalanceCents: 120000,
      chargesCents: 50000,
      paymentsCents: 35000,
      closingBalanceCents: 135000,
    });
    const s = ctx.statement as Record<string, unknown>;
    expect(s.mode).toBe('activity');
    expect(s.period_start).toBe('12/01/2025');
    expect(s.opening_balance).toBe('$1,200.00');
    expect(s.closing_balance).toBe('$1,350.00');
  });
});

describe('renderStatementDocument', () => {
  it('renders the default template (outstanding) end-to-end', () => {
    const html = renderStatementDocument(base, {
      bodyHtml: DEFAULT_STATEMENT_BODY_HTML,
      css: DEFAULT_STATEMENT_CSS,
      builtinStyle: null,
    });
    expect(html).toContain('Statement of Account');
    expect(html).toContain('Acme &amp; Sons');
    expect(html).toContain('Total Amount Due');
    expect(html).toContain('$350.00');
    // Accent color substituted into the CSS via {{ firm.accent_color }}.
    expect(html).toContain('#1a1a1a');
    // No opening-balance row in outstanding mode.
    expect(html).not.toContain('Opening balance');
  });

  it('shows opening/closing rows in activity mode', () => {
    const html = renderStatementDocument(
      {
        ...base,
        mode: 'activity',
        periodStart: '2025-12-01',
        periodEnd: '2025-12-31',
        openingBalanceCents: 120000,
        closingBalanceCents: 135000,
      },
      { bodyHtml: DEFAULT_STATEMENT_BODY_HTML, css: DEFAULT_STATEMENT_CSS, builtinStyle: null },
    );
    expect(html).toContain('Opening balance');
    expect(html).toContain('Closing Balance');
    expect(html).toContain('$1,350.00');
  });

  it('falls back to the legacy builtin when builtinStyle is set', () => {
    const html = renderStatementDocument(base, {
      bodyHtml: DEFAULT_STATEMENT_BODY_HTML,
      css: DEFAULT_STATEMENT_CSS,
      builtinStyle: 'classic',
    });
    expect(html).toContain('Statement of Account');
  });
});
