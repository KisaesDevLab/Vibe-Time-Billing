// SPDX-License-Identifier: Elastic-2.0
//
// 0186 — auto-print a payment receipt when a Stripe Terminal card-present
// payment completes. Enqueued from the stripe webhook (materialize path);
// this consumer renders the receipt and forwards it to the reader's
// configured printer. No-ops (logged) if the receipt can't be loaded.

import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import { paymentReceipts } from '@vibe/db/schema';

import { renderHtmlToPdf } from '../../../api/src/pdf/render';
import { loadReceiptDoc, renderPaymentReceiptHtml } from '../../../api/src/payments/receipt-doc';
import { sendToPrinter } from '../../../api/src/print-gateway/send';

export interface TerminalReceiptPrintResult {
  skipped?: string;
  sent?: boolean;
  error?: string;
}

export async function runTerminalReceiptPrint(
  db: Database,
  log: Logger,
  data: { receiptId: string; printerId: number },
): Promise<TerminalReceiptPrintResult> {
  const [receipt] = await db
    .select({ firmId: paymentReceipts.firmId })
    .from(paymentReceipts)
    .where(eq(paymentReceipts.id, data.receiptId))
    .limit(1);
  if (!receipt) return { skipped: 'receipt_not_found' };

  const loaded = await loadReceiptDoc(db, receipt.firmId, data.receiptId);
  if (!loaded) return { skipped: 'receipt_not_found' };

  const pdf = await renderHtmlToPdf(renderPaymentReceiptHtml(loaded.doc));
  const result = await sendToPrinter({
    db,
    firmId: receipt.firmId,
    appUserId: null,
    printableType: 'payment_receipt',
    printableId: data.receiptId,
    pdf,
    printerId: data.printerId,
    copies: 1,
    idempotencyKey: `termreceipt:${data.receiptId}`,
  });
  if (!result.ok) {
    log.warn({ receiptId: data.receiptId, error: result.error }, 'terminal receipt print failed');
    return { sent: false, error: result.error };
  }
  return { sent: true };
}
