// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0230 — intake-arrival AI labeling (router-mode only). Consumer.
//
// The worker's intake-process job enqueues one job per received session;
// this consumer runs in the API process (pdfjs, @napi-rs/canvas,
// runAiCompletion and the firm key manager all live here — the worker
// deliberately holds none of them). Each clean intake file gets doc type /
// tax year / issuer / suggested-name columns so staff see what a document
// is BEFORE dispositioning; dispose rebuilds the final filename from the
// stored label with no second model call.
//
// Labels never block the intake flow: failures mark rows 'failed',
// disabled features mark rows 'skipped', and staff can always dispose.

import { Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { and, eq, inArray } from 'drizzle-orm';

import { intakeFiles, intakeSessions } from '@vibe/db/schema';
import { composeFilename } from '@vibe/core/filer';

import { getAiRuntime } from '../ai/ai-runtime';
import { getApplianceLockState } from '../crypto/boot';
import { logger } from '../logger';
import {
  buildNamingPrompt,
  getNamingStorage,
  loadNamingSettings,
  runNamingModel,
  type AiNamingDeps,
} from '../files/ai-naming';
import { NAMING_MAX_BYTES, extractForNaming } from '../files/extract-for-naming';
import { SCAN_DISPLAY_NAME, isEmbeddableImage } from './constants';
import { unwrapIntakeRecordKey, decField } from './crypto';

export const INTAKE_AI_LABEL_QUEUE = 'intake-ai-label';

export interface IntakeAiLabelJob {
  sessionId: string;
  firmId: string;
}

async function markPending(
  deps: AiNamingDeps,
  sessionId: string,
  status: 'skipped' | 'failed',
): Promise<void> {
  await deps
    .db!.update(intakeFiles)
    .set({ aiLabelStatus: status })
    .where(and(eq(intakeFiles.sessionId, sessionId), eq(intakeFiles.aiLabelStatus, 'pending')));
}

/** The unit of work; exported so tests can drive it without BullMQ. */
export async function processIntakeAiLabelJob(
  deps: AiNamingDeps,
  job: IntakeAiLabelJob,
  jobMeta?: { attemptsMade: number; maxAttempts: number },
): Promise<'labeled' | 'partial' | 'skipped' | 'failed'> {
  if (!deps.db) return 'skipped';
  const finalAttempt = jobMeta ? jobMeta.attemptsMade + 1 >= jobMeta.maxAttempts : true;
  try {
    return await labelSession(deps, job, finalAttempt);
  } catch (err) {
    // Deliberate transient throws retry until the final attempt; an
    // UNEXPECTED throw must not strand rows on 'pending' either (review
    // finding — e.g. pickProvider throwing on missing router creds).
    if (!finalAttempt) throw err;
    logger.warn({ err, ...job }, 'intake-ai-label: unexpected failure on final attempt');
    await markPending(deps, job.sessionId, 'failed').catch(() => undefined);
    return 'failed';
  }
}

async function labelSession(
  deps: AiNamingDeps,
  job: IntakeAiLabelJob,
  finalAttempt: boolean,
): Promise<'labeled' | 'partial' | 'skipped' | 'failed'> {
  const db = deps.db!;

  // Transient-or-fail helper: retry while attempts remain, else mark the
  // rows failed so the UI never shows "labeling…" forever. Returns
  // 'failed' (not 'skipped') so the operator log distinguishes total
  // failure from a deliberate no-op.
  const transient = async (reason: string): Promise<'failed'> => {
    if (!finalAttempt) throw new Error(`intake-ai-label transient: ${reason}`);
    logger.warn({ ...job, reason }, 'intake-ai-label: giving up after final attempt');
    await markPending(deps, job.sessionId, 'failed');
    return 'failed';
  };

  // Permanent gates → skipped.
  if (getAiRuntime().mode !== 'router') {
    await markPending(deps, job.sessionId, 'skipped');
    return 'skipped';
  }
  const settings = await loadNamingSettings(db, job.firmId);
  if (!settings.autoRenameUploads) {
    await markPending(deps, job.sessionId, 'skipped');
    return 'skipped';
  }
  const [session] = await db
    .select({
      id: intakeSessions.id,
      status: intakeSessions.status,
      wrappedDek: intakeSessions.wrappedDek,
    })
    .from(intakeSessions)
    .where(and(eq(intakeSessions.id, job.sessionId), eq(intakeSessions.firmId, job.firmId)))
    .limit(1);
  if (!session || session.status !== 'received') {
    await markPending(deps, job.sessionId, 'skipped');
    return 'skipped';
  }

  // Transient gates.
  if (getApplianceLockState().kind !== 'unlocked') return transient('appliance_locked');
  const storage = getNamingStorage(deps);
  if (!storage) return transient('storage_unavailable');

  let dek: Uint8Array;
  try {
    dek = unwrapIntakeRecordKey(db, job.firmId, session.wrappedDek);
  } catch (err) {
    logger.warn({ err, ...job }, 'intake-ai-label: could not unwrap record key');
    return transient('key_unavailable');
  }

  const allClean = await db
    .select({
      id: intakeFiles.id,
      kind: intakeFiles.kind,
      mimeType: intakeFiles.mimeType,
      byteSize: intakeFiles.byteSize,
      objectKey: intakeFiles.objectKey,
      createdAt: intakeFiles.createdAt,
      aiLabelStatus: intakeFiles.aiLabelStatus,
      originalFilenameEnc: intakeFiles.originalFilenameEnc,
    })
    .from(intakeFiles)
    .where(and(eq(intakeFiles.sessionId, job.sessionId), eq(intakeFiles.scanStatus, 'clean')));
  let rows = allClean.filter((f) => f.aiLabelStatus === 'pending');
  if (rows.length === 0) return 'skipped';

  // The assembled scan PDF embeds the session's JPG/PNG page images —
  // labeling each page AND the PDF built from those pages is N+1 model
  // calls on the same content. When a scan row exists, skip the embedded
  // image kinds; other uploads (PDFs, HEIC/TIFF that were not assembled)
  // are still labeled individually.
  const hasAssembledScan = allClean.some((f) => f.kind === 'scan');
  if (hasAssembledScan) {
    const isEmbedded = (f: (typeof rows)[number]): boolean =>
      f.kind === 'upload' && isEmbeddableImage(f.mimeType);
    const embedded = rows.filter(isEmbedded);
    if (embedded.length > 0) {
      await db
        .update(intakeFiles)
        .set({ aiLabelStatus: 'skipped' })
        .where(
          inArray(
            intakeFiles.id,
            embedded.map((f) => f.id),
          ),
        );
      rows = rows.filter((f) => !isEmbedded(f));
    }
    if (rows.length === 0) return 'skipped';
  }

  let labeled = 0;
  let failed = 0;
  for (const f of rows) {
    // The same fallback names the dispose handler uses — the {original}
    // slot and the composed preview must match the eventually-filed name.
    const filename =
      f.kind === 'scan'
        ? SCAN_DISPLAY_NAME
        : (decField(dek, f.originalFilenameEnc) ?? `intake-${f.id}`);

    // Oversize bodies degrade to metadata-only anyway — don't download them.
    let extracted;
    if (Number(f.byteSize) > NAMING_MAX_BYTES) {
      extracted = { images: [], strategy: 'metadata' as const, text: undefined };
    } else {
      try {
        const { body } = await storage.get(f.objectKey);
        const chunks: Buffer[] = [];
        for await (const c of body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
        extracted = await extractForNaming(Buffer.concat(chunks), f.mimeType);
      } catch (err) {
        logger.warn({ err, fileId: f.id }, 'intake-ai-label: could not read object');
        return transient('storage_unavailable');
      }
    }

    const userPrompt = buildNamingPrompt({
      pattern: settings.pattern,
      examples: settings.examples,
      clientName: '',
      clientId: null,
      subfolderPath: '',
      originalFilename: filename,
      requestTitle: null,
      uploadedAt: f.createdAt,
      text: extracted.text,
      hasImages: extracted.images.length > 0,
    });

    const result = await runNamingModel(deps, {
      firmId: job.firmId,
      userPrompt,
      attachments: extracted.images,
    });
    if (!result.ok) {
      // Firm-configuration states hold for the whole session — skip it
      // rather than burning retries (no vision provider, budget spent).
      if (result.reason === 'no_vision_provider' || result.reason === 'ai_budget_exhausted') {
        await markPending(deps, job.sessionId, 'skipped');
        return 'skipped';
      }
      if (result.reason === 'invalid_output') {
        await db
          .update(intakeFiles)
          .set({ aiLabelStatus: 'failed' })
          .where(eq(intakeFiles.id, f.id));
        failed += 1;
        continue;
      }
      return transient(result.reason);
    }
    // A label with nothing informative would rebuild to just the client
    // name at dispose — record it as failed, not labeled.
    if (!result.informative) {
      await db.update(intakeFiles).set({ aiLabelStatus: 'failed' }).where(eq(intakeFiles.id, f.id));
      failed += 1;
      continue;
    }

    // No bound client yet — the {client}/{client_id} slots collapse; the
    // dispose handler recomposes with the real client once known.
    const suggested = composeFilename(
      settings.pattern,
      { ...result.fields, client: '', client_id: null, original: '' },
      filename,
    );

    await db
      .update(intakeFiles)
      .set({
        // rawDocType keeps 'Other' for the label chip even though it is
        // excluded from composed filenames.
        aiDocType: result.rawDocType,
        aiTaxYear: result.fields.year != null ? Number(result.fields.year) : null,
        aiIssuer: result.fields.issuer,
        aiPeriod: result.fields.period,
        aiDocDate: result.fields.date,
        aiSuggestedName: suggested,
        aiConfidence: result.confidence,
        aiLabelStatus: 'labeled',
        aiLabelModel: result.model,
      })
      .where(eq(intakeFiles.id, f.id));
    labeled += 1;
  }

  return failed === 0 ? 'labeled' : labeled > 0 ? 'partial' : 'failed';
}

export function startIntakeAiLabelConsumer(deps: AiNamingDeps): Worker<IntakeAiLabelJob> | null {
  const url = process.env['REDIS_URL'] ?? null;
  if (
    !url ||
    process.env['INTAKE_AI_LABEL_CONSUMER'] === '0' ||
    process.env['NODE_ENV'] === 'test'
  ) {
    return null;
  }
  const connection = new IORedis(url, { maxRetriesPerRequest: null });
  const worker = new Worker<IntakeAiLabelJob>(
    INTAKE_AI_LABEL_QUEUE,
    async (job: Job<IntakeAiLabelJob>) => {
      const outcome = await processIntakeAiLabelJob(deps, job.data, {
        attemptsMade: job.attemptsMade,
        maxAttempts: job.opts.attempts ?? 1,
      });
      logger.info({ sessionId: job.data.sessionId, outcome }, 'intake-ai-label job done');
    },
    { connection, concurrency: 1 },
  );
  worker.on('failed', (job, err) => {
    logger.warn(
      { err, sessionId: job?.data.sessionId, attempts: job?.attemptsMade },
      'intake-ai-label job failed',
    );
  });
  logger.info({ queue: INTAKE_AI_LABEL_QUEUE }, 'intake-ai-label consumer started');
  return worker;
}
