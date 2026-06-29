// SPDX-License-Identifier: Elastic-2.0
//
// Statement-of-account data assembly. Extracted from routes.ts so the
// admin template-preview can reuse it. Two modes:
//   - outstanding (default): open invoices (SENT/PARTIALLY_PAID/OVERDUE)
//     with a running balance + aging buckets, as of `asOfIso`.
//   - activity: opening balance (as of `start`), every invoice/payment in
//     [start,end] with a running balance, and a closing balance. Aging +
//     total-due are still computed from open invoices as of `end`.

import { and, eq, inArray, ne, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clients, firmSettings, invoices, payments } from '@vibe/db/schema';
import type { StatementLine, StatementTemplateInput } from '@vibe/core/invoicing';

export interface StatementBranding {
  displayName?: string | null;
  logoUrl?: string | null;
  accentColor?: string | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
  supportFax?: string | null;
  supportWeb?: string | null;
  arTermsText?: string | null;
  footerHtml?: string | null;
}

export interface StatementOptions {
  mode?: 'outstanding' | 'activity';
  /** Activity-mode period start (ISO date). Required for activity mode. */
  start?: string;
  /** Activity-mode period end (ISO date); defaults to asOf. */
  end?: string;
}

export async function loadBranding(db: Database, firmId: string): Promise<StatementBranding> {
  const [b] = await db
    .select({
      displayName: firmSettings.brandDisplayName,
      logoUrl: firmSettings.brandLogoUrl,
      accentColor: firmSettings.brandAccentColor,
      supportEmail: firmSettings.brandSupportEmail,
      supportPhone: firmSettings.brandSupportPhone,
      supportFax: firmSettings.brandSupportFax,
      supportWeb: firmSettings.brandSupportWeb,
      arTermsText: firmSettings.arTermsText,
      footerHtml: firmSettings.brandFooterHtml,
    })
    .from(firmSettings)
    .where(eq(firmSettings.firmId, firmId))
    .limit(1);
  return b ?? {};
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${a}T00:00:00`) - Date.parse(`${b}T00:00:00`)) / (1000 * 60 * 60 * 24),
  );
}

function brandingToInput(branding: StatementBranding | null): StatementTemplateInput['branding'] {
  return branding
    ? {
        accentColor: branding.accentColor ?? null,
        supportEmail: branding.supportEmail ?? null,
        supportPhone: branding.supportPhone ?? null,
        supportFax: branding.supportFax ?? null,
        supportWeb: branding.supportWeb ?? null,
        footerHtml: branding.arTermsText
          ? branding.arTermsText
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/\n/g, '<br />')
          : (branding.footerHtml ?? null),
      }
    : null;
}

export async function buildStatement(
  db: Database,
  firmId: string,
  clientId: string,
  asOfIso: string,
  branding: StatementBranding | null,
  firmRow: { name: string } | null,
  opts: StatementOptions = {},
): Promise<StatementTemplateInput | null> {
  const [clientRow] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.firmId, firmId)))
    .limit(1);
  if (!clientRow) return null;

  // ---- Outstanding pass (also supplies aging + total-due for activity) ----
  const invs = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      issueDate: invoices.issueDate,
      dueDate: invoices.dueDate,
      totalCents: invoices.totalCents,
      paidCents: invoices.paidCents,
      status: invoices.status,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.firmId, firmId),
        eq(invoices.clientId, clientId),
        inArray(invoices.status, ['SENT', 'PARTIALLY_PAID', 'OVERDUE']),
        ne(invoices.status, 'VOIDED'),
      ),
    )
    .orderBy(invoices.issueDate);

  const outstandingLines: StatementLine[] = [];
  let running = 0;
  let bucket0 = 0;
  let bucket30 = 0;
  let bucket60 = 0;
  let bucket90 = 0;
  let bucket121 = 0;
  const agingRefIso = opts.mode === 'activity' ? (opts.end ?? asOfIso) : asOfIso;

  for (const inv of invs) {
    const total = Number(inv.totalCents);
    const paid = Number(inv.paidCents);
    const balance = total - paid;
    if (balance <= 0) continue;

    running += total;
    outstandingLines.push({
      date: inv.issueDate,
      type: 'Invoice',
      reference: inv.invoiceNumber,
      debitCents: total,
      balanceCents: running,
    });

    if (paid > 0) {
      const pays = await db
        .select({
          id: payments.id,
          amountCents: payments.amountCents,
          receivedAt: payments.receivedAt,
        })
        .from(payments)
        .where(and(eq(payments.invoiceId, inv.id), eq(payments.status, 'SUCCEEDED')));
      for (const p of pays) {
        const credit = Number(p.amountCents);
        running -= credit;
        const dateIso = p.receivedAt
          ? new Date(p.receivedAt).toISOString().slice(0, 10)
          : inv.issueDate;
        outstandingLines.push({
          date: dateIso,
          type: 'Payment',
          reference: p.id.slice(0, 8),
          creditCents: credit,
          balanceCents: running,
        });
      }
    }

    const ageRef = inv.dueDate || inv.issueDate;
    const daysPastDue = daysBetween(agingRefIso, ageRef);
    if (daysPastDue <= 30) bucket0 += balance;
    else if (daysPastDue <= 60) bucket30 += balance;
    else if (daysPastDue <= 90) bucket60 += balance;
    else if (daysPastDue <= 120) bucket90 += balance;
    else bucket121 += balance;
  }

  const totalDue = bucket0 + bucket30 + bucket60 + bucket90 + bucket121;

  const base: StatementTemplateInput = {
    statementDate: opts.mode === 'activity' ? (opts.end ?? asOfIso) : asOfIso,
    firm: {
      name: branding?.displayName || firmRow?.name || 'Firm',
      logoUrl: branding?.logoUrl ?? null,
      address: null,
    },
    branding: brandingToInput(branding),
    client: {
      name: clientRow.name,
      externalId: clientRow.externalId ?? null,
      mailingStreet1: clientRow.mailingStreet1 ?? null,
      mailingStreet2: clientRow.mailingStreet2 ?? null,
      mailingCity: clientRow.mailingCity ?? null,
      mailingState: clientRow.mailingState ?? null,
      mailingPostal: clientRow.mailingPostal ?? null,
      mailingCountry: clientRow.mailingCountry ?? null,
      billingAddress: clientRow.billingAddress ?? null,
    },
    lines: outstandingLines,
    totalAmountDueCents: totalDue,
    aging: {
      d_0_30: bucket0,
      d_31_60: bucket30,
      d_61_90: bucket60,
      d_91_120: bucket90,
      d_121_plus: bucket121,
    },
    policyNotice:
      'Accounts with balances over 90 days past due will have all work suspended until payment is received.',
  };

  if (opts.mode !== 'activity' || !opts.start) return base;

  // ---- Activity pass: opening → in-range ledger → closing ----
  const start = opts.start;
  const end = opts.end ?? asOfIso;

  const [openCharges] = await db
    .select({ sum: sql<string>`COALESCE(SUM(${invoices.totalCents}), 0)` })
    .from(invoices)
    .where(
      and(
        eq(invoices.firmId, firmId),
        eq(invoices.clientId, clientId),
        ne(invoices.status, 'VOIDED'),
        ne(invoices.status, 'DRAFT'),
        sql`${invoices.issueDate} < ${start}`,
      ),
    );
  const [openPays] = await db
    .select({ sum: sql<string>`COALESCE(SUM(${payments.amountCents}), 0)` })
    .from(payments)
    .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
    .where(
      and(
        eq(invoices.firmId, firmId),
        eq(invoices.clientId, clientId),
        ne(invoices.status, 'VOIDED'),
        ne(invoices.status, 'DRAFT'),
        eq(payments.status, 'SUCCEEDED'),
        sql`${payments.receivedAt}::date < ${start}`,
      ),
    );
  const opening = Number(openCharges?.sum ?? 0) - Number(openPays?.sum ?? 0);

  const rangeInvs = await db
    .select({
      invoiceNumber: invoices.invoiceNumber,
      issueDate: invoices.issueDate,
      totalCents: invoices.totalCents,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.firmId, firmId),
        eq(invoices.clientId, clientId),
        ne(invoices.status, 'VOIDED'),
        ne(invoices.status, 'DRAFT'),
        sql`${invoices.issueDate} >= ${start}`,
        sql`${invoices.issueDate} <= ${end}`,
      ),
    );
  const rangePays = await db
    .select({ id: payments.id, amountCents: payments.amountCents, receivedAt: payments.receivedAt })
    .from(payments)
    .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
    .where(
      and(
        eq(invoices.firmId, firmId),
        eq(invoices.clientId, clientId),
        ne(invoices.status, 'VOIDED'),
        ne(invoices.status, 'DRAFT'),
        eq(payments.status, 'SUCCEEDED'),
        sql`${payments.receivedAt}::date >= ${start}`,
        sql`${payments.receivedAt}::date <= ${end}`,
      ),
    );

  type Ev = { date: string; kind: 'inv' | 'pay'; amount: number; reference: string };
  const events: Ev[] = [
    ...rangeInvs.map((i) => ({
      date: i.issueDate,
      kind: 'inv' as const,
      amount: Number(i.totalCents),
      reference: i.invoiceNumber,
    })),
    ...rangePays.map((p) => ({
      date: p.receivedAt ? new Date(p.receivedAt).toISOString().slice(0, 10) : start,
      kind: 'pay' as const,
      amount: Number(p.amountCents),
      reference: p.id.slice(0, 8),
    })),
  ];
  // Sort by date; invoices before payments on the same day.
  events.sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind === b.kind ? 0 : a.kind === 'inv' ? -1 : 1,
  );

  let bal = opening;
  let charges = 0;
  let paid = 0;
  const activityLines: StatementLine[] = events.map((e) => {
    if (e.kind === 'inv') {
      bal += e.amount;
      charges += e.amount;
      return {
        date: e.date,
        type: 'Invoice',
        reference: e.reference,
        debitCents: e.amount,
        balanceCents: bal,
      };
    }
    bal -= e.amount;
    paid += e.amount;
    return {
      date: e.date,
      type: 'Payment',
      reference: e.reference,
      creditCents: e.amount,
      balanceCents: bal,
    };
  });

  return {
    ...base,
    mode: 'activity',
    periodStart: start,
    periodEnd: end,
    openingBalanceCents: opening,
    chargesCents: charges,
    paymentsCents: paid,
    closingBalanceCents: bal,
    lines: activityLines,
  };
}
