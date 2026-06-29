// SPDX-License-Identifier: Elastic-2.0
//
// PRINT channel for notifications. When a firm has an enabled
// notification_template with channel='PRINT' for a given kind, this
// renders the message to a PDF and prints it to the configured printer
// (a specific gateway printer, or the notification's client-office
// printer). Best-effort: callers wrap it in .catch so a gateway failure
// never blocks the email/SMS send.

import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clients, notificationTemplates, printLog } from '@vibe/db/schema';
import { renderNotification } from '@vibe/core/notifications';
import type { MergeContext } from '@vibe/core/proposals';

import { renderHtmlToPdf } from '../pdf/render';
import { resolveOfficePrinter } from '../print-gateway/assignments';
import { resolvePrintGateway } from '../print-gateway/config';
import { sendToPrinter } from '../print-gateway/send';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrapHtml(firmName: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8" />
<style>
  @page { size: Letter; margin: 0.75in; }
  body { font: 11pt "Helvetica Neue", Helvetica, Arial, sans-serif; color: #111; margin: 0; }
  .firm { font-size: 16pt; font-weight: 800; border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 16px; }
  .body { white-space: pre-wrap; line-height: 1.5; }
</style></head>
<body><div class="firm">${esc(firmName)}</div><div class="body">${esc(body)}</div></body></html>`;
}

export interface PrintNotificationArgs {
  db: Database;
  firmId: string;
  kind: string;
  context: MergeContext;
  /** The notification's client, for client_office printer resolution. */
  clientId?: string | null;
  printableId?: string | null;
}

export type PrintNotificationResult =
  | { skipped: string }
  | { sent: true }
  | { sent: false; error: string };

export async function printNotificationChannel(
  args: PrintNotificationArgs,
): Promise<PrintNotificationResult> {
  const [tpl] = await args.db
    .select({
      body: notificationTemplates.body,
      enabled: notificationTemplates.enabled,
      printerMode: notificationTemplates.printerMode,
      printerId: notificationTemplates.printerId,
    })
    .from(notificationTemplates)
    .where(
      and(
        eq(notificationTemplates.firmId, args.firmId),
        eq(notificationTemplates.kind, args.kind),
        eq(notificationTemplates.channel, 'PRINT'),
      ),
    )
    .limit(1);
  if (!tpl || !tpl.enabled || !tpl.body) return { skipped: 'no_print_template' };

  const gateway = await resolvePrintGateway(args.db, args.firmId);
  if (!gateway || !gateway.enabled) return { skipped: 'gateway_disabled' };

  let printerId: number | null;
  if (tpl.printerMode === 'client_office') {
    let officeId: string | null = null;
    if (args.clientId) {
      const [c] = await args.db
        .select({ officeId: clients.officeId })
        .from(clients)
        .where(eq(clients.id, args.clientId))
        .limit(1);
      officeId = c?.officeId ?? null;
    }
    printerId = await resolveOfficePrinter(args.db, args.firmId, officeId);
  } else {
    printerId = tpl.printerId ?? null;
  }

  if (printerId == null) {
    await args.db
      .insert(printLog)
      .values({
        firmId: args.firmId,
        appUserId: null,
        printableType: `notification:${args.kind}`,
        printableId: args.printableId ?? null,
        printerId: 0,
        status: 'FAILED',
        error: 'no_printer_assigned',
      })
      .catch(() => undefined);
    return { skipped: 'no_printer' };
  }

  const rendered = renderNotification({
    override: { subject: null, body: tpl.body },
    fallback: { subject: null, body: tpl.body },
    context: args.context,
  });
  const firmScopeObj = (args.context.firm ?? {}) as Record<string, unknown>;
  const firmName = String(firmScopeObj['displayName'] || firmScopeObj['name'] || 'Firm');
  const pdf = await renderHtmlToPdf(wrapHtml(firmName, rendered.body));

  const result = await sendToPrinter({
    db: args.db,
    firmId: args.firmId,
    appUserId: null,
    printableType: `notification:${args.kind}`,
    printableId: args.printableId ?? null,
    pdf,
    printerId,
    copies: 1,
    gateway,
  });
  return result.ok ? { sent: true } : { sent: false, error: result.error };
}
