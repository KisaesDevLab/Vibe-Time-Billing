// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Parse-free core of tax-return intake: turn an existing files row into a
// DRAFT/ORIGINAL tax return (row + seed catch-all section + audit). Kept
// separate from intake.ts so the worker (no pdfjs) can create returns
// without dragging the PDF outline parser into its build. The API's
// intakeTaxReturnFromFile wraps this and adds the best-effort parse.

import { and, eq, isNull } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { files, taxReturnSections, taxReturns } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { logger } from '../logger';
import { matchEngagementForReturn } from './engagement-match';

export interface IntakeTaxReturnArgs {
  firmId: string;
  fileId: string;
  taxYear: number;
  formCode: string;
  jurisdiction?: string;
  title?: string;
  engagementId?: string | null;
  totalPages?: number | null;
  actorId: string;
  ip?: string | null;
  userAgent?: string | null;
}

export type IntakeTaxReturnResult =
  | { ok: true; taxReturnId: string; fileStorageKey: string | null }
  | {
      ok: false;
      code: 'file_not_found' | 'file_pending_upload' | 'already_flagged';
      taxReturnId?: string;
    };

/**
 * Create the tax return from a files row. Returns the source storageKey so
 * the API wrapper can run a best-effort outline parse afterwards.
 */
export async function createTaxReturnFromFileCore(
  db: Database,
  args: IntakeTaxReturnArgs,
): Promise<IntakeTaxReturnResult> {
  const [file] = await db
    .select({
      id: files.id,
      firmId: files.firmId,
      clientId: files.clientId,
      originalFilename: files.originalFilename,
      sha256: files.sha256,
      storageKey: files.storageKey,
      deletedAt: files.deletedAt,
      pendingUpload: files.pendingUpload,
    })
    .from(files)
    .where(eq(files.id, args.fileId))
    .limit(1);
  if (!file || file.firmId !== args.firmId || file.deletedAt) {
    return { ok: false, code: 'file_not_found' };
  }
  if (file.pendingUpload) return { ok: false, code: 'file_pending_upload' };

  const [existing] = await db
    .select({ id: taxReturns.id })
    .from(taxReturns)
    .where(
      and(
        eq(taxReturns.firmId, args.firmId),
        eq(taxReturns.sourceFileId, file.id),
        isNull(taxReturns.amendsReturnId),
      ),
    )
    .limit(1);
  if (existing) return { ok: false, code: 'already_flagged', taxReturnId: existing.id };

  const jurisdiction = args.jurisdiction?.trim() || 'federal';
  const title =
    args.title?.trim() || `${args.formCode} · ${args.taxYear} · ${file.originalFilename}`;

  // Tie the return to the client's engagement when one is supplied; otherwise
  // best-effort auto-match (unique ACTIVE engagement of the same returnType +
  // taxYear). Ambiguous/none → null, staff link it manually on the return.
  const engagementId =
    args.engagementId ??
    (file.clientId
      ? await matchEngagementForReturn(db, {
          clientId: file.clientId,
          formCode: args.formCode,
          taxYear: args.taxYear,
        }).catch(() => null)
      : null);

  const taxReturnId = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(taxReturns)
      .values({
        firmId: args.firmId,
        clientId: file.clientId,
        engagementId,
        taxYear: args.taxYear,
        formCode: args.formCode,
        jurisdiction,
        title,
        status: 'DRAFT',
        releaseKind: 'ORIGINAL',
        sourceFileId: file.id,
        sourceFileSha256: file.sha256,
        totalPages: args.totalPages ?? null,
      })
      .returning({ id: taxReturns.id });
    if (!row) throw new Error('tax_return_insert_failed');
    await tx.insert(taxReturnSections).values({
      returnId: row.id,
      ordinal: 0,
      depth: 0,
      rawTitle: 'Full return',
      normalizedTitle: 'Full return',
      kind: 'UNKNOWN',
      startPage: 1,
      endPage: args.totalPages ?? 1,
      releasable: true,
      parseConfidence: 0,
      isManualOverride: true,
    });
    return row.id;
  });

  await emitAudit(db, {
    action: 'CREATE',
    entityType: 'tax_return',
    entityId: taxReturnId,
    actorAppUserId: args.actorId,
    after: {
      kind: 'intake_from_file',
      fileId: file.id,
      clientId: file.clientId,
      taxYear: args.taxYear,
      formCode: args.formCode,
      jurisdiction,
    },
    ip: args.ip ?? null,
    userAgent: args.userAgent ?? null,
  }).catch((err: unknown) => logger.warn({ err }, 'intake audit emit failed'));

  return { ok: true, taxReturnId, fileStorageKey: file.storageKey };
}
