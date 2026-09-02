// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Programmatic Document Intake submission (0234). Extracted from the
// public intake routes so other surfaces — the SMS inbox's MMS pipeline
// first — can hand files to Intake with the same envelope encryption,
// quarantine layout and worker pipeline as a client upload.

import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { intakeFiles, intakeSessions } from '@vibe/db/schema';
import type { StorageClient } from '@vibe/storage';

import { getApplianceLockState } from '../crypto/boot';
import { encField, newIntakeRecordKey } from './crypto';
import { enqueueIntakeProcess } from './queue';

export const INTAKE_QUARANTINE_PREFIX = 'intake/quarantine';

export interface CreateIntakeSessionArgs {
  firmId: string;
  targetStaffId: string;
  clientName: string;
  clientEmail?: string | null;
  clientPhone?: string | null;
  message?: string | null;
  source: 'public' | 'tokenized_link' | 'sms';
  matchedClientId?: string | null;
  files: Array<{ filename: string; mimeType: string; body: Buffer }>;
  /** skip the worker enqueue (tests) */
  enqueue?: boolean;
}

export type CreateIntakeSessionResult =
  | { ok: true; sessionId: string; fileIds: string[] }
  | { ok: false; code: 'crypto_locked' | 'storage_failed' | 'db_failed'; error?: string };

export function intakeCryptoReady(firmId: string): boolean {
  const lock = getApplianceLockState();
  return lock.kind === 'unlocked' && lock.firmId === firmId;
}

export async function createIntakeSessionWithFiles(
  db: Database,
  storage: StorageClient,
  args: CreateIntakeSessionArgs,
): Promise<CreateIntakeSessionResult> {
  if (!intakeCryptoReady(args.firmId)) return { ok: false, code: 'crypto_locked' };
  let sessionId: string;
  let dek: Uint8Array;
  try {
    const key = newIntakeRecordKey(db, args.firmId);
    dek = key.dek;
    const [row] = await db
      .insert(intakeSessions)
      .values({
        firmId: args.firmId,
        targetStaffId: args.targetStaffId,
        wrappedDek: Buffer.from(key.wrappedDek),
        clientNameEnc: encField(dek, args.clientName),
        clientEmailEnc: encField(dek, args.clientEmail ?? null),
        clientPhoneEnc: encField(dek, args.clientPhone ?? null),
        messageEnc: encField(dek, args.message ?? null),
        hasMessage: Boolean(args.message?.trim()),
        source: args.source,
        status: 'pending_scan',
        matchedClientId: args.matchedClientId ?? null,
      })
      .returning({ id: intakeSessions.id });
    sessionId = row!.id;
  } catch (err) {
    return { ok: false, code: 'db_failed', error: err instanceof Error ? err.message : 'insert' };
  }
  const fileIds: string[] = [];
  for (const f of args.files) {
    try {
      const [row] = await db
        .insert(intakeFiles)
        .values({
          sessionId,
          originalFilenameEnc: encField(dek, f.filename),
          objectKey: 'pending',
          mimeType: f.mimeType,
          byteSize: f.body.byteLength,
          kind: 'upload',
          scanStatus: 'pending',
        })
        .returning({ id: intakeFiles.id });
      const fileId = row!.id;
      const objectKey = `${INTAKE_QUARANTINE_PREFIX}/${sessionId}/${fileId}`;
      await storage.put(objectKey, f.body, { contentType: f.mimeType });
      await db.update(intakeFiles).set({ objectKey }).where(eq(intakeFiles.id, fileId));
      fileIds.push(fileId);
    } catch (err) {
      return {
        ok: false,
        code: 'storage_failed',
        error: err instanceof Error ? err.message : 'put',
      };
    }
  }
  if (args.enqueue !== false) {
    await enqueueIntakeProcess({ sessionId, firmId: args.firmId });
  }
  return { ok: true, sessionId, fileIds };
}
