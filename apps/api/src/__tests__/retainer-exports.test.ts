// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// R6-followup — exports module tests.
//
// The CSV + HTML builders are pure functions of their inputs, so this
// suite stays unit-level (no pglite needed). The portal PDF route
// composes these with renderHtmlToPdf elsewhere — that path is
// integration-tested manually until Puppeteer-in-CI is wired.

import { describe, it, expect } from 'vitest';

import {
  buildActivityStatementHtml,
  buildLedgerCsv,
  buildOfferFunnelCsv,
} from '../retainers/exports';

describe('buildLedgerCsv', () => {
  it('returns header-only CSV for an empty ledger', () => {
    const csv = buildLedgerCsv([]);
    expect(csv).toBe(
      'created_at,kind,hours_delta,hours_balance_after,time_entry_id,created_by_id\n',
    );
  });

  it('escapes embedded commas in the time_entry_id column', () => {
    const csv = buildLedgerCsv([
      {
        createdAt: '2026-05-24T12:00:00Z',
        kind: 'CONSUME',
        hoursDelta: '2.50',
        hoursBalanceAfter: '7.50',
        timeEntryId: 'a,b',
        createdById: 'user-1',
      },
    ]);
    expect(csv).toContain('"a,b"');
    expect(csv).toContain('CONSUME');
    expect(csv).toContain('2.50');
  });

  it('renders nulls as empty cells', () => {
    const csv = buildLedgerCsv([
      {
        createdAt: '2026-05-24T12:00:00Z',
        kind: 'ACTIVATION',
        hoursDelta: '0',
        hoursBalanceAfter: '10',
        timeEntryId: null,
        createdById: null,
      },
    ]);
    expect(csv).toContain('ACTIVATION,0,10,,\n');
  });
});

describe('buildOfferFunnelCsv', () => {
  it('emits one row per bucket with all five status columns', () => {
    const csv = buildOfferFunnelCsv([
      {
        bucket: '2026-05-24',
        pendingCount: 3,
        pendingPaymentCount: 1,
        purchasedCount: 2,
        declinedCount: 0,
        expiredCount: 1,
      },
    ]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('date_bucket,pending,pending_payment,purchased,declined,expired');
    expect(lines[1]).toBe('2026-05-24,3,1,2,0,1');
  });
});

describe('buildActivityStatementHtml', () => {
  it('renders firm + client + retainer summary + activity table', () => {
    const html = buildActivityStatementHtml({
      firmName: 'Acme CPA',
      clientName: 'Wile E. Co',
      retainer: {
        name: 'Standard',
        returnType: '1040',
        taxYear: 2026,
        tier: 'TIER_1',
        hoursPurchased: 10,
        hoursConsumed: 3,
        purchaseDate: '2026-05-24',
        expiryDate: '2029-05-24',
        status: 'active',
      },
      ledger: [
        {
          createdAt: '2026-05-24T12:00:00Z',
          kind: 'ACTIVATION',
          hoursDelta: '0',
          hoursBalanceAfter: '10',
        },
        {
          createdAt: '2027-01-15T09:30:00Z',
          kind: 'CONSUME',
          hoursDelta: '3',
          hoursBalanceAfter: '7',
        },
      ],
      asOfDate: '2027-02-01',
    });
    expect(html).toContain('Acme CPA');
    expect(html).toContain('Wile E. Co');
    expect(html).toContain('Standard');
    expect(html).toContain('TIER_1');
    expect(html).toContain('CONSUME');
    expect(html).toContain('<strong>7.00</strong>');
    expect(html).toContain('2027-02-01');
    // Privacy filter: must NOT mention any internal staff name / app
    // user id / description field. We don't even accept them in the
    // input type, so this assertion proves we don't introduce them by
    // accident in the renderer.
    expect(html).not.toContain('app_user');
    expect(html).not.toContain('description');
  });

  it('renders empty-state copy when ledger is empty', () => {
    const html = buildActivityStatementHtml({
      firmName: 'Firm',
      clientName: 'Client',
      retainer: {
        name: 'X',
        returnType: '1040',
        taxYear: 2026,
        tier: 'TIER_1',
        hoursPurchased: 10,
        hoursConsumed: 0,
        purchaseDate: '2026-05-24',
        expiryDate: '2029-05-24',
        status: 'active',
      },
      ledger: [],
      asOfDate: '2026-05-24',
    });
    expect(html).toContain('No retainer activity recorded yet');
  });

  it('escapes HTML metacharacters in firm + client names', () => {
    const html = buildActivityStatementHtml({
      firmName: '<script>x</script>',
      clientName: 'Tom & Jerry',
      retainer: {
        name: 'X',
        returnType: '1040',
        taxYear: 2026,
        tier: 'TIER_1',
        hoursPurchased: 10,
        hoursConsumed: 0,
        purchaseDate: '2026-05-24',
        expiryDate: '2029-05-24',
        status: 'active',
      },
      ledger: [],
      asOfDate: '2026-05-24',
    });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Tom &amp; Jerry');
  });
});
