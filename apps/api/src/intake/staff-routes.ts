// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Staff Intake Inbox API (mounted at /api/staff/intake). Lists received
// submissions, decrypts their PII on the fly (firm MFK), serves file
// downloads, and disposes a session into a client's File Manager folder
// (reusing createFileInClientFolder). Every disposition writes an
// intake_actions row and an audit entry.
//
// Reads gate on storage:folder:view; mutations on storage:folder:edit.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { appUsers, intakeActions, intakeFiles, intakeSessions } from '@vibe/db/schema';
import { buildStorageClient, type StorageClient } from '@vibe/storage';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { getApplianceLockState } from '../crypto/boot';
import { createFileInClientFolder } from '../clients/create-file';
import { CATEGORY_VALUES, type Category } from '../clients/files';
import { unwrapIntakeRecordKey, decField } from './crypto';
import { suggestClients } from './auto-match';
import { createIntakeLink } from './links';

export interface IntakeStaffDeps extends RbacDeps {
  db: Database | null;
  storageClient?: StorageClient;
  /** Public base URL of the intake SPA (e.g. https://intake.<zone>). Used
   *  to build send-a-link URLs. */
  intakeBaseUrl?: string;
  /** Optional delivery hooks for send-a-link. */
  sendEmail?: (args: { to: string; subject: string; body: string }) => Promise<void>;
  sendSms?: (args: { to: string; body: string }) => Promise<void>;
}

function getStorage(deps: IntakeStaffDeps): StorageClient | null {
  if (deps.storageClient) return deps.storageClient;
  try {
    return buildStorageClient(process.env);
  } catch {
    return null;
  }
}

const LinkSchema = z.object({
  targetStaffId: z.string().uuid(),
  recipientEmail: z.string().trim().email().max(320).optional(),
  recipientPhone: z.string().trim().min(7).max(40).optional(),
  expiresInDays: z.number().int().min(1).max(90).optional(),
});

const DisposeSchema = z.object({
  clientId: z.string().uuid(),
  category: z.enum(CATEGORY_VALUES).optional(),
  subfolderPath: z.string().max(512).optional(),
  visibility: z.enum(['private', 'client_visible']).optional(),
  fileIds: z.array(z.string().uuid()).optional(),
  note: z.string().max(1000).optional(),
});

export function createIntakeStaffRouter(deps: IntakeStaffDeps): Router {
  const router = express.Router();

  function requireUnlocked(firmId: string, res: Response): boolean {
    const lock = getApplianceLockState();
    if (lock.kind !== 'unlocked' || lock.firmId !== firmId) {
      res.status(503).json({ error: 'appliance_locked' });
      return false;
    }
    return true;
  }

  // GET /count — received-session badge.
  router.get(
    '/count',
    requirePermission(deps, 'storage:folder:view'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ received: 0 });
        return;
      }
      const rows = await deps.db
        .select({ id: intakeSessions.id })
        .from(intakeSessions)
        .where(and(eq(intakeSessions.firmId, firmId), eq(intakeSessions.status, 'received')));
      res.json({ received: rows.length });
    },
  );

  // GET /staff-options — active staff for the send-a-link target picker.
  router.get(
    '/staff-options',
    requirePermission(deps, 'storage:folder:view'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ staff: [] });
        return;
      }
      const rows = await deps.db
        .select({ id: appUsers.id, name: appUsers.fullName })
        .from(appUsers)
        .where(and(eq(appUsers.firmId, firmId), eq(appUsers.status, 'ACTIVE')))
        .orderBy(appUsers.fullName);
      res.json({ staff: rows });
    },
  );

  // GET /sessions?status=received — list (decrypts PII).
  router.get(
    '/sessions',
    requirePermission(deps, 'storage:folder:view'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ sessions: [] });
        return;
      }
      if (!requireUnlocked(firmId, res)) return;
      const status = String(req.query['status'] ?? 'received');

      const rows = await deps.db
        .select({
          id: intakeSessions.id,
          status: intakeSessions.status,
          createdAt: intakeSessions.createdAt,
          wrappedDek: intakeSessions.wrappedDek,
          clientNameEnc: intakeSessions.clientNameEnc,
          clientEmailEnc: intakeSessions.clientEmailEnc,
          messageEnc: intakeSessions.messageEnc,
          matchedClientId: intakeSessions.matchedClientId,
          targetStaffId: intakeSessions.targetStaffId,
          staffName: appUsers.fullName,
        })
        .from(intakeSessions)
        .innerJoin(appUsers, eq(appUsers.id, intakeSessions.targetStaffId))
        .where(and(eq(intakeSessions.firmId, firmId), eq(intakeSessions.status, status)))
        .orderBy(desc(intakeSessions.createdAt))
        .limit(200);

      const fileCounts = await deps.db
        .select({ sessionId: intakeFiles.sessionId, id: intakeFiles.id })
        .from(intakeFiles)
        .where(
          inArray(
            intakeFiles.sessionId,
            rows.map((r) => r.id),
          ),
        );
      const countBySession = new Map<string, number>();
      for (const f of fileCounts)
        countBySession.set(f.sessionId, (countBySession.get(f.sessionId) ?? 0) + 1);

      const sessions = rows.map((r) => {
        const dek = unwrapIntakeRecordKey(deps.db!, firmId, r.wrappedDek);
        return {
          id: r.id,
          status: r.status,
          createdAt: r.createdAt,
          clientName: decField(dek, r.clientNameEnc),
          clientEmail: decField(dek, r.clientEmailEnc),
          message: decField(dek, r.messageEnc),
          targetStaffId: r.targetStaffId,
          targetStaffName: r.staffName,
          matchedClientId: r.matchedClientId,
          fileCount: countBySession.get(r.id) ?? 0,
        };
      });
      res.json({ sessions });
    },
  );

  // GET /sessions/:id — detail with decrypted PII, files, match suggestions.
  router.get(
    '/sessions/:id',
    requirePermission(deps, 'storage:folder:view'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (!requireUnlocked(firmId, res)) return;

      const [s] = await deps.db
        .select()
        .from(intakeSessions)
        .where(and(eq(intakeSessions.id, req.params['id']!), eq(intakeSessions.firmId, firmId)))
        .limit(1);
      if (!s) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const dek = unwrapIntakeRecordKey(deps.db, firmId, s.wrappedDek);
      const name = decField(dek, s.clientNameEnc);
      const email = decField(dek, s.clientEmailEnc);
      const phone = decField(dek, s.clientPhoneEnc);

      const fileRows = await deps.db
        .select()
        .from(intakeFiles)
        .where(eq(intakeFiles.sessionId, s.id));
      const files = fileRows.map((f) => ({
        id: f.id,
        filename:
          f.kind === 'scan' ? 'Scanned documents.pdf' : decField(dek, f.originalFilenameEnc),
        mimeType: f.mimeType,
        byteSize: Number(f.byteSize),
        kind: f.kind,
        scanStatus: f.scanStatus,
      }));

      const suggestions =
        s.status === 'received' || s.status === 'processing'
          ? await suggestClients(deps.db, firmId, { email, phone, name })
          : [];

      res.json({
        session: {
          id: s.id,
          status: s.status,
          createdAt: s.createdAt,
          source: s.source,
          clientName: name,
          clientEmail: email,
          clientPhone: phone,
          message: decField(dek, s.messageEnc),
          targetStaffId: s.targetStaffId,
          matchedClientId: s.matchedClientId,
        },
        files,
        suggestions,
      });
    },
  );

  // GET /sessions/:id/files/:fileId/download — stream the object.
  router.get(
    '/sessions/:id/files/:fileId/download',
    requirePermission(deps, 'storage:folder:view'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (!requireUnlocked(firmId, res)) return;

      const [s] = await deps.db
        .select({ id: intakeSessions.id, wrappedDek: intakeSessions.wrappedDek })
        .from(intakeSessions)
        .where(and(eq(intakeSessions.id, req.params['id']!), eq(intakeSessions.firmId, firmId)))
        .limit(1);
      if (!s) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [f] = await deps.db
        .select()
        .from(intakeFiles)
        .where(and(eq(intakeFiles.id, req.params['fileId']!), eq(intakeFiles.sessionId, s.id)))
        .limit(1);
      if (!f) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const storage = getStorage(deps);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }
      const dek = unwrapIntakeRecordKey(deps.db, firmId, s.wrappedDek);
      const filename =
        f.kind === 'scan'
          ? 'Scanned documents.pdf'
          : (decField(dek, f.originalFilenameEnc) ?? 'document');
      try {
        const obj = await storage.get(f.objectKey);
        res.setHeader('Content-Type', f.mimeType ?? 'application/octet-stream');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${filename.replace(/"/g, '')}"`,
        );
        obj.body.pipe(res);
      } catch {
        res.status(404).json({ error: 'object_gone' });
      }
    },
  );

  // POST /links — generate a "send a link" intake invitation.
  router.post(
    '/links',
    requirePermission(deps, 'storage:folder:view'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const actorId = req.staffSession!.appUserId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      if (!requireUnlocked(firmId, res)) return;
      const parsed = LinkSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const { token } = await createIntakeLink(deps.db, {
        firmId,
        createdByUserId: actorId,
        targetStaffId: parsed.data.targetStaffId,
        recipientEmail: parsed.data.recipientEmail ?? null,
        recipientPhone: parsed.data.recipientPhone ?? null,
        expiresInDays: parsed.data.expiresInDays ?? 14,
      });
      const base = (deps.intakeBaseUrl ?? '').replace(/\/$/, '');
      const url = base ? `${base}/t/${token}` : `/t/${token}`;

      let delivered = false;
      if (parsed.data.recipientEmail && deps.sendEmail) {
        await deps
          .sendEmail({
            to: parsed.data.recipientEmail,
            subject: 'Securely send your documents',
            body: `You've been invited to securely upload documents:\n\n${url}\n\nThis link expires in ${parsed.data.expiresInDays ?? 14} days.`,
          })
          .then(() => {
            delivered = true;
          })
          .catch(() => undefined);
      }
      if (parsed.data.recipientPhone && deps.sendSms) {
        await deps
          .sendSms({
            to: parsed.data.recipientPhone,
            body: `Securely upload your documents: ${url}`,
          })
          .then(() => {
            delivered = true;
          })
          .catch(() => undefined);
      }

      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'intake_link',
        entityId: null,
        actorAppUserId: actorId,
        after: { targetStaffId: parsed.data.targetStaffId, delivered },
      }).catch(() => undefined);

      res.status(201).json({ url, delivered });
    },
  );

  // POST /sessions/:id/dispose — move file(s) into a client folder.
  router.post(
    '/sessions/:id/dispose',
    requirePermission(deps, 'storage:folder:edit'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const actorId = req.staffSession!.appUserId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      if (!requireUnlocked(firmId, res)) return;
      const parsed = DisposeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const storage = getStorage(deps);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }

      const [s] = await deps.db
        .select()
        .from(intakeSessions)
        .where(
          and(
            eq(intakeSessions.id, req.params['id']!),
            eq(intakeSessions.firmId, firmId),
            eq(intakeSessions.status, 'received'),
          ),
        )
        .limit(1);
      if (!s) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const dek = unwrapIntakeRecordKey(deps.db, firmId, s.wrappedDek);

      const allFiles = await deps.db
        .select()
        .from(intakeFiles)
        .where(and(eq(intakeFiles.sessionId, s.id), eq(intakeFiles.scanStatus, 'clean')));
      const selected = parsed.data.fileIds
        ? allFiles.filter((f) => parsed.data.fileIds!.includes(f.id))
        : allFiles;
      if (selected.length === 0) {
        res.status(400).json({ error: 'no_files' });
        return;
      }

      const category: Category = parsed.data.category ?? 'other';
      let moved = 0;
      const errors: string[] = [];
      for (const f of selected) {
        let body: Buffer;
        try {
          const obj = await storage.get(f.objectKey);
          const chunks: Buffer[] = [];
          for await (const chunk of obj.body) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
          }
          body = Buffer.concat(chunks);
        } catch {
          errors.push(f.id);
          continue;
        }
        const filename =
          f.kind === 'scan'
            ? `Intake scan ${s.id.slice(0, 8)}.pdf`
            : (decField(dek, f.originalFilenameEnc) ?? `intake-${f.id}`);
        const result = await createFileInClientFolder(deps.db, storage, {
          firmId,
          clientId: parsed.data.clientId,
          actorId,
          category,
          subfolderPath: parsed.data.subfolderPath,
          visibility: parsed.data.visibility,
          originalFilename: filename,
          body,
          mimeType: f.mimeType,
          source: 'intake',
        });
        if (result.ok) moved += 1;
        else errors.push(`${f.id}:${result.code}`);
      }

      if (moved === 0) {
        res.status(502).json({ error: 'move_failed', detail: errors });
        return;
      }

      await deps.db.insert(intakeActions).values({
        sessionId: s.id,
        actorUserId: actorId,
        action: 'move',
        targetClientId: parsed.data.clientId,
        note: parsed.data.note ?? null,
      });
      await deps.db
        .update(intakeSessions)
        .set({ status: 'disposed', matchedClientId: parsed.data.clientId })
        .where(eq(intakeSessions.id, s.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'intake_session',
        entityId: s.id,
        actorAppUserId: actorId,
        after: { disposition: 'move', clientId: parsed.data.clientId, moved },
      }).catch(() => undefined);

      res.json({ ok: true, moved, errors });
    },
  );

  // POST /sessions/:id/reject — archive without filing.
  router.post(
    '/sessions/:id/reject',
    requirePermission(deps, 'storage:folder:edit'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const actorId = req.staffSession!.appUserId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 1000) : null;
      const [s] = await deps.db
        .select({ id: intakeSessions.id })
        .from(intakeSessions)
        .where(
          and(
            eq(intakeSessions.id, req.params['id']!),
            eq(intakeSessions.firmId, firmId),
            inArray(intakeSessions.status, ['received', 'processing']),
          ),
        )
        .limit(1);
      if (!s) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await deps.db.insert(intakeActions).values({
        sessionId: s.id,
        actorUserId: actorId,
        action: 'reject',
        note,
      });
      await deps.db
        .update(intakeSessions)
        .set({ status: 'rejected' })
        .where(eq(intakeSessions.id, s.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'intake_session',
        entityId: s.id,
        actorAppUserId: actorId,
        after: { disposition: 'reject' },
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  return router;
}
