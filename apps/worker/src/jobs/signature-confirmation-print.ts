// SPDX-License-Identifier: Elastic-2.0
//
// 0185 — auto-print a signature confirmation report when a tax-return
// signature completes. Enqueued from the signature-completion paths
// (webhook + poll); this consumer renders the report and forwards it to
// the firm's Vibe Print gateway default printer. No-ops (and says why)
// unless the request is a tax return and the firm has the gateway +
// auto-print enabled.

import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import { clients, firms, signatureRequests, signatureSigners } from '@vibe/db/schema';

import { renderHtmlToPdf } from '../../../api/src/pdf/render';
import { renderSignatureConfirmationHtml } from '../../../api/src/pdf-templates/signature-confirmation';
import { resolvePrintGateway } from '../../../api/src/print-gateway/config';
import { sendToPrinter } from '../../../api/src/print-gateway/send';

export interface SignatureConfirmationPrintResult {
  skipped?: string;
  sent?: boolean;
  error?: string;
}

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : String(d);
}

export async function runSignatureConfirmationPrint(
  db: Database,
  log: Logger,
  data: { requestId: string },
): Promise<SignatureConfirmationPrintResult> {
  const [req] = await db
    .select({
      firmId: signatureRequests.firmId,
      title: signatureRequests.title,
      formType: signatureRequests.formType,
      clientId: signatureRequests.clientId,
      taxReturnId: signatureRequests.taxReturnId,
      status: signatureRequests.status,
      completedAt: signatureRequests.completedAt,
      certificateFileUrl: signatureRequests.certificateFileUrl,
    })
    .from(signatureRequests)
    .where(eq(signatureRequests.id, data.requestId))
    .limit(1);
  if (!req) return { skipped: 'not_found' };
  if (!req.taxReturnId) return { skipped: 'not_tax_return' };
  if (req.status !== 'completed') return { skipped: 'not_completed' };

  const gateway = await resolvePrintGateway(db, req.firmId);
  if (!gateway || !gateway.enabled) return { skipped: 'gateway_disabled' };
  if (!gateway.autoPrintSignatureConfirmation) return { skipped: 'auto_print_off' };
  if (!gateway.defaultPrinterId) return { skipped: 'no_default_printer' };

  const signers = await db
    .select({
      name: signatureSigners.name,
      email: signatureSigners.email,
      signedAt: signatureSigners.signedAt,
    })
    .from(signatureSigners)
    .where(eq(signatureSigners.requestId, data.requestId));

  const [firm] = await db
    .select({ name: firms.name })
    .from(firms)
    .where(eq(firms.id, req.firmId))
    .limit(1);
  let clientName: string | null = null;
  if (req.clientId) {
    const [c] = await db
      .select({ name: clients.name })
      .from(clients)
      .where(eq(clients.id, req.clientId))
      .limit(1);
    clientName = c?.name ?? null;
  }

  const html = renderSignatureConfirmationHtml({
    firmName: firm?.name ?? 'Firm',
    documentTitle: req.title,
    formType: req.formType,
    clientName,
    completedAt: iso(req.completedAt),
    certificateAvailable: Boolean(req.certificateFileUrl),
    signers: signers.map((s) => ({ name: s.name, email: s.email, signedAt: iso(s.signedAt) })),
  });

  const pdf = await renderHtmlToPdf(html);
  const result = await sendToPrinter({
    db,
    firmId: req.firmId,
    appUserId: null,
    printableType: 'signature_confirmation',
    printableId: data.requestId,
    pdf,
    printerId: gateway.defaultPrinterId,
    copies: 1,
    idempotencyKey: `sigconf:${data.requestId}`,
    gateway,
  });
  if (!result.ok) {
    log.warn(
      { requestId: data.requestId, error: result.error },
      'signature confirmation print failed',
    );
    return { sent: false, error: result.error };
  }
  return { sent: true };
}
