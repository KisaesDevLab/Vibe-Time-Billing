// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0185/0187 — auto-print when a tax-return signature completes. Enqueued
// from the signature-completion paths (webhook + poll). Evaluates the
// firm's configurable print rules (0187): the first matching rule decides
// the template (built-in report or a Vibe Print gateway template) and the
// printer (a specific id or the client office's printer). Falls back to
// the legacy single firm-default behavior when a firm has no rules.

import type { Logger } from 'pino';

import type { Database } from '@vibe/db';

import { renderHtmlToPdf } from '../../../api/src/pdf/render';
import { renderSignatureConfirmationHtml } from '../../../api/src/pdf-templates/signature-confirmation';
import { resolvePrintGateway } from '../../../api/src/print-gateway/config';
import { sendGatewayTemplate, sendToPrinter } from '../../../api/src/print-gateway/send';
import {
  listRules,
  loadSignaturePrintContext,
  matchRule,
  resolveRulePrinter,
} from '../../../api/src/print-gateway/signature-print';

export interface SignatureConfirmationPrintResult {
  skipped?: string;
  sent?: boolean;
  error?: string;
}

interface EffectiveRule {
  templateSource: string;
  gatewayTemplateId: number | null;
  printerMode: string;
  printerId: number | null;
  copies: number;
}

export async function runSignatureConfirmationPrint(
  db: Database,
  log: Logger,
  data: { requestId: string },
): Promise<SignatureConfirmationPrintResult> {
  const loaded = await loadSignaturePrintContext(db, data.requestId);
  if (!loaded.ok) return { skipped: loaded.reason };
  const { ctx } = loaded;

  const gateway = await resolvePrintGateway(db, ctx.firmId);
  if (!gateway || !gateway.enabled) return { skipped: 'gateway_disabled' };

  // Configured rules are authoritative: if the firm has enabled signature
  // print rules, they apply whenever the gateway is enabled — the master
  // "auto-print signature confirmation" toggle governs only the LEGACY
  // zero-rules fallback (builtin report → firm default printer). The gateway
  // "enabled" switch remains the global kill switch.
  const rules = await listRules(db, ctx.firmId);
  const matched = matchRule(rules, {
    formCode: ctx.formCode,
    engagementTypeId: ctx.engagementTypeId,
  });
  let rule: EffectiveRule | null = matched;
  if (
    !rule &&
    rules.length === 0 &&
    gateway.autoPrintSignatureConfirmation &&
    gateway.defaultPrinterId
  ) {
    rule = {
      templateSource: 'builtin',
      gatewayTemplateId: null,
      printerMode: 'specific',
      printerId: gateway.defaultPrinterId,
      copies: 1,
    };
  }
  if (!rule) {
    return {
      skipped:
        rules.length === 0 && !gateway.autoPrintSignatureConfirmation
          ? 'auto_print_off'
          : 'no_matching_rule',
    };
  }

  const printerId = await resolveRulePrinter(
    db,
    ctx.firmId,
    { printerMode: rule.printerMode, printerId: rule.printerId },
    ctx.clientOfficeId,
  );
  if (printerId == null) return { skipped: 'no_printer' };

  const idempotencyKey = `sigconf:${data.requestId}`;
  let result;
  if (rule.templateSource === 'gateway') {
    if (rule.gatewayTemplateId == null) return { skipped: 'no_gateway_template' };
    result = await sendGatewayTemplate({
      db,
      firmId: ctx.firmId,
      printableType: 'signature_confirmation',
      printableId: data.requestId,
      printerId,
      templateId: rule.gatewayTemplateId,
      data: ctx.gatewayData,
      copies: rule.copies,
      idempotencyKey,
      gateway,
    });
  } else {
    const pdf = await renderHtmlToPdf(renderSignatureConfirmationHtml(ctx.builtinData));
    result = await sendToPrinter({
      db,
      firmId: ctx.firmId,
      appUserId: null,
      printableType: 'signature_confirmation',
      printableId: data.requestId,
      pdf,
      printerId,
      copies: rule.copies,
      idempotencyKey,
      gateway,
    });
  }

  if (!result.ok) {
    log.warn(
      { requestId: data.requestId, error: result.error },
      'signature confirmation print failed',
    );
    return { sent: false, error: result.error };
  }
  return { sent: true };
}
