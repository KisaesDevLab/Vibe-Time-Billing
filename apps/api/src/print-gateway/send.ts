// SPDX-License-Identifier: Elastic-2.0
//
// One funnel for every direct-print feature: forward a rendered PDF to
// the firm's Vibe Print gateway and record a print_log row. Resolves the
// gateway target from firm config (DB over env) unless one is supplied.

import type { Database } from '@vibe/db';
import { printLog } from '@vibe/db/schema';

import { printPdf } from './client';
import { resolvePrintGateway, type ResolvedPrintGateway } from './config';

export interface SendToPrinterInput {
  db: Database;
  firmId: string;
  appUserId?: string | null;
  printableType: string;
  printableId?: string | null;
  pdf: Buffer;
  printerId: number;
  copies?: number;
  media?: string | null;
  idempotencyKey?: string | null;
  /** Pre-resolved gateway (skips the per-call resolve). */
  gateway?: ResolvedPrintGateway;
}

export type SendToPrinterResult = { ok: true; jobId: string | null } | { ok: false; error: string };

export async function sendToPrinter(input: SendToPrinterInput): Promise<SendToPrinterResult> {
  const gateway = input.gateway ?? (await resolvePrintGateway(input.db, input.firmId));
  if (!gateway) return { ok: false, error: 'gateway_not_configured' };
  if (!gateway.enabled) return { ok: false, error: 'gateway_disabled' };

  const copies = input.copies ?? 1;
  try {
    const { jobId } = await printPdf(gateway, {
      printerId: input.printerId,
      pdf: input.pdf,
      copies,
      media: input.media ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
    });
    await input.db
      .insert(printLog)
      .values({
        firmId: input.firmId,
        appUserId: input.appUserId ?? null,
        printableType: input.printableType,
        printableId: input.printableId ?? null,
        printerId: input.printerId,
        copies,
        status: 'SENT',
        gatewayJobId: jobId,
      })
      .catch(() => undefined);
    return { ok: true, jobId };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'print_failed';
    await input.db
      .insert(printLog)
      .values({
        firmId: input.firmId,
        appUserId: input.appUserId ?? null,
        printableType: input.printableType,
        printableId: input.printableId ?? null,
        printerId: input.printerId,
        copies,
        status: 'FAILED',
        error: message.slice(0, 500),
      })
      .catch(() => undefined);
    return { ok: false, error: message };
  }
}
