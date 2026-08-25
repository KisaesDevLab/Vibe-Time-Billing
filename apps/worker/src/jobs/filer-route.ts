// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Vibe Filer route + undo worker. Relocates an inbox object into a
// client's folder tree (server-side copy → log → delete inbox original),
// idempotently, and reverses it on undo. Tax-flagged rows additionally
// hand the freshly-filed file to the Tax Return pipeline.
//
// Ordering keeps the original safe: copy first, write the success log,
// THEN delete the inbox original, THEN drop the inbox_items row — so a
// crash never loses the source and a retry is a no-op (the success log
// guards re-copy).

import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import { inboxItems, inboxRoutingLog, files, taxReturns } from '@vibe/db/schema';
import type { StorageClient } from '@vibe/storage';
import {
  joinTargetPath,
  resolveYearSubfolder,
  stripIdSegment,
  type YearBehavior,
} from '@vibe/core/filer';

// Cross-app imports follow the established worker pattern (see the ~30
// existing ../../../api/src imports); shared-package extraction is a
// separate refactor.
import { emitAudit } from '../../../api/src/auth/audit';
import { fileExistingObjectIntoClientFolder } from '../../../api/src/clients/file-existing';
import { createTaxReturnFromFileCore } from '../../../api/src/tax-returns/intake-core';
import { loadK1Config } from '../../../api/src/filer/scan';

const TAX_RETURN_SUBFOLDER = 'Tax Returns/';

export interface FilerRouteJob {
  kind: 'route' | 'undo';
  firmId: string;
  actorId: string;
  batchId?: string;
  itemId?: string;
  logId?: string;
  /** 0229 — K-1 destination resolved at commit (batch-consistent); older
   *  queued jobs without it fall back to a live profile load. */
  k1Config?: { targetPath: string; yearBehavior: string };
}

export async function runFilerRoute(
  db: Database,
  storage: StorageClient,
  log: Logger,
  job: FilerRouteJob,
): Promise<void> {
  if (job.kind === 'undo') {
    await runUndo(db, storage, log, job);
    return;
  }
  await runRoute(db, storage, log, job);
}

async function runRoute(
  db: Database,
  storage: StorageClient,
  log: Logger,
  job: FilerRouteJob,
): Promise<void> {
  const [item] = await db
    .select()
    .from(inboxItems)
    .where(and(eq(inboxItems.id, job.itemId!), eq(inboxItems.firmId, job.firmId)))
    .limit(1);
  if (!item) {
    // Row already removed by a prior successful attempt → nothing to do.
    return;
  }

  // 0229 — a staff-confirmed K-1 recipient gets an additional copy of
  // the PDF into their own folder, in this same job, before the inbox
  // source is deleted. A row confirmed but no longer eligible (recipient
  // equals the entity after a primary re-match, or FK-nulled client) is
  // surfaced as a visible failed log, never silently skipped.
  const k1Confirmed = item.k1Status === 'confirmed';
  const needsK1 =
    k1Confirmed && item.k1MatchedClient != null && item.k1MatchedClient !== item.matchedClient;

  // Idempotency: a prior attempt may have copied + logged but not yet
  // cleaned up. Success logs are discriminated by action so a logged
  // primary copy doesn't suppress a still-pending K-1 recipient copy
  // (and vice versa) on retry. The primary guard stays batch-scoped
  // (pre-existing semantics); the K-1 guard is CROSS-batch for the same
  // recipient, so undoing just the primary row and re-committing cannot
  // stack a second recipient copy beside the still-live first one.
  const priorLogs = await db
    .select({ id: inboxRoutingLog.id, action: inboxRoutingLog.action })
    .from(inboxRoutingLog)
    .where(
      and(
        eq(inboxRoutingLog.firmId, job.firmId),
        eq(inboxRoutingLog.batchId, job.batchId!),
        eq(inboxRoutingLog.objectKeyFrom, item.objectKey),
        eq(inboxRoutingLog.status, 'success'),
      ),
    );
  const priorPrimary = priorLogs.find((l) => l.action !== 'k1_recipient');
  const priorK1 = needsK1
    ? await db
        .select({ id: inboxRoutingLog.id })
        .from(inboxRoutingLog)
        .where(
          and(
            eq(inboxRoutingLog.firmId, job.firmId),
            eq(inboxRoutingLog.objectKeyFrom, item.objectKey),
            eq(inboxRoutingLog.action, 'k1_recipient'),
            eq(inboxRoutingLog.status, 'success'),
            eq(inboxRoutingLog.clientId, item.k1MatchedClient!),
          ),
        )
        .limit(1)
        .then((r) => r[0])
    : undefined;
  if (priorPrimary) {
    // 'skipped' means the source was already gone — no K-1 copy possible.
    if (needsK1 && !priorK1 && priorPrimary.action !== 'skipped') {
      // Crash window: primary logged, source may already be deleted.
      const sourceHead = await storage.head(item.objectKey);
      if (sourceHead) {
        await routeK1Copy(db, storage, log, job, item);
      } else {
        await k1FailLog(db, job, item, 'k1_source_missing');
      }
    }
    await storage.delete(item.objectKey).catch(() => undefined);
    await db.delete(inboxItems).where(eq(inboxItems.id, item.id));
    return;
  }

  // Source already gone (staffer pulled it in Explorer) → skipped.
  const head = await storage.head(item.objectKey);
  if (!head) {
    await db.insert(inboxRoutingLog).values({
      batchId: job.batchId!,
      firmId: job.firmId,
      objectKeyFrom: item.objectKey,
      clientId: item.matchedClient,
      action: 'skipped',
      userId: job.actorId,
      status: 'success',
    });
    await db.delete(inboxItems).where(eq(inboxItems.id, item.id));
    return;
  }

  if (!item.matchedClient) {
    await failLog(db, job, item.objectKey, null, 'no_matched_client');
    return;
  }

  // flag_tax files into the tax subfolder (legacy behavior);
  // file_flag_tax files to the normal routed destination AND flags.
  const isTax = item.reviewAction === 'flag_tax' || item.reviewAction === 'file_flag_tax';
  const subfolder =
    item.reviewAction === 'flag_tax'
      ? (item.overrideFolder ?? TAX_RETURN_SUBFOLDER)
      : (item.overrideFolder ?? item.suggestedPath ?? '');
  const destName = stripIdSegment(item.originalName, item.parsedId);

  const filed = await fileExistingObjectIntoClientFolder(db, storage, {
    firmId: job.firmId,
    clientId: item.matchedClient,
    actorId: job.actorId,
    subfolderPath: subfolder,
    originalFilename: destName,
    sourceKey: item.objectKey,
    sizeBytes: item.sizeBytes,
    etag: item.etag,
    source: 'filer',
  });
  if (!filed.ok) {
    await failLog(db, job, item.objectKey, item.matchedClient, filed.code);
    return;
  }

  // Tax hand-off — create the return from the freshly-filed file. Skip the
  // PDF outline parse here (storage=null): the worker has no pdfjs; staff
  // re-parse from the Tax module. The catch-all section is seeded.
  let taxReturnId: string | null = null;
  if (isTax) {
    const taxYear = item.flagTaxYear ?? item.parsedYear ?? new Date().getUTCFullYear();
    const formCode = (item.flagFormCode ?? '').trim() || '1040';
    // Parse-free core (worker has no pdfjs); staff re-parse from the Tax
    // module. The catch-all section is seeded.
    const tr = await createTaxReturnFromFileCore(db, {
      firmId: job.firmId,
      fileId: filed.fileId,
      taxYear,
      formCode,
      actorId: job.actorId,
    });
    if (tr.ok) taxReturnId = tr.taxReturnId;
    else log.warn({ code: tr.code, fileId: filed.fileId }, 'filer: tax intake failed');
  }

  await db.insert(inboxRoutingLog).values({
    batchId: job.batchId!,
    firmId: job.firmId,
    objectKeyFrom: item.objectKey,
    objectKeyTo: filed.storageKey,
    clientId: item.matchedClient,
    folderPath: subfolder,
    action: isTax ? 'tax_flagged' : 'filed',
    ruleId: item.suggestedRule,
    routedFileId: filed.fileId,
    taxReturnId,
    userId: job.actorId,
    status: 'success',
  });

  // K-1 recipient copy — after the primary log (so a crash here retries
  // only this leg) and before the source delete (so the copy has a source).
  // Failures fail-log and fall through to cleanup: the primary already
  // filed, and blocking cleanup would wedge the item into duplicate
  // primary copies on re-commit (review finding).
  if (needsK1 && !priorK1) {
    await routeK1Copy(db, storage, log, job, item);
  } else if (k1Confirmed && !needsK1) {
    await k1FailLog(
      db,
      job,
      item,
      item.k1MatchedClient == null ? 'k1_client_missing' : 'k1_same_as_entity',
    );
  }

  // Delete the inbox original, then drop the workqueue row.
  await storage
    .delete(item.objectKey)
    .catch((err: unknown) =>
      log.warn(
        { err, key: item.objectKey },
        'filer: inbox delete failed (orphan; next scan re-routes)',
      ),
    );
  await db.delete(inboxItems).where(eq(inboxItems.id, item.id));
}

/**
 * 0229 — file the K-1 recipient's copy. Destination comes from the
 * per-row override (nullish check — an explicit '' means client root,
 * mirroring the primary leg's override semantics) or the batch's
 * commit-time config. Failures NEVER throw: the primary success log is
 * already written, and a throwing leg would block cleanup and turn
 * re-commits into duplicate primary copies — instead a visible
 * 'failed' log row is written and the caller proceeds to cleanup.
 */
async function routeK1Copy(
  db: Database,
  storage: StorageClient,
  log: Logger,
  job: FilerRouteJob,
  item: typeof inboxItems.$inferSelect,
): Promise<void> {
  let subfolder = item.k1OverrideFolder;
  if (subfolder == null) {
    const cfg = job.k1Config
      ? // reason: the payload value came from loadK1Config, whose column is
        // CHECK-constrained to the YearBehavior union (0229).
        {
          targetPath: job.k1Config.targetPath,
          yearBehavior: job.k1Config.yearBehavior as YearBehavior,
        }
      : await loadK1Config(db, job.firmId);
    const yearSub = resolveYearSubfolder(item.overrideYear ?? item.parsedYear, cfg.yearBehavior);
    if (yearSub === null) {
      // Year required but none parsed — file at the base path rather
      // than losing the verified copy.
      log.warn({ itemId: item.id }, 'filer: k1 copy has no year; filing at base path');
      subfolder = cfg.targetPath;
    } else {
      subfolder = joinTargetPath(cfg.targetPath, yearSub);
    }
  }

  const filed = await fileExistingObjectIntoClientFolder(db, storage, {
    firmId: job.firmId,
    clientId: item.k1MatchedClient!,
    actorId: job.actorId,
    subfolderPath: subfolder,
    originalFilename: stripIdSegment(item.originalName, item.parsedId),
    sourceKey: item.objectKey,
    sizeBytes: item.sizeBytes,
    etag: item.etag,
    source: 'filer',
  });
  if (!filed.ok) {
    log.warn({ itemId: item.id, code: filed.code }, 'filer: k1 recipient copy failed');
    await k1FailLog(db, job, item, `k1_${filed.code}`);
    return;
  }

  await db.insert(inboxRoutingLog).values({
    batchId: job.batchId!,
    firmId: job.firmId,
    objectKeyFrom: item.objectKey,
    objectKeyTo: filed.storageKey,
    clientId: item.k1MatchedClient,
    folderPath: subfolder,
    action: 'k1_recipient',
    routedFileId: filed.fileId,
    userId: job.actorId,
    status: 'success',
  });
}

/** Visible 'failed' history row for a K-1 leg that could not file. */
async function k1FailLog(
  db: Database,
  job: FilerRouteJob,
  item: typeof inboxItems.$inferSelect,
  error: string,
): Promise<void> {
  await db.insert(inboxRoutingLog).values({
    batchId: job.batchId!,
    firmId: job.firmId,
    objectKeyFrom: item.objectKey,
    clientId: item.k1MatchedClient,
    action: 'failed',
    userId: job.actorId,
    status: 'error',
    error,
  });
}

async function failLog(
  db: Database,
  job: FilerRouteJob,
  from: string,
  clientId: string | null,
  error: string,
): Promise<void> {
  await db.insert(inboxRoutingLog).values({
    batchId: job.batchId!,
    firmId: job.firmId,
    objectKeyFrom: from,
    clientId,
    action: 'failed',
    userId: job.actorId,
    status: 'error',
    error,
  });
}

async function runUndo(
  db: Database,
  storage: StorageClient,
  log: Logger,
  job: FilerRouteJob,
): Promise<void> {
  const [row] = await db
    .select()
    .from(inboxRoutingLog)
    .where(and(eq(inboxRoutingLog.id, job.logId!), eq(inboxRoutingLog.firmId, job.firmId)))
    .limit(1);
  if (!row || row.status !== 'success' || !row.objectKeyTo) return;

  // 0229 — undo of a K-1 recipient copy removes ONLY that copy. Source
  // restoration and the inbox stub belong solely to the primary
  // ('filed'/'tax_flagged') row's undo, so batch undo composes: the two
  // legs touch disjoint keys and restore exactly one inbox object.
  if (row.action === 'k1_recipient') {
    try {
      await storage.delete(row.objectKeyTo);
    } catch (err) {
      log.warn({ err, logId: row.id }, 'filer undo: k1 copy delete failed');
      return;
    }
    await db.transaction(async (tx) => {
      if (row.routedFileId) {
        await tx.update(files).set({ deletedAt: new Date() }).where(eq(files.id, row.routedFileId));
      }
      await tx
        .update(inboxRoutingLog)
        .set({ status: 'reversed' })
        .where(eq(inboxRoutingLog.id, row.id));
    });
    await emitAudit(db, {
      action: 'UPDATE',
      entityType: 'file',
      entityId: row.routedFileId,
      actorAppUserId: job.actorId,
      after: { k1UndoRevert: true, logId: row.id, objectKey: row.objectKeyTo },
    }).catch(() => undefined);
    return;
  }

  // Restore the inbox original (copy routed → inbox key), then remove the
  // routed copy + soft-delete the files row.
  try {
    await storage.copy(row.objectKeyTo, row.objectKeyFrom);
    await storage.delete(row.objectKeyTo);
  } catch (err) {
    log.warn({ err, logId: row.id }, 'filer undo: storage restore failed');
    return;
  }
  if (row.routedFileId) {
    await db.update(files).set({ deletedAt: new Date() }).where(eq(files.id, row.routedFileId));
  }
  // Drop an unreleased tax return created by this routing.
  if (row.taxReturnId) {
    await db
      .delete(taxReturns)
      .where(
        and(
          eq(taxReturns.id, row.taxReturnId),
          eq(taxReturns.firmId, job.firmId),
          eq(taxReturns.status, 'DRAFT'),
        ),
      );
  }
  await db
    .update(inboxRoutingLog)
    .set({ status: 'reversed' })
    .where(eq(inboxRoutingLog.id, row.id));

  // Re-surface in the inbox on the next scan (best-effort upsert now).
  await db
    .insert(inboxItems)
    .values({
      firmId: job.firmId,
      objectKey: row.objectKeyFrom,
      originalName: row.objectKeyFrom.slice(row.objectKeyFrom.lastIndexOf('/') + 1),
      matchStatus: 'unparseable',
    })
    .onConflictDoNothing();
  // The next inbox scan re-parses + re-matches the restored object.
}
