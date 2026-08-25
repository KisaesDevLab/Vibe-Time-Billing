// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0223 — AI file naming (router-mode only).
//
//   suggestFileName   read the file, extract text / page images, ask the
//                     router (task class timebill_file_naming) for
//                     structured fields, compose the name from the firm's
//                     pattern. Never renames.
//   applyAiRename     rename through the shared primitive, recording the
//                     original name once + confidence/model.
//   revertAiRename    put the original name back.
//   applySuggestedName  promote a stored low-confidence suggestion.
//
// The model never emits a filename — only fields — so the firm convention
// is enforced app-side. Gated on getAiRuntime().mode === 'router' because
// document contents leave the appliance only through the router's policy.

import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import {
  clientRequestAttachments,
  clientRequests,
  clients,
  files,
  firmSettings,
} from '@vibe/db/schema';
import { buildStorageClient, type StorageClient } from '@vibe/storage';
import {
  DEFAULT_NAMING_EXAMPLES,
  DEFAULT_NAMING_PATTERN,
  composeFilename,
  type NamingFields,
} from '@vibe/core/filer';
import { DOC_TYPES, filenameDocType, normalizeDocType, stripPiiFields } from '@vibe/core/ai';

import { getAiRuntime } from '../ai/ai-runtime';
import { runAiCompletion, type AiRoutesDeps } from '../ai/routes';
import { logger } from '../logger';
import { extractForNaming, type ExtractStrategy } from './extract-for-naming';
import { renameFile, type RenameFileResult } from './rename-file';

export interface AiNamingDeps extends AiRoutesDeps {
  storageClient?: StorageClient | null;
}

export function getNamingStorage(deps: AiNamingDeps): StorageClient | null {
  if (deps.storageClient) return deps.storageClient;
  try {
    return buildStorageClient(process.env);
  } catch {
    return null;
  }
}

/** Files produced by the app itself are never auto-renamed. */
export const NON_RENAMEABLE_SOURCES = new Set([
  'generated',
  'mail_merge',
  'template',
  'signature',
  'return',
  'receive_saved',
]);

export type SkipReason =
  | 'not_router_mode'
  | 'file_not_found'
  | 'pending_upload'
  | 'generated_source'
  | 'already_ai_renamed'
  | 'storage_unavailable'
  | 'ai_unavailable'
  | 'ai_failed'
  // Router says no configured provider/model can serve vision (Q-092 in
  // the router repo) — a firm-configuration state, skipped permanently.
  | 'no_vision_provider'
  // Monthly AI budget exhausted — permanent for the rest of the period.
  | 'ai_budget_exhausted'
  | 'invalid_output';

export type SuggestResult =
  | {
      ok: true;
      fileId: string;
      current: string;
      proposed: string;
      confidence: number;
      fields: NamingFields;
      strategy: ExtractStrategy;
      summary: string;
      model: string | null;
    }
  | { ok: false; fileId: string; current?: string; skippedReason: SkipReason };

export interface NamingSettings {
  autoRenameUploads: boolean;
  pattern: string;
  examples: string;
  minConfidence: number;
}

export async function loadNamingSettings(db: Database, firmId: string): Promise<NamingSettings> {
  const [row] = await db
    .select({
      autoRenameUploads: firmSettings.autoRenameUploads,
      pattern: firmSettings.fileNamingPattern,
      examples: firmSettings.fileNamingExamples,
      minConfidence: firmSettings.fileNamingMinConfidence,
    })
    .from(firmSettings)
    .where(eq(firmSettings.firmId, firmId))
    .limit(1);
  return {
    autoRenameUploads: row?.autoRenameUploads ?? false,
    pattern: row?.pattern || DEFAULT_NAMING_PATTERN,
    examples: row?.examples ?? DEFAULT_NAMING_EXAMPLES,
    minConfidence: row?.minConfidence ?? 0.7,
  };
}

// ---- model contract ---------------------------------------------------------

export const FILE_NAMING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['doc_type', 'issuer', 'year', 'period', 'date', 'confidence', 'summary'],
  properties: {
    // Controlled vocabulary — the model cannot invent doc types.
    doc_type: { type: ['string', 'null'], enum: [...DOC_TYPES, null] },
    issuer: { type: ['string', 'null'], maxLength: 60 },
    year: { type: ['string', 'null'], pattern: '^[0-9]{4}$' },
    period: { type: ['string', 'null'], maxLength: 12 },
    date: { type: ['string', 'null'], pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    summary: { type: 'string', maxLength: 160 },
  },
} as const;

// Deliberately looser than FILE_NAMING_SCHEMA: the SDK's prompt-JSON
// fallback path can produce off-vocabulary doc types, which
// normalizeDocType maps to the vocabulary (unknown → 'Other').
export const FileNamingOutputSchema = z.object({
  doc_type: z.string().max(80).nullable(),
  issuer: z.string().max(80).nullable(),
  year: z
    .string()
    .regex(/^\d{4}$/)
    .nullable(),
  period: z.string().max(20).nullable(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  confidence: z.number().min(0).max(1),
  summary: z.string().max(400).default(''),
});

export const NAMING_SYSTEM_PROMPT = [
  'You name documents for an accounting firm. Return ONLY a JSON object matching the schema.',
  `Identify: doc_type — EXACTLY one of: ${DOC_TYPES.join(', ')}. Use "Other" when none fits.`,
  'issuer (the ORGANISATION that produced the document, e.g. employer, bank, agency — never a person),',
  'year (the tax/statement year as 4 digits), period (e.g. "Q3", "Mar", "2024-03", "FY2023"; null if none), date (document date, YYYY-MM-DD; null if none).',
  'NEVER output Social Security numbers, EINs, account numbers, addresses, dollar amounts, or any personal data in any field.',
  'If a field is unknown set it to null and lower your confidence. confidence = your probability that doc_type and year are correct.',
  'summary: one short neutral sentence about the document type (no personal data).',
].join(' ');

export function buildNamingPrompt(ctx: {
  pattern: string;
  examples: string;
  clientName: string;
  clientId: string | null;
  subfolderPath: string;
  originalFilename: string;
  requestTitle: string | null;
  uploadedAt: Date | null;
  text: string | undefined;
  hasImages: boolean;
}): string {
  const lines = [
    `Firm naming pattern: ${ctx.pattern}`,
    `Examples of good names:\n${ctx.examples}`,
    `Client: ${ctx.clientName}${ctx.clientId ? ` (client id ${ctx.clientId})` : ''}`,
    `Folder: ${ctx.subfolderPath || '(root)'}`,
    `Original filename: ${ctx.originalFilename}`,
    ctx.requestTitle ? `Uploaded in response to request: ${ctx.requestTitle}` : null,
    ctx.uploadedAt ? `Uploaded: ${ctx.uploadedAt.toISOString().slice(0, 10)}` : null,
    '',
    ctx.text
      ? `--- DOCUMENT TEXT (first pages, truncated) ---\n${ctx.text}`
      : ctx.hasImages
        ? '--- No extractable text; the document pages are attached as images. ---'
        : '--- No document contents available; infer what you can from the filename and context. ---',
  ];
  return lines.filter((l) => l !== null).join('\n');
}

// ---- suggest ------------------------------------------------------------------

export async function suggestFileName(
  deps: AiNamingDeps,
  args: {
    firmId: string;
    fileId: string;
    /** Scope to a client (the bulk route has it from the URL). */
    clientId?: string;
    actorId?: string | null;
    mode: 'auto' | 'bulk';
  },
): Promise<SuggestResult> {
  const { fileId } = args;
  if (getAiRuntime().mode !== 'router')
    return { ok: false, fileId, skippedReason: 'not_router_mode' };
  if (!deps.db) return { ok: false, fileId, skippedReason: 'storage_unavailable' };
  const db = deps.db;

  const [file] = await db
    .select({
      id: files.id,
      clientId: files.clientId,
      subfolderPath: files.subfolderPath,
      originalFilename: files.originalFilename,
      storageKey: files.storageKey,
      mimeType: files.mimeType,
      sizeBytes: files.sizeBytes,
      source: files.source,
      pendingUpload: files.pendingUpload,
      uploadedAt: files.uploadedAt,
      aiRenamedAt: files.aiRenamedAt,
      clientName: clients.name,
      clientExternalId: clients.externalId,
    })
    .from(files)
    .innerJoin(clients, eq(clients.id, files.clientId))
    .where(
      and(
        eq(files.id, fileId),
        eq(files.firmId, args.firmId),
        ...(args.clientId ? [eq(files.clientId, args.clientId)] : []),
        isNull(files.deletedAt),
      ),
    )
    .limit(1);
  if (!file) return { ok: false, fileId, skippedReason: 'file_not_found' };
  const current = file.originalFilename;
  if (file.pendingUpload) return { ok: false, fileId, current, skippedReason: 'pending_upload' };
  if (NON_RENAMEABLE_SOURCES.has(file.source)) {
    return { ok: false, fileId, current, skippedReason: 'generated_source' };
  }
  if (args.mode === 'auto' && file.aiRenamedAt) {
    return { ok: false, fileId, current, skippedReason: 'already_ai_renamed' };
  }

  const storage = getNamingStorage(deps);
  if (!storage) return { ok: false, fileId, current, skippedReason: 'storage_unavailable' };

  const [settings, requestRow] = await Promise.all([
    loadNamingSettings(db, args.firmId),
    db
      .select({ title: clientRequests.title })
      .from(clientRequestAttachments)
      .innerJoin(clientRequests, eq(clientRequests.id, clientRequestAttachments.clientRequestId))
      .where(eq(clientRequestAttachments.fileId, fileId))
      .limit(1)
      .then((r) => r[0] ?? null)
      .catch(() => null),
  ]);

  let extracted;
  try {
    const { body } = await storage.get(file.storageKey);
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    extracted = await extractForNaming(Buffer.concat(chunks), file.mimeType);
  } catch (err) {
    logger.warn({ err, fileId }, 'ai-naming: could not read file body');
    return { ok: false, fileId, current, skippedReason: 'storage_unavailable' };
  }

  const userPrompt = buildNamingPrompt({
    pattern: settings.pattern,
    examples: settings.examples,
    clientName: file.clientName,
    clientId: file.clientExternalId,
    subfolderPath: file.subfolderPath,
    originalFilename: current,
    requestTitle: requestRow?.title ?? null,
    uploadedAt: file.uploadedAt,
    text: extracted.text,
    hasImages: extracted.images.length > 0,
  });

  const modelResult = await runNamingModel(deps, {
    firmId: args.firmId,
    ...(args.actorId ? { appUserId: args.actorId } : {}),
    clientId: file.clientId,
    userPrompt,
    attachments: extracted.images,
  });
  if (!modelResult.ok) return { ok: false, fileId, current, skippedReason: modelResult.reason };
  if (!modelResult.informative) {
    // Nothing usable extracted — composing would collapse to just the
    // client name (review finding; mirrors the intake-arrival guard).
    return { ok: false, fileId, current, skippedReason: 'invalid_output' };
  }

  const fields: NamingFields = {
    ...modelResult.fields,
    client: file.clientName,
    client_id: file.clientExternalId,
    original: '',
  };
  const proposed = composeFilename(settings.pattern, fields, current);
  return {
    ok: true,
    fileId,
    current,
    proposed,
    confidence: modelResult.confidence,
    fields,
    strategy: extracted.strategy,
    summary: modelResult.summary,
    model: modelResult.model,
  };
}

// ---- shared model call ---------------------------------------------------------
//
// The ONE place the naming model is invoked and its output parsed,
// normalized, and PII-stripped — used by suggestFileName (0223) and the
// intake-arrival labeler (0230) so the contract cannot drift between them.

export interface NamingModelFields {
  doc_type: string | null;
  issuer: string | null;
  year: string | null;
  period: string | null;
  date: string | null;
}

export type NamingModelResult =
  | {
      ok: true;
      /** PII-stripped, vocabulary-normalized, 'Other' removed from the
       *  filename slot (it stays in `rawDocType` for label storage). */
      fields: NamingModelFields;
      rawDocType: string | null;
      /** True when at least one of doc_type/year/issuer survived — the
       *  minimum for a filename that says anything. */
      informative: boolean;
      confidence: number;
      summary: string;
      model: string | null;
    }
  | {
      ok: false;
      reason: 'ai_failed' | 'no_vision_provider' | 'ai_budget_exhausted' | 'invalid_output';
    };

export async function runNamingModel(
  deps: AiNamingDeps,
  args: {
    firmId: string;
    appUserId?: string | null;
    clientId?: string | null;
    userPrompt: string;
    attachments: Parameters<typeof runAiCompletion>[1]['attachments'];
  },
): Promise<NamingModelResult> {
  let model: string | null = null;
  let errorCode: string | undefined;
  const raw = await runAiCompletion(deps, {
    firmId: args.firmId,
    ...(args.appUserId ? { appUserId: args.appUserId } : {}),
    feature: 'file-naming',
    systemPrompt: NAMING_SYSTEM_PROMPT,
    userPrompt: args.userPrompt,
    maxTokens: 300,
    ...(args.clientId ? { clientId: args.clientId } : {}),
    attachments: args.attachments,
    jsonSchema: { name: 'file_naming', schema: FILE_NAMING_SCHEMA, strict: true },
    onResult: (r) => {
      model = r.model ?? null;
    },
    onError: (e) => {
      errorCode = e.code;
    },
  });
  if (raw == null) {
    const reason =
      errorCode === 'no_vision_provider' || errorCode === 'ai_budget_exhausted'
        ? errorCode
        : 'ai_failed';
    return { ok: false, reason };
  }

  let parsed: z.infer<typeof FileNamingOutputSchema>;
  try {
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    parsed = FileNamingOutputSchema.parse(
      JSON.parse(jsonStart >= 0 && jsonEnd > jsonStart ? raw.slice(jsonStart, jsonEnd + 1) : raw),
    );
  } catch (err) {
    logger.warn({ err }, 'ai-naming: model output did not match schema');
    return { ok: false, reason: 'invalid_output' };
  }

  // PII guard on MODEL-emitted fields only — client/client_id come from
  // the DB (a numeric firm client id would false-positive as an account).
  const rawDocType = normalizeDocType(parsed.doc_type);
  const fields = stripPiiFields({
    doc_type: filenameDocType(rawDocType),
    issuer: parsed.issuer,
    year: parsed.year,
    period: parsed.period,
    date: parsed.date,
  });
  return {
    ok: true,
    fields,
    rawDocType,
    informative: fields.doc_type != null || fields.year != null || fields.issuer != null,
    confidence: parsed.confidence,
    summary: parsed.summary,
    model,
  };
}

// ---- apply / revert ------------------------------------------------------------

export async function applyAiRename(
  deps: AiNamingDeps,
  args: {
    firmId: string;
    fileId: string;
    clientId?: string;
    newFilename: string;
    actorId: string | null;
    confidence: number | null;
    model?: string | null;
  },
): Promise<RenameFileResult> {
  if (!deps.db) return { ok: false, code: 'storage_error', status: 503 };
  const storage = getNamingStorage(deps);
  if (!storage) return { ok: false, code: 'storage_error', status: 503 };
  const now = new Date();
  return renameFile(deps.db, storage, {
    firmId: args.firmId,
    ...(args.clientId ? { clientId: args.clientId } : {}),
    fileId: args.fileId,
    newFilename: args.newFilename,
    actorAppUserId: args.actorId,
    extraSet: {
      // First AI rename remembers what the file arrived as; later ones keep it.
      originalUploadFilename: sql`coalesce(${files.originalUploadFilename}, ${files.originalFilename})`,
      aiRenamedAt: now,
      aiRenameAttemptedAt: now,
      aiRenameConfidence: args.confidence,
      aiRenameModel: args.model ?? null,
      aiSuggestedFilename: null,
    },
    extraAudit: { aiRename: true, confidence: args.confidence },
  });
}

export async function revertAiRename(
  deps: AiNamingDeps,
  args: { firmId: string; fileId: string; clientId?: string; actorId: string },
): Promise<RenameFileResult | { ok: false; code: 'not_ai_renamed'; status: 409 }> {
  if (!deps.db) return { ok: false, code: 'storage_error', status: 503 };
  const storage = getNamingStorage(deps);
  if (!storage) return { ok: false, code: 'storage_error', status: 503 };
  const [row] = await deps.db
    .select({ original: files.originalUploadFilename, aiRenamedAt: files.aiRenamedAt })
    .from(files)
    .where(and(eq(files.id, args.fileId), eq(files.firmId, args.firmId), isNull(files.deletedAt)))
    .limit(1);
  if (!row) return { ok: false, code: 'file_not_found', status: 404 };
  if (!row.aiRenamedAt || !row.original) return { ok: false, code: 'not_ai_renamed', status: 409 };
  return renameFile(deps.db, storage, {
    firmId: args.firmId,
    ...(args.clientId ? { clientId: args.clientId } : {}),
    fileId: args.fileId,
    newFilename: row.original,
    actorAppUserId: args.actorId,
    extraSet: { aiRenamedAt: null },
    extraAudit: { aiRenameRevert: true },
  });
}

export async function applySuggestedName(
  deps: AiNamingDeps,
  args: { firmId: string; fileId: string; clientId?: string; actorId: string },
): Promise<RenameFileResult | { ok: false; code: 'no_suggestion'; status: 409 }> {
  if (!deps.db) return { ok: false, code: 'storage_error', status: 503 };
  const [row] = await deps.db
    .select({
      suggested: files.aiSuggestedFilename,
      confidence: files.aiRenameConfidence,
      model: files.aiRenameModel,
    })
    .from(files)
    .where(and(eq(files.id, args.fileId), eq(files.firmId, args.firmId), isNull(files.deletedAt)))
    .limit(1);
  if (!row) return { ok: false, code: 'file_not_found', status: 404 };
  if (!row.suggested) return { ok: false, code: 'no_suggestion', status: 409 };
  return applyAiRename(deps, {
    firmId: args.firmId,
    fileId: args.fileId,
    ...(args.clientId ? { clientId: args.clientId } : {}),
    newFilename: row.suggested,
    actorId: args.actorId,
    confidence: row.confidence,
    model: row.model,
  });
}

/** Record a low-confidence outcome without renaming (auto path). */
export async function recordSuggestionOnly(
  db: Database,
  fileId: string,
  r: { proposed: string | null; confidence: number | null; model: string | null },
): Promise<void> {
  await db
    .update(files)
    .set({
      aiRenameAttemptedAt: new Date(),
      aiSuggestedFilename: r.proposed,
      aiRenameConfidence: r.confidence,
      aiRenameModel: r.model,
    })
    .where(eq(files.id, fileId));
}
