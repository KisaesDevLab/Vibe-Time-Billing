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
import type { z } from 'zod';

import { intakeFiles, intakeSessions } from '@vibe/db/schema';
import { composeFilename } from '@vibe/core/filer';
import { normalizeDocType, stripPiiFields } from '@vibe/core/ai';

import { getAiRuntime } from '../ai/ai-runtime';
import { runAiCompletion } from '../ai/routes';
import { getApplianceLockState } from '../crypto/boot';
import { logger } from '../logger';
import {
  FILE_NAMING_SCHEMA,
  FileNamingOutputSchema,
  NAMING_SYSTEM_PROMPT,
  buildNamingPrompt,
  getNamingStorage,
  loadNamingSettings,
  type AiNamingDeps,
} from '../files/ai-naming';
import { NAMING_MAX_BYTES, extractForNaming } from '../files/extract-for-naming';
import { unwrapIntakeRecordKey, decField } from './crypto';

export const INTAKE_AI_LABEL_QUEUE = 'intake-ai-label';

export interface IntakeAiLabelJob {
  sessionId: string;
  firmId: string;
}

/** Name shown for the assembled scan PDF (mirrors staff-routes). */
const SCAN_DISPLAY_NAME = 'Scanned documents.pdf';

/** Image kinds intake-process embeds into the assembled scan PDF (its EMBEDDABLE set). */
const ASSEMBLED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png']);

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
  const db = deps.db;
  const finalAttempt = jobMeta ? jobMeta.attemptsMade + 1 >= jobMeta.maxAttempts : true;

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
    .select()
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
    const embedded = rows.filter(
      (f) => f.kind === 'upload' && ASSEMBLED_IMAGE_MIMES.has((f.mimeType ?? '').toLowerCase()),
    );
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
      rows = rows.filter((f) => !embedded.some((e) => e.id === f.id));
    }
    if (rows.length === 0) return 'skipped';
  }

  let labeled = 0;
  let failed = 0;
  for (const f of rows) {
    const filename =
      f.kind === 'scan' ? SCAN_DISPLAY_NAME : (decField(dek, f.originalFilenameEnc) ?? 'upload');

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

    let model: string | null = null;
    let errorCode: string | undefined;
    const raw = await runAiCompletion(deps, {
      firmId: job.firmId,
      feature: 'file-naming',
      systemPrompt: NAMING_SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 300,
      attachments: extracted.images,
      jsonSchema: { name: 'file_naming', schema: FILE_NAMING_SCHEMA, strict: true },
      onResult: (r) => {
        model = r.model ?? null;
      },
      onError: (e) => {
        errorCode = e.code;
      },
    });
    if (raw == null) {
      // No vision-capable provider is a router-configuration state, not a
      // transient fault — skip the whole session, don't retry.
      if (errorCode === 'no_vision_provider') {
        await markPending(deps, job.sessionId, 'skipped');
        return 'skipped';
      }
      return transient('ai_unavailable');
    }

    let parsed: z.infer<typeof FileNamingOutputSchema>;
    try {
      const jsonStart = raw.indexOf('{');
      const jsonEnd = raw.lastIndexOf('}');
      parsed = FileNamingOutputSchema.parse(
        JSON.parse(jsonStart >= 0 && jsonEnd > jsonStart ? raw.slice(jsonStart, jsonEnd + 1) : raw),
      );
    } catch (err) {
      logger.warn({ err, fileId: f.id }, 'intake-ai-label: model output did not match schema');
      await db.update(intakeFiles).set({ aiLabelStatus: 'failed' }).where(eq(intakeFiles.id, f.id));
      failed += 1;
      continue;
    }

    const fields = stripPiiFields({
      doc_type: normalizeDocType(parsed.doc_type),
      issuer: parsed.issuer,
      year: parsed.year,
      period: parsed.period,
      date: parsed.date,
    });
    // A label with nothing informative would rebuild to just the client
    // name at dispose — record it as failed, not labeled.
    if (
      fields.doc_type == null &&
      fields.year == null &&
      fields.issuer == null &&
      fields.period == null &&
      fields.date == null
    ) {
      await db.update(intakeFiles).set({ aiLabelStatus: 'failed' }).where(eq(intakeFiles.id, f.id));
      failed += 1;
      continue;
    }
    // No bound client yet — the {client}/{client_id} slots collapse; the
    // dispose handler recomposes with the real client once known.
    const suggested = composeFilename(
      settings.pattern,
      { ...fields, client: '', client_id: null, original: '' },
      filename,
    );

    await db
      .update(intakeFiles)
      .set({
        aiDocType: fields.doc_type,
        aiTaxYear: fields.year != null ? Number(fields.year) : null,
        aiIssuer: fields.issuer,
        aiPeriod: fields.period,
        aiDocDate: fields.date,
        aiSuggestedName: suggested,
        aiConfidence: parsed.confidence,
        aiLabelStatus: 'labeled',
        aiLabelModel: model,
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
