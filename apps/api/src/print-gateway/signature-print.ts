// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Shared logic for the configurable signature-confirmation auto-print:
// load the print context for a completed signature, evaluate the firm's
// rules (first match by priority), and resolve the destination printer.
// Lives in apps/api so the worker consumer can reuse it.

import { and, asc, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  clients,
  engagements,
  firms,
  signaturePrintRules,
  signatureRequests,
  signatureSigners,
  taxReturns,
} from '@vibe/db/schema';

import type { SignatureConfirmationInput } from '../pdf-templates/signature-confirmation';
import { resolveOfficePrinter } from './assignments';

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : String(d);
}

export interface SignaturePrintContext {
  firmId: string;
  /** For rule matching. */
  formCode: string | null;
  engagementTypeId: string | null;
  clientOfficeId: string | null;
  /** Data for the built-in confirmation report. */
  builtinData: SignatureConfirmationInput;
  /** Stable payload handed to a Vibe Print gateway template. */
  gatewayData: Record<string, unknown>;
}

export type LoadContextResult =
  | { ok: false; reason: string }
  | { ok: true; ctx: SignaturePrintContext };

/** Load + assemble everything needed to decide and render a signature
 *  auto-print. Gates on completed + tax-return signature. */
export async function loadSignaturePrintContext(
  db: Database,
  requestId: string,
): Promise<LoadContextResult> {
  const [req] = await db
    .select({
      firmId: signatureRequests.firmId,
      title: signatureRequests.title,
      formType: signatureRequests.formType,
      clientId: signatureRequests.clientId,
      engagementId: signatureRequests.engagementId,
      taxReturnId: signatureRequests.taxReturnId,
      status: signatureRequests.status,
      completedAt: signatureRequests.completedAt,
      certificateFileUrl: signatureRequests.certificateFileUrl,
    })
    .from(signatureRequests)
    .where(eq(signatureRequests.id, requestId))
    .limit(1);
  if (!req) return { ok: false, reason: 'not_found' };
  if (!req.taxReturnId) return { ok: false, reason: 'not_tax_return' };
  if (req.status !== 'completed') return { ok: false, reason: 'not_completed' };

  const [ret] = await db
    .select({
      formCode: taxReturns.formCode,
      taxYear: taxReturns.taxYear,
      jurisdiction: taxReturns.jurisdiction,
      engagementId: taxReturns.engagementId,
    })
    .from(taxReturns)
    .where(eq(taxReturns.id, req.taxReturnId))
    .limit(1);

  const engagementId = req.engagementId ?? ret?.engagementId ?? null;
  let engagementTypeId: string | null = null;
  if (engagementId) {
    const [eng] = await db
      .select({ engagementTypeId: engagements.engagementTypeId })
      .from(engagements)
      .where(eq(engagements.id, engagementId))
      .limit(1);
    engagementTypeId = eng?.engagementTypeId ?? null;
  }

  let clientName: string | null = null;
  let clientOfficeId: string | null = null;
  if (req.clientId) {
    const [c] = await db
      .select({ name: clients.name, officeId: clients.officeId })
      .from(clients)
      .where(eq(clients.id, req.clientId))
      .limit(1);
    clientName = c?.name ?? null;
    clientOfficeId = c?.officeId ?? null;
  }

  const [firm] = await db
    .select({ name: firms.name })
    .from(firms)
    .where(eq(firms.id, req.firmId))
    .limit(1);

  const signers = await db
    .select({
      name: signatureSigners.name,
      email: signatureSigners.email,
      signedAt: signatureSigners.signedAt,
    })
    .from(signatureSigners)
    .where(eq(signatureSigners.requestId, requestId));

  const formCode = ret?.formCode ?? req.formType ?? null;
  const completedAt = iso(req.completedAt);
  const certificateAvailable = Boolean(req.certificateFileUrl);

  return {
    ok: true,
    ctx: {
      firmId: req.firmId,
      formCode,
      engagementTypeId,
      clientOfficeId,
      builtinData: {
        firmName: firm?.name ?? 'Firm',
        documentTitle: req.title,
        formType: formCode,
        clientName,
        completedAt,
        certificateAvailable,
        signers: signers.map((s) => ({ name: s.name, email: s.email, signedAt: iso(s.signedAt) })),
      },
      gatewayData: {
        firm: { name: firm?.name ?? 'Firm' },
        client: { name: clientName ?? '' },
        document: { title: req.title },
        form_code: formCode ?? '',
        tax_year: ret?.taxYear ?? null,
        jurisdiction: ret?.jurisdiction ?? '',
        completed_at: completedAt ?? '',
        certificate_available: certificateAvailable,
        signers: signers.map((s) => ({
          name: s.name,
          email: s.email ?? '',
          signed_at: iso(s.signedAt) ?? '',
        })),
      },
    },
  };
}

export type SignaturePrintRule = typeof signaturePrintRules.$inferSelect;

export async function listRules(db: Database, firmId: string): Promise<SignaturePrintRule[]> {
  return db
    .select()
    .from(signaturePrintRules)
    .where(and(eq(signaturePrintRules.firmId, firmId), eq(signaturePrintRules.enabled, true)))
    .orderBy(asc(signaturePrintRules.priority), asc(signaturePrintRules.createdAt));
}

/** First enabled rule (caller passes enabled-only, priority-ordered) whose
 *  filters match. Empty filter array = match any. */
export function matchRule(
  rules: SignaturePrintRule[],
  input: { formCode: string | null; engagementTypeId: string | null },
): SignaturePrintRule | null {
  const fc = input.formCode?.toUpperCase() ?? null;
  for (const r of rules) {
    const codes = (r.formCodes ?? []).map((c) => c.toUpperCase());
    if (codes.length > 0 && (!fc || !codes.includes(fc))) continue;
    const types = r.engagementTypeIds ?? [];
    if (types.length > 0 && (!input.engagementTypeId || !types.includes(input.engagementTypeId)))
      continue;
    return r;
  }
  return null;
}

/** Resolve the printer for a matched rule. `specific` → rule.printerId;
 *  `client_office` → the enabled printer assigned to the client office.
 *  Returns null when unresolved (caller skips + logs). */
export async function resolveRulePrinter(
  db: Database,
  firmId: string,
  rule: Pick<SignaturePrintRule, 'printerMode' | 'printerId'>,
  clientOfficeId: string | null,
): Promise<number | null> {
  if (rule.printerMode === 'specific') return rule.printerId ?? null;
  if (rule.printerMode === 'client_office') return resolveOfficePrinter(db, firmId, clientOfficeId);
  return null;
}
