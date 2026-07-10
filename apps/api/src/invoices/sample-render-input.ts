// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Assembles an InvoiceTemplateInput from a RANDOM real invoice in the
// firm, for the invoice-template editor's live preview — so the preview
// reflects the firm's actual data/branding instead of a fixed sample.
// Returns null when the firm has no invoices (caller falls back to the
// built-in sample).

import { eq, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  clients,
  engagements,
  firms,
  firmSettings,
  invoiceLineItems,
  invoices,
} from '@vibe/db/schema';
import type { InvoiceTemplateInput } from '@vibe/core/invoicing';
import { composeFirmMailingAddress } from '../firm/mailing-address';

export async function loadRandomInvoiceInput(
  db: Database,
  firmId: string,
): Promise<InvoiceTemplateInput | null> {
  // Prefer a non-draft invoice (richer, client-facing); fall back to any.
  const pick = async (draftFilter: boolean) => {
    const rows = await db
      .select()
      .from(invoices)
      .where(
        draftFilter
          ? sql`${invoices.firmId} = ${firmId} AND ${invoices.status} <> 'DRAFT'`
          : eq(invoices.firmId, firmId),
      )
      .orderBy(sql`random()`)
      .limit(1);
    return rows[0];
  };
  const inv = (await pick(true)) ?? (await pick(false));
  if (!inv) return null;

  const [firm] = await db
    .select({ name: firms.name })
    .from(firms)
    .where(eq(firms.id, inv.firmId))
    .limit(1);
  const [branding] = await db
    .select({
      displayName: firmSettings.brandDisplayName,
      logoUrl: firmSettings.brandLogoUrl,
      accentColor: firmSettings.brandAccentColor,
      supportEmail: firmSettings.brandSupportEmail,
      supportPhone: firmSettings.brandSupportPhone,
      supportFax: firmSettings.brandSupportFax,
      supportWeb: firmSettings.brandSupportWeb,
      footerHtml: firmSettings.brandFooterHtml,
      arTermsText: firmSettings.arTermsText,
      mailingStreet1: firmSettings.mailingStreet1,
      mailingStreet2: firmSettings.mailingStreet2,
      mailingCity: firmSettings.mailingCity,
      mailingState: firmSettings.mailingState,
      mailingPostal: firmSettings.mailingPostal,
      mailingCountry: firmSettings.mailingCountry,
    })
    .from(firmSettings)
    .where(eq(firmSettings.firmId, inv.firmId))
    .limit(1);
  const [client] = await db
    .select({
      name: clients.name,
      billingAddress: clients.billingAddress,
      mailingStreet1: clients.mailingStreet1,
      mailingStreet2: clients.mailingStreet2,
      mailingCity: clients.mailingCity,
      mailingState: clients.mailingState,
      mailingPostal: clients.mailingPostal,
      mailingCountry: clients.mailingCountry,
      externalId: clients.externalId,
    })
    .from(clients)
    .where(eq(clients.id, inv.clientId))
    .limit(1);
  let engagementName: string | null = null;
  if (inv.primaryEngagementId) {
    const [eng] = await db
      .select({ name: engagements.name })
      .from(engagements)
      .where(eq(engagements.id, inv.primaryEngagementId))
      .limit(1);
    engagementName = eng?.name ?? null;
  }
  const lines = await db
    .select()
    .from(invoiceLineItems)
    .where(eq(invoiceLineItems.invoiceId, inv.id))
    .orderBy(invoiceLineItems.sortOrder);

  return {
    invoiceNumber: inv.invoiceNumber,
    issueDate: inv.issueDate,
    dueDate: inv.dueDate,
    firm: {
      name: branding?.displayName || firm?.name || 'Firm',
      logoUrl: branding?.logoUrl ?? null,
      address: composeFirmMailingAddress(branding),
    },
    branding: branding
      ? {
          accentColor: branding.accentColor ?? null,
          supportEmail: branding.supportEmail ?? null,
          supportPhone: branding.supportPhone ?? null,
          supportFax: branding.supportFax ?? null,
          supportWeb: branding.supportWeb ?? null,
          // A/R terms win over the generic footer when both set.
          footerHtml: branding.arTermsText
            ? branding.arTermsText
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/\n/g, '<br />')
            : (branding.footerHtml ?? null),
        }
      : null,
    reference: inv.invoiceNumber,
    engagementName,
    client: {
      name: client?.name ?? 'Client',
      billingAddress: client?.billingAddress ?? null,
      mailingStreet1: client?.mailingStreet1 ?? null,
      mailingStreet2: client?.mailingStreet2 ?? null,
      mailingCity: client?.mailingCity ?? null,
      mailingState: client?.mailingState ?? null,
      mailingPostal: client?.mailingPostal ?? null,
      mailingCountry: client?.mailingCountry ?? null,
      externalId: client?.externalId ?? null,
    },
    lines: lines.map((l) => ({
      kind: l.kind,
      description: l.description,
      amountCents: Number(l.amountCents),
    })),
    subtotalCents: Number(inv.subtotalCents),
    surchargeCents: Number(inv.surchargeCents ?? 0),
    taxCents: Number(inv.taxCents ?? 0),
    processingFeeCents: Number(inv.feeCents),
    totalCents: Number(inv.totalCents),
    paidCents: Number(inv.paidCents ?? 0),
    status: inv.status,
    notes: inv.notes ?? null,
  };
}
