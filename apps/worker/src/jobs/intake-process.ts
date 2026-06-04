// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// intake-process — the worker pipeline for a completed anonymous intake
// session (enqueued by POST /api/public/intake/session/:id/complete):
//
//   1. ClamAV-scan every quarantined upload (clamd INSTREAM).
//   2. If anything is infected → mark those files + the session 'rejected'
//      and alert staff (no client PII; the worker has no MFK).
//   3. Otherwise mark uploads 'clean', assemble JPG/PNG pages into one PDF
//      (pdf-lib), mark the session 'received'.
//   4. Notify the target staff per their card prefs (in-app audit alert +
//      email + SMS) — generic copy only; decrypted details live in the
//      authenticated Intake inbox.
//
// File bytes are stored plaintext (same at-rest posture as the rest of the
// File Manager); the per-record MFK DEK protects the session's PII columns
// + the original filename. The worker deliberately holds no firm key.

import { and, eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import { appUsers, auditLog, intakeFiles, intakeSessions, intakeStaffCards } from '@vibe/db/schema';
import type { StorageClient } from '@vibe/storage';

import { clamdScan, isClamdConfigured, type ClamScanResult } from '../clamd';
import type { MailDispatch, SmsDispatch } from '../dispatchers';

const RECEIVED_PREFIX = 'intake/received';
const EMBEDDABLE = new Set(['image/jpeg', 'image/png']);

export interface IntakeProcessDeps {
  sendEmail?: MailDispatch;
  sendSms?: SmsDispatch;
  appBaseUrl?: string;
  /** Override the virus scanner (tests inject a fake; defaults to clamd). */
  scan?: (buf: Buffer) => Promise<ClamScanResult>;
}

export interface IntakeProcessResult {
  sessionId: string;
  outcome: 'received' | 'rejected' | 'skipped';
  scanned: number;
  infected: number;
  assembledPdf: boolean;
}

async function readObject(storage: StorageClient, key: string): Promise<Buffer> {
  const obj = await storage.get(key);
  const chunks: Buffer[] = [];
  for await (const chunk of obj.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/** Combine JPG/PNG page images into a single PDF, one image per page. */
async function assembleImagesToPdf(
  images: Array<{ buf: Buffer; mimeType: string }>,
): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (const img of images) {
    const embedded =
      img.mimeType === 'image/png' ? await pdf.embedPng(img.buf) : await pdf.embedJpg(img.buf);
    const page = pdf.addPage([embedded.width, embedded.height]);
    page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
  }
  const out = await pdf.save();
  return Buffer.from(out);
}

export async function runIntakeProcess(
  db: Database,
  storage: StorageClient,
  log: Logger,
  payload: { sessionId: string; firmId: string },
  deps: IntakeProcessDeps = {},
): Promise<IntakeProcessResult> {
  const { sessionId, firmId } = payload;

  const [session] = await db
    .select({ id: intakeSessions.id, targetStaffId: intakeSessions.targetStaffId })
    .from(intakeSessions)
    .where(
      and(
        eq(intakeSessions.id, sessionId),
        eq(intakeSessions.firmId, firmId),
        eq(intakeSessions.status, 'pending_scan'),
      ),
    )
    .limit(1);
  if (!session) {
    // Already processed or gone — idempotent no-op.
    return { sessionId, outcome: 'skipped', scanned: 0, infected: 0, assembledPdf: false };
  }

  await db
    .update(intakeSessions)
    .set({ status: 'processing' })
    .where(eq(intakeSessions.id, sessionId));

  const uploads = await db
    .select({
      id: intakeFiles.id,
      objectKey: intakeFiles.objectKey,
      mimeType: intakeFiles.mimeType,
    })
    .from(intakeFiles)
    .where(and(eq(intakeFiles.sessionId, sessionId), eq(intakeFiles.kind, 'upload')));

  if (!isClamdConfigured()) {
    log.warn(
      { sessionId },
      'intake-process: CLAMD_HOST unset — virus scanning SKIPPED for this session',
    );
  }

  let infected = 0;
  let scanned = 0;
  const cleanImages: Array<{ buf: Buffer; mimeType: string }> = [];

  for (const f of uploads) {
    let buf: Buffer;
    try {
      buf = await readObject(storage, f.objectKey);
    } catch (err) {
      log.error({ err, fileId: f.id }, 'intake-process: could not read quarantined object');
      throw err; // fail the job → retry; do NOT deliver an unread file
    }

    const scanner = deps.scan ?? clamdScan;
    const result = await scanner(buf).catch((err: unknown) => {
      log.error({ err, fileId: f.id }, 'intake-process: clamd scan failed');
      throw err; // fail closed — retry rather than deliver unscanned
    });
    scanned += 1;

    if (result.status === 'infected') {
      infected += 1;
      await db.update(intakeFiles).set({ scanStatus: 'infected' }).where(eq(intakeFiles.id, f.id));
      log.warn({ fileId: f.id, signature: result.signature }, 'intake-process: infected upload');
      continue;
    }

    await db.update(intakeFiles).set({ scanStatus: 'clean' }).where(eq(intakeFiles.id, f.id));
    if (f.mimeType && EMBEDDABLE.has(f.mimeType)) {
      cleanImages.push({ buf, mimeType: f.mimeType });
    }
  }

  if (infected > 0) {
    await db
      .update(intakeSessions)
      .set({ status: 'rejected' })
      .where(eq(intakeSessions.id, sessionId));
    await writeAlert(db, sessionId, session.targetStaffId, firmId, 'intake_rejected', {
      reason: 'virus_scan',
      infected,
    });
    log.warn({ sessionId, infected }, 'intake-process: session rejected (infected uploads)');
    return { sessionId, outcome: 'rejected', scanned, infected, assembledPdf: false };
  }

  // Assemble page images into a single PDF for convenient disposition.
  let assembledPdf = false;
  if (cleanImages.length > 0) {
    try {
      const pdfBytes = await assembleImagesToPdf(cleanImages);
      const objectKey = `${RECEIVED_PREFIX}/${sessionId}/assembled-${cleanImages.length}p.pdf`;
      await storage.put(objectKey, pdfBytes, { contentType: 'application/pdf' });
      await db.insert(intakeFiles).values({
        sessionId,
        objectKey,
        assembledPdfObjectKey: objectKey,
        mimeType: 'application/pdf',
        byteSize: pdfBytes.byteLength,
        kind: 'scan',
        scanStatus: 'clean',
      });
      assembledPdf = true;
    } catch (err) {
      // Non-fatal: the originals are clean + available; just skip assembly.
      log.error({ err, sessionId }, 'intake-process: PDF assembly failed (originals kept)');
    }
  }

  await db
    .update(intakeSessions)
    .set({ status: 'received' })
    .where(eq(intakeSessions.id, sessionId));

  await notifyStaff(db, log, deps, {
    sessionId,
    firmId,
    targetStaffId: session.targetStaffId,
    fileCount: uploads.length,
  });

  return { sessionId, outcome: 'received', scanned, infected, assembledPdf };
}

async function writeAlert(
  db: Database,
  sessionId: string,
  targetStaffId: string,
  firmId: string,
  entityType: 'intake_received' | 'intake_rejected',
  extra: Record<string, unknown>,
): Promise<void> {
  await db.insert(auditLog).values({
    action: 'CREATE',
    entityType,
    entityId: sessionId,
    afterJson: { sessionId, targetStaffId, firmId, ...extra },
  });
}

async function notifyStaff(
  db: Database,
  log: Logger,
  deps: IntakeProcessDeps,
  args: { sessionId: string; firmId: string; targetStaffId: string; fileCount: number },
): Promise<void> {
  const [card] = await db
    .select({
      notifyEmail: intakeStaffCards.notifyEmail,
      notifySms: intakeStaffCards.notifySms,
      notifyInApp: intakeStaffCards.notifyInApp,
      email: appUsers.email,
      mobilePhone: appUsers.mobilePhone,
      businessPhone: appUsers.businessPhone,
    })
    .from(intakeStaffCards)
    .innerJoin(appUsers, eq(appUsers.id, intakeStaffCards.userId))
    .where(
      and(
        eq(intakeStaffCards.firmId, args.firmId),
        eq(intakeStaffCards.userId, args.targetStaffId),
      ),
    )
    .limit(1);

  // In-app alert (always — it's the firm's own record of the submission).
  await writeAlert(db, args.sessionId, args.targetStaffId, args.firmId, 'intake_received', {
    fileCount: args.fileCount,
  });

  if (!card) return;

  const inboxUrl = deps.appBaseUrl ? `${deps.appBaseUrl.replace(/\/$/, '')}/intake` : null;
  const subject = 'New document submission received';
  const body =
    `You have a new document submission waiting in your Intake inbox` +
    (inboxUrl ? `:\n\n${inboxUrl}\n` : '.') +
    `\n\nOpen the inbox to review and file it. (Details are shown only after you sign in.)`;

  if (card.notifyEmail && card.email && deps.sendEmail) {
    await deps.sendEmail({ to: card.email, subject, body }).catch((err: unknown) => {
      log.error({ err, sessionId: args.sessionId }, 'intake-process: notify email failed');
    });
  }
  if (card.notifySms && deps.sendSms) {
    const phone = card.mobilePhone ?? card.businessPhone;
    if (phone) {
      await deps
        .sendSms({ to: phone, body: 'New document submission in your Intake inbox.' })
        .catch((err: unknown) => {
          log.error({ err, sessionId: args.sessionId }, 'intake-process: notify SMS failed');
        });
    }
  }
}
