// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Vibe Filer staff API — document inbox & routing.
//
//   POST   /scan                     re-list Inbox/ and re-match (cache upsert)
//   POST   /upload?filename=&mimeType=  raw body → put into Inbox/ (drag-drop)
//   GET    /inbox                    current review queue
//   PATCH  /inbox/:id                per-row review state / manual assign
//   GET    /profiles                 routing profiles
//   POST   /profiles                 create
//   PATCH  /profiles/:id             rename / activate (single active)
//   DELETE /profiles/:id             delete
//   GET    /rules?profileId          rules for a profile (ordered)
//   POST   /rules                    create
//   PATCH  /rules/:id                update
//   DELETE /rules/:id                delete
//   POST   /rules/reorder            { profileId, orderedIds }
//   POST   /commit                   { itemIds } → enqueue route jobs (batch)
//   GET    /history                  routed batches
//   GET    /history/:batchId         per-file log
//   POST   /history/:batchId/undo    undo a batch
//   POST   /history/log/:logId/undo  undo one file
//
// Permissions: view → storage:folder:view; route/commit/undo →
// storage:folder:edit; profiles/rules admin → storage:folder:bind.

import express, { type Router } from 'express';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import {
  clientFolders,
  clients,
  files,
  inboxItems,
  inboxRoutingLog,
  inboxRoutingProfiles,
  inboxRoutingRules,
  zipImports,
} from '@vibe/db/schema';
import {
  buildStorageClient,
  enforceKeyByteCap,
  resolveCollision,
  sanitizeForWindows,
  type StorageClient,
} from '@vibe/storage';

import { evaluateRules, joinTargetPath, resolveYearSubfolder } from '@vibe/core/filer';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { resolveClientFolders } from '../clients/folder-templates';
import {
  INBOX_PREFIX,
  ZIP_IMPORT_PREFIX,
  loadActiveRules,
  loadK1Config,
  matchClientByIdSubstring,
} from './scan';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';
import { scanInbox } from './scan';
import { enqueueFilerRoute, enqueueFilerUndo, enqueueZipImport } from './queue';

export interface FilerRoutesDeps extends RbacDeps {
  db: Database | null;
  storage?: StorageClient | null;
}

function resolveStorage(deps: FilerRoutesDeps): StorageClient | null {
  if (deps.storage) return deps.storage;
  try {
    return buildStorageClient(process.env);
  } catch {
    return null;
  }
}

// Buffered in RAM by express.raw. Keep this limit within the host's
// memory headroom (sized for a single-firm appliance).
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const BLOCKED_UPLOAD_EXT =
  /\.(exe|com|bat|cmd|msi|scr|pif|cpl|js|jse|vbs|vbe|wsf|wsh|ps1|sh|jar|app|dll|sys|reg)$/i;

const ReviewSchema = z.object({
  reviewAction: z.enum(['file', 'flag_tax', 'skip', 'file_flag_tax']).nullable().optional(),
  overrideFolder: z.string().max(512).nullable().optional(),
  overrideYear: z.number().int().min(1900).max(2999).nullable().optional(),
  matchedClient: z.string().uuid().nullable().optional(),
  flagFormCode: z.string().max(40).nullable().optional(),
  flagTaxYear: z.number().int().min(1900).max(2999).nullable().optional(),
  included: z.boolean().optional(),
  // 0229 — K-1 recipient verification (verify / search / dismiss).
  k1MatchedClient: z.string().uuid().nullable().optional(),
  k1Status: z.enum(['suggested', 'confirmed', 'dismissed']).nullable().optional(),
  k1OverrideFolder: z.string().max(512).nullable().optional(),
});

const ProfileSchema = z.object({
  name: z.string().min(1).max(120),
  isActive: z.boolean().optional(),
  // 0229 — destination for K-1 recipient copies.
  k1TargetPath: z.string().max(512).optional(),
  k1YearBehavior: z.enum(['none', 'current_only', 'current_and_next', 'previous']).optional(),
});
const RuleSchema = z.object({
  profileId: z.string().uuid(),
  name: z.string().min(1).max(120),
  identifier: z.string().max(200).default(''),
  matchMode: z.enum(['contains', 'starts_with', 'regex']).default('contains'),
  caseSensitive: z.boolean().default(false),
  targetPath: z.string().max(512).default(''),
  yearBehavior: z.enum(['none', 'current_only', 'current_and_next', 'previous']).default('none'),
  isTaxReturn: z.boolean().default(false),
  enabled: z.boolean().default(true),
  notes: z.string().max(2000).nullable().optional(),
});
const RulePatchSchema = RuleSchema.partial().omit({ profileId: true });

// 0229 — second clients join for the K-1 recipient suggestion.
const k1Client = alias(clients, 'k1_client');

export function createFilerRouter(deps: FilerRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router, ['id', 'profileId', 'logId', 'batchId']);

  // ── Scan + queue ──────────────────────────────────────────────────
  router.post('/scan', requirePermission(deps, 'storage:folder:view'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const storage = resolveStorage(deps);
    if (!storage) {
      res.status(503).json({ error: 'storage_unavailable' });
      return;
    }
    try {
      const result = await scanInbox(deps.db, storage, session.firmId);
      res.json(result);
    } catch (err) {
      logger.warn({ err }, 'filer scan failed');
      res
        .status(502)
        .json({ error: 'scan_failed', detail: err instanceof Error ? err.message : undefined });
    }
  });

  // POST /upload?filename=&mimeType= (raw body) — drag-and-drop a document
  // straight into the Inbox/ prefix. No DB write here: the caller re-scans
  // afterwards, which is what pulls the new object into the review queue.
  router.post(
    '/upload',
    requirePermission(deps, 'storage:folder:edit'),
    express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES + 1024 }),
    async (req, res) => {
      const filename = String(req.query['filename'] ?? '')
        .trim()
        .slice(0, 255);
      if (!filename) {
        res.status(400).json({ error: 'filename_required' });
        return;
      }
      if (BLOCKED_UPLOAD_EXT.test(filename)) {
        res.status(415).json({ error: 'unsupported_type' });
        return;
      }
      const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (body.byteLength === 0) {
        res.status(400).json({ error: 'empty_body' });
        return;
      }
      if (body.byteLength > MAX_UPLOAD_BYTES) {
        res.status(413).json({ error: 'file_too_large' });
        return;
      }
      const storage = resolveStorage(deps);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }
      const desired = enforceKeyByteCap(`${INBOX_PREFIX}${sanitizeForWindows(filename)}`);
      try {
        const key = await resolveCollision(desired, async (k) => (await storage.head(k)) !== null);
        const mimeType = String(req.query['mimeType'] ?? 'application/octet-stream').slice(0, 200);
        await storage.put(key, body, { contentType: mimeType });
        res.status(201).json({
          key,
          name: key.slice(key.lastIndexOf('/') + 1),
          sizeBytes: body.byteLength,
        });
      } catch (err) {
        logger.warn({ err, filename }, 'filer inbox upload failed');
        res.status(502).json({ error: 'upload_failed' });
      }
    },
  );

  router.get('/inbox', requirePermission(deps, 'storage:folder:view'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const rows = await deps.db
      .select({
        id: inboxItems.id,
        objectKey: inboxItems.objectKey,
        originalName: inboxItems.originalName,
        sizeBytes: inboxItems.sizeBytes,
        parsedName: inboxItems.parsedName,
        parsedId: inboxItems.parsedId,
        parsedYear: inboxItems.parsedYear,
        matchStatus: inboxItems.matchStatus,
        matchedClient: inboxItems.matchedClient,
        clientName: clients.name,
        clientExternalId: clients.externalId,
        clientAwsId: clients.awsId,
        suggestedRule: inboxItems.suggestedRule,
        suggestedPath: inboxItems.suggestedPath,
        reviewAction: inboxItems.reviewAction,
        overrideFolder: inboxItems.overrideFolder,
        overrideYear: inboxItems.overrideYear,
        flagFormCode: inboxItems.flagFormCode,
        flagTaxYear: inboxItems.flagTaxYear,
        included: inboxItems.included,
        k1RecipientName: inboxItems.k1RecipientName,
        k1MatchedClient: inboxItems.k1MatchedClient,
        k1ClientName: k1Client.name,
        k1ClientExternalId: k1Client.externalId,
        k1MatchScore: inboxItems.k1MatchScore,
        k1Status: inboxItems.k1Status,
        k1OverrideFolder: inboxItems.k1OverrideFolder,
      })
      .from(inboxItems)
      .leftJoin(clients, eq(clients.id, inboxItems.matchedClient))
      .leftJoin(
        // Firm predicate on the join: a cross-firm uuid (blocked at PATCH
        // now, but rows could predate that) must never leak another
        // firm's client name into this firm's inbox.
        k1Client,
        and(eq(k1Client.id, inboxItems.k1MatchedClient), eq(k1Client.firmId, session.firmId)),
      )
      .where(eq(inboxItems.firmId, session.firmId))
      .orderBy(desc(inboxItems.discoveredAt));
    res.json({ items: rows });
  });

  router.get(
    '/inbox/:id/preview-url',
    requirePermission(deps, 'storage:folder:view'),
    async (req, res) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .select({ objectKey: inboxItems.objectKey, name: inboxItems.originalName })
        .from(inboxItems)
        .where(and(eq(inboxItems.id, req.params['id']!), eq(inboxItems.firmId, session.firmId)))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const storage = resolveStorage(deps);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }
      const url = await storage.presignGet(row.objectKey, 300, {
        responseContentDisposition: 'inline',
        responseContentType: 'application/pdf',
      });
      res.json({ url, filename: row.name });
    },
  );

  router.patch('/inbox/:id', requirePermission(deps, 'storage:folder:edit'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = ReviewSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', detail: parsed.error.flatten() });
      return;
    }
    // 0229 — client-assignment invariants are validated against the
    // RESULTING row state (incoming value ?? current), so a primary
    // reassignment cannot smuggle in matchedClient === k1MatchedClient
    // and a simultaneous patch is never compared against stale values.
    // Clearing operations (dismiss, k1 client → null) always succeed.
    const touchesClients =
      parsed.data.matchedClient !== undefined ||
      parsed.data.k1MatchedClient !== undefined ||
      parsed.data.k1Status !== undefined;
    if (touchesClients) {
      const [current] = await deps.db
        .select({
          matchedClient: inboxItems.matchedClient,
          k1MatchedClient: inboxItems.k1MatchedClient,
          k1Status: inboxItems.k1Status,
        })
        .from(inboxItems)
        .where(and(eq(inboxItems.id, req.params['id']!), eq(inboxItems.firmId, session.firmId)))
        .limit(1);
      if (!current) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      // Firm scoping: the FKs reference the GLOBAL client table, so an
      // arbitrary UUID must be proven to belong to this firm (a cross-firm
      // id would otherwise leak that client's name via the inbox join).
      const firmClient = async (id: string): Promise<boolean> => {
        const [c] = await deps
          .db!.select({ id: clients.id })
          .from(clients)
          .where(and(eq(clients.id, id), eq(clients.firmId, session.firmId)))
          .limit(1);
        return Boolean(c);
      };
      if (parsed.data.matchedClient != null && !(await firmClient(parsed.data.matchedClient))) {
        res.status(400).json({ error: 'client_not_found' });
        return;
      }
      // A recipient without a bound folder would wedge at commit — the
      // same gate the scan suggestions apply.
      const k1Fileable = async (id: string): Promise<boolean> => {
        const [bound] = await deps
          .db!.select({ id: clientFolders.id })
          .from(clientFolders)
          .where(and(eq(clientFolders.clientId, id), eq(clientFolders.firmId, session.firmId)))
          .limit(1);
        return Boolean(bound);
      };
      if (parsed.data.k1MatchedClient != null) {
        if (!(await firmClient(parsed.data.k1MatchedClient))) {
          res.status(400).json({ error: 'k1_client_not_found' });
          return;
        }
        if (!(await k1Fileable(parsed.data.k1MatchedClient))) {
          res.status(400).json({ error: 'k1_client_folder_unbound' });
          return;
        }
      }
      // Picking a K-1 client via search implies confirmation; clearing it
      // reverts to 'suggested' unless the patch says otherwise.
      if (parsed.data.k1MatchedClient != null && parsed.data.k1Status === undefined) {
        parsed.data.k1Status = 'confirmed';
      }
      if (parsed.data.k1MatchedClient === null && parsed.data.k1Status === undefined) {
        parsed.data.k1Status = 'suggested';
      }
      const resultingK1Client =
        parsed.data.k1MatchedClient !== undefined
          ? parsed.data.k1MatchedClient
          : current.k1MatchedClient;
      const resultingK1Status =
        parsed.data.k1Status !== undefined ? parsed.data.k1Status : current.k1Status;
      const resultingMatched =
        parsed.data.matchedClient !== undefined ? parsed.data.matchedClient : current.matchedClient;
      if (resultingK1Status === 'confirmed') {
        if (resultingK1Client == null) {
          res.status(400).json({ error: 'k1_client_required' });
          return;
        }
        if (resultingK1Client === resultingMatched) {
          res.status(400).json({ error: 'k1_same_as_entity' });
          return;
        }
        // Confirming a STORED suggestion (Verify sends only k1Status) must
        // re-validate the resulting client too — its folder binding may
        // have been removed since the scan (review finding).
        if (parsed.data.k1MatchedClient == null && !(await k1Fileable(resultingK1Client))) {
          res.status(400).json({ error: 'k1_client_folder_unbound' });
          return;
        }
      } else if (
        resultingK1Status === 'suggested' &&
        resultingK1Client != null &&
        resultingK1Client === resultingMatched
      ) {
        // A mere suggestion coinciding with a primary reassignment is
        // cleared rather than blocking the reassignment.
        parsed.data.k1MatchedClient = null;
      }
    }
    const set: Record<string, unknown> = { reviewedBy: session.appUserId, updatedAt: new Date() };
    for (const k of [
      'reviewAction',
      'overrideFolder',
      'overrideYear',
      'matchedClient',
      'flagFormCode',
      'flagTaxYear',
      'included',
      'k1MatchedClient',
      'k1Status',
      'k1OverrideFolder',
    ] as const) {
      if (parsed.data[k] !== undefined) set[k] = parsed.data[k];
    }
    const [row] = await deps.db
      .update(inboxItems)
      .set(set)
      .where(and(eq(inboxItems.id, req.params['id']!), eq(inboxItems.firmId, session.firmId)))
      .returning({
        id: inboxItems.id,
        originalName: inboxItems.originalName,
        matchStatus: inboxItems.matchStatus,
        matchedClient: inboxItems.matchedClient,
        parsedYear: inboxItems.parsedYear,
        overrideYear: inboxItems.overrideYear,
      });
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    // Re-run routing rules when the review edit changes their inputs
    // (manual client assignment / override year). Without this, a
    // manually-assigned row never gets a rule destination and a
    // year_needed row stays stuck after the year is supplied.
    if (
      (parsed.data.matchedClient !== undefined || parsed.data.overrideYear !== undefined) &&
      row.matchedClient
    ) {
      const rules = await loadActiveRules(deps.db, session.firmId);
      const rule = evaluateRules(row.originalName, rules);
      const effectiveYear = row.overrideYear ?? row.parsedYear;
      const recompute: Record<string, unknown> = { suggestedRule: rule?.id ?? null };
      if (rule) {
        const yearSub = resolveYearSubfolder(effectiveYear, rule.yearBehavior);
        if (yearSub === null) {
          recompute['suggestedPath'] = null;
          recompute['matchStatus'] = 'year_needed';
        } else {
          recompute['suggestedPath'] = joinTargetPath(rule.targetPath, yearSub);
          if (row.matchStatus === 'year_needed' || row.matchStatus === 'unparseable') {
            recompute['matchStatus'] = 'matched';
          }
        }
      } else {
        recompute['suggestedPath'] = null;
        if (row.matchStatus === 'unparseable') recompute['matchStatus'] = 'matched';
      }
      await deps.db
        .update(inboxItems)
        .set(recompute)
        .where(and(eq(inboxItems.id, row.id), eq(inboxItems.firmId, session.firmId)));
    }
    // 0229 — K-1 verification decides which client folder receives a copy
    // of a tax document: who confirmed/dismissed it must be recoverable
    // (CLAUDE.md non-negotiable #1). Metadata only, never document content.
    if (touchesClients) {
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'inbox_item',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        after: {
          k1Review: true,
          ...(parsed.data.k1Status !== undefined ? { k1Status: parsed.data.k1Status } : {}),
          ...(parsed.data.k1MatchedClient !== undefined
            ? { k1MatchedClient: parsed.data.k1MatchedClient }
            : {}),
          ...(parsed.data.k1OverrideFolder !== undefined
            ? { k1OverrideFolder: parsed.data.k1OverrideFolder }
            : {}),
        },
      }).catch(() => undefined);
    }
    res.json({ ok: true });
  });

  // ── 0153 — zip import ─────────────────────────────────────────────
  //
  // POST /import/upload?filename=   raw .zip → temp B2 key + client match
  // POST /import/:id/start          { clientId, destFolder } → worker job
  // GET  /import                    recent imports
  // GET  /import/:id                one import incl. per-entry results

  router.post(
    '/import/upload',
    requirePermission(deps, 'storage:folder:edit'),
    express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES + 1024 }),
    async (req, res) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const filename = String(req.query['filename'] ?? '')
        .trim()
        .slice(0, 255);
      if (!filename.toLowerCase().endsWith('.zip')) {
        res.status(400).json({ error: 'zip_required' });
        return;
      }
      const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      // Zip local-file-header magic: PK\x03\x04 (empty archives use PK\x05\x06).
      if (body.byteLength < 4 || body[0] !== 0x50 || body[1] !== 0x4b) {
        res.status(400).json({ error: 'not_a_zip' });
        return;
      }
      if (body.byteLength > MAX_UPLOAD_BYTES) {
        res.status(413).json({ error: 'file_too_large' });
        return;
      }
      const storage = resolveStorage(deps);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }

      const importId = randomUUID();
      const zipKey = `${ZIP_IMPORT_PREFIX}${importId}.zip`;
      try {
        await storage.put(zipKey, body, { contentType: 'application/zip' });
      } catch (err) {
        logger.warn({ err, filename }, 'zip-import upload failed');
        res.status(502).json({ error: 'upload_failed' });
        return;
      }

      // Client match from the zip name (External Id OR AWS Id, unique
      // substring hit). The UI shows it for confirmation/override.
      const clientList = await deps.db
        .select({
          id: clients.id,
          name: clients.name,
          externalId: clients.externalId,
          awsId: clients.awsId,
          status: clients.status,
        })
        .from(clients)
        .where(eq(clients.firmId, session.firmId));
      const base = filename.replace(/\.zip$/i, '');
      const match = matchClientByIdSubstring(base, clientList);
      const matchedClient = match ? clientList.find((c) => c.id === match.clientId) : null;

      await deps.db.insert(zipImports).values({
        id: importId,
        firmId: session.firmId,
        zipName: filename,
        zipKey,
        zipSizeBytes: body.byteLength,
        matchedClient: matchedClient?.id ?? null,
        createdBy: session.appUserId,
      });
      res.status(201).json({
        id: importId,
        zipName: filename,
        sizeBytes: body.byteLength,
        matchedClient: matchedClient?.id ?? null,
        clientName: matchedClient?.name ?? null,
        matchedOnId: match?.id ?? null,
      });
    },
  );

  router.post(
    '/import/:id/start',
    requirePermission(deps, 'storage:folder:edit'),
    async (req, res) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const schema = z.object({
        clientId: z.string().uuid(),
        destFolder: z.string().max(512).default(''),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const [row] = await deps.db
        .select({ id: zipImports.id, status: zipImports.status })
        .from(zipImports)
        .where(and(eq(zipImports.id, req.params['id']!), eq(zipImports.firmId, session.firmId)))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (row.status !== 'draft' && row.status !== 'error') {
        res.status(409).json({ error: 'already_started' });
        return;
      }
      // The destination client must have a bound folder, else every
      // entry would fail in the worker — fail fast here instead.
      const [bound] = await deps.db
        .select({ id: clientFolders.id })
        .from(clientFolders)
        .where(
          and(
            eq(clientFolders.clientId, parsed.data.clientId),
            eq(clientFolders.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!bound) {
        res.status(400).json({ error: 'folder_unbound' });
        return;
      }
      await deps.db
        .update(zipImports)
        .set({
          matchedClient: parsed.data.clientId,
          destFolder: parsed.data.destFolder.replace(/^\/+|\/+$/g, ''),
          status: 'queued',
          error: null,
          updatedAt: new Date(),
        })
        .where(eq(zipImports.id, row.id));
      await enqueueZipImport({
        importId: row.id,
        firmId: session.firmId,
        actorId: session.appUserId,
      });
      res.status(202).json({ ok: true });
    },
  );

  router.get('/import', requirePermission(deps, 'storage:folder:view'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const items = await deps.db
      .select({
        id: zipImports.id,
        zipName: zipImports.zipName,
        zipSizeBytes: zipImports.zipSizeBytes,
        matchedClient: zipImports.matchedClient,
        clientName: clients.name,
        destFolder: zipImports.destFolder,
        status: zipImports.status,
        totalEntries: zipImports.totalEntries,
        importedCount: zipImports.importedCount,
        skippedCount: zipImports.skippedCount,
        errorCount: zipImports.errorCount,
        error: zipImports.error,
        createdAt: zipImports.createdAt,
      })
      .from(zipImports)
      .leftJoin(clients, eq(clients.id, zipImports.matchedClient))
      .where(eq(zipImports.firmId, session.firmId))
      .orderBy(desc(zipImports.createdAt))
      .limit(50);
    res.json({ items });
  });

  router.get('/import/:id', requirePermission(deps, 'storage:folder:view'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const [row] = await deps.db
      .select()
      .from(zipImports)
      .where(and(eq(zipImports.id, req.params['id']!), eq(zipImports.firmId, session.firmId)))
      .limit(1);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ item: row });
  });

  // ── Profiles ──────────────────────────────────────────────────────
  router.get('/profiles', requirePermission(deps, 'storage:folder:view'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const items = await deps.db
      .select()
      .from(inboxRoutingProfiles)
      .where(eq(inboxRoutingProfiles.firmId, session.firmId))
      .orderBy(desc(inboxRoutingProfiles.createdAt));
    res.json({ items });
  });

  router.post('/profiles', requirePermission(deps, 'storage:folder:bind'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = ProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const [row] = await deps.db
      .insert(inboxRoutingProfiles)
      .values({
        firmId: session.firmId,
        name: parsed.data.name,
        isActive: parsed.data.isActive ?? false,
      })
      .returning({ id: inboxRoutingProfiles.id });
    if (parsed.data.isActive) await activateProfile(deps.db, session.firmId, row!.id);
    res.status(201).json({ id: row!.id });
  });

  router.patch(
    '/profiles/:id',
    requirePermission(deps, 'storage:folder:bind'),
    async (req, res) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = ProfileSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const set: Record<string, unknown> = {};
      if (parsed.data.name !== undefined) set['name'] = parsed.data.name;
      if (parsed.data.k1TargetPath !== undefined) set['k1TargetPath'] = parsed.data.k1TargetPath;
      if (parsed.data.k1YearBehavior !== undefined) {
        set['k1YearBehavior'] = parsed.data.k1YearBehavior;
      }
      if (Object.keys(set).length > 0) {
        await deps.db
          .update(inboxRoutingProfiles)
          .set(set)
          .where(
            and(
              eq(inboxRoutingProfiles.id, req.params['id']!),
              eq(inboxRoutingProfiles.firmId, session.firmId),
            ),
          );
        // The K-1 destination config controls where recipient copies land.
        if (set['k1TargetPath'] !== undefined || set['k1YearBehavior'] !== undefined) {
          await emitAudit(deps.db, {
            action: 'UPDATE',
            entityType: 'inbox_routing_profile',
            entityId: req.params['id']!,
            actorAppUserId: session.appUserId,
            after: set,
          }).catch(() => undefined);
        }
      }
      if (parsed.data.isActive) await activateProfile(deps.db, session.firmId, req.params['id']!);
      res.json({ ok: true });
    },
  );

  router.delete(
    '/profiles/:id',
    requirePermission(deps, 'storage:folder:bind'),
    async (req, res) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      await deps.db
        .delete(inboxRoutingProfiles)
        .where(
          and(
            eq(inboxRoutingProfiles.id, req.params['id']!),
            eq(inboxRoutingProfiles.firmId, session.firmId),
          ),
        );
      res.status(204).end();
    },
  );

  // ── Rules ─────────────────────────────────────────────────────────
  router.get('/rules', requirePermission(deps, 'storage:folder:view'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const profileId = typeof req.query['profileId'] === 'string' ? req.query['profileId'] : null;
    if (!profileId) {
      res.status(400).json({ error: 'profileId_required' });
      return;
    }
    // Scope: the profile must belong to the firm.
    const [prof] = await deps.db
      .select({ id: inboxRoutingProfiles.id })
      .from(inboxRoutingProfiles)
      .where(
        and(
          eq(inboxRoutingProfiles.id, profileId),
          eq(inboxRoutingProfiles.firmId, session.firmId),
        ),
      )
      .limit(1);
    if (!prof) {
      res.json({ items: [] });
      return;
    }
    const items = await deps.db
      .select()
      .from(inboxRoutingRules)
      .where(eq(inboxRoutingRules.profileId, profileId))
      .orderBy(inboxRoutingRules.sortOrder);
    res.json({ items });
  });

  router.post('/rules', requirePermission(deps, 'storage:folder:bind'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = RuleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', detail: parsed.error.flatten() });
      return;
    }
    if (!(await profileInFirm(deps.db, session.firmId, parsed.data.profileId))) {
      res.status(404).json({ error: 'profile_not_found' });
      return;
    }
    const [{ next } = { next: 0 }] = await deps.db
      .select({ next: sql<number>`COALESCE(MAX(${inboxRoutingRules.sortOrder}), -1) + 1` })
      .from(inboxRoutingRules)
      .where(eq(inboxRoutingRules.profileId, parsed.data.profileId));
    const [row] = await deps.db
      .insert(inboxRoutingRules)
      .values({ ...parsed.data, notes: parsed.data.notes ?? null, sortOrder: next })
      .returning({ id: inboxRoutingRules.id });
    res.status(201).json({ id: row!.id });
  });

  router.patch('/rules/:id', requirePermission(deps, 'storage:folder:bind'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = RulePatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    // Scope via join to the firm's profiles.
    const owned = await firmRuleIds(deps.db, session.firmId);
    if (!owned.has(req.params['id']!)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await deps.db
      .update(inboxRoutingRules)
      .set(parsed.data)
      .where(eq(inboxRoutingRules.id, req.params['id']!));
    res.json({ ok: true });
  });

  router.delete('/rules/:id', requirePermission(deps, 'storage:folder:bind'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const owned = await firmRuleIds(deps.db, session.firmId);
    if (!owned.has(req.params['id']!)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await deps.db.delete(inboxRoutingRules).where(eq(inboxRoutingRules.id, req.params['id']!));
    res.status(204).end();
  });

  router.post(
    '/rules/reorder',
    requirePermission(deps, 'storage:folder:bind'),
    async (req, res) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const schema = z.object({
        profileId: z.string().uuid(),
        orderedIds: z.array(z.string().uuid()),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      if (!(await profileInFirm(deps.db, session.firmId, parsed.data.profileId))) {
        res.status(404).json({ error: 'profile_not_found' });
        return;
      }
      await deps.db.transaction(async (tx) => {
        for (let i = 0; i < parsed.data.orderedIds.length; i++) {
          await tx
            .update(inboxRoutingRules)
            .set({ sortOrder: i })
            .where(
              and(
                eq(inboxRoutingRules.id, parsed.data.orderedIds[i]!),
                eq(inboxRoutingRules.profileId, parsed.data.profileId),
              ),
            );
        }
      });
      res.json({ ok: true });
    },
  );

  // ── Commit → route jobs ───────────────────────────────────────────
  router.post('/commit', requirePermission(deps, 'storage:folder:edit'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const schema = z.object({ itemIds: z.array(z.string().uuid()).min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const rows = await deps.db
      .select({
        id: inboxItems.id,
        matchStatus: inboxItems.matchStatus,
        included: inboxItems.included,
      })
      .from(inboxItems)
      .where(
        and(eq(inboxItems.firmId, session.firmId), inArray(inboxItems.id, parsed.data.itemIds)),
      );
    const routable = rows.filter(
      (r) => r.included && r.matchStatus !== 'folder_unbound' && r.matchStatus !== 'unparseable',
    );
    if (routable.length === 0) {
      res.status(400).json({ error: 'nothing_routable' });
      return;
    }
    const batchId = randomUUID();
    // 0229 — resolve the K-1 destination once per batch (consistent even
    // if the profile is edited mid-batch; one query instead of N).
    const k1Config = await loadK1Config(deps.db, session.firmId);
    for (const r of routable) {
      await enqueueFilerRoute({
        firmId: session.firmId,
        actorId: session.appUserId,
        batchId,
        k1Config,
        itemId: r.id,
      });
    }
    res.status(202).json({ batchId, count: routable.length });
  });

  // ── History + undo ────────────────────────────────────────────────
  router.get('/history', requirePermission(deps, 'storage:folder:view'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const items = await deps.db
      .select({
        batchId: inboxRoutingLog.batchId,
        at: sql<string>`MAX(${inboxRoutingLog.createdAt})`,
        total: sql<number>`COUNT(*)::int`,
        filed: sql<number>`COUNT(*) FILTER (WHERE ${inboxRoutingLog.action} IN ('filed','tax_flagged'))::int`,
        k1: sql<number>`COUNT(*) FILTER (WHERE ${inboxRoutingLog.action} = 'k1_recipient')::int`,
        reversed: sql<number>`COUNT(*) FILTER (WHERE ${inboxRoutingLog.status} = 'reversed')::int`,
      })
      .from(inboxRoutingLog)
      .where(eq(inboxRoutingLog.firmId, session.firmId))
      .groupBy(inboxRoutingLog.batchId)
      .orderBy(desc(sql`MAX(${inboxRoutingLog.createdAt})`))
      .limit(100);
    res.json({ items });
  });

  router.get(
    '/history/:batchId',
    requirePermission(deps, 'storage:folder:view'),
    async (req, res) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select()
        .from(inboxRoutingLog)
        .where(
          and(
            eq(inboxRoutingLog.firmId, session.firmId),
            eq(inboxRoutingLog.batchId, req.params['batchId']!),
          ),
        )
        .orderBy(desc(inboxRoutingLog.createdAt));
      res.json({ items });
    },
  );

  router.post(
    '/history/:batchId/undo',
    requirePermission(deps, 'storage:folder:edit'),
    async (req, res) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const rows = await deps.db
        .select({ id: inboxRoutingLog.id })
        .from(inboxRoutingLog)
        .where(
          and(
            eq(inboxRoutingLog.firmId, session.firmId),
            eq(inboxRoutingLog.batchId, req.params['batchId']!),
            eq(inboxRoutingLog.status, 'success'),
            inArray(inboxRoutingLog.action, ['filed', 'tax_flagged', 'k1_recipient']),
          ),
        );
      for (const r of rows) {
        await enqueueFilerUndo({ firmId: session.firmId, actorId: session.appUserId, logId: r.id });
      }
      res.status(202).json({ count: rows.length });
    },
  );

  router.post(
    '/history/log/:logId/undo',
    requirePermission(deps, 'storage:folder:edit'),
    async (req, res) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .select({ id: inboxRoutingLog.id, status: inboxRoutingLog.status })
        .from(inboxRoutingLog)
        .where(
          and(
            eq(inboxRoutingLog.id, req.params['logId']!),
            eq(inboxRoutingLog.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!row || row.status !== 'success') {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await enqueueFilerUndo({ firmId: session.firmId, actorId: session.appUserId, logId: row.id });
      res.status(202).json({ ok: true });
    },
  );

  // -----------------------------------------------------------------
  // GET /k1-recipients — clients a K-1 recipient copy may actually be
  // filed to: ACTIVE and folder-bound, the same gate k1Candidates applies
  // to scan suggestions and PATCH applies to picks. The general client
  // picker lists everyone, so offering it here produced 400s on unbound
  // picks with no way to tell which clients were eligible (review finding).
  router.get('/k1-recipients', requirePermission(deps, 'storage:folder:view'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const rows = await deps.db
      .select({ id: clients.id, name: clients.name, externalId: clients.externalId })
      .from(clients)
      .innerJoin(clientFolders, eq(clientFolders.clientId, clients.id))
      .where(
        and(
          eq(clients.firmId, session.firmId),
          eq(clients.status, 'ACTIVE'),
          eq(clientFolders.firmId, session.firmId),
        ),
      )
      .orderBy(clients.name);
    res.json({ items: rows });
  });

  // GET /clients/:clientId/folders — the client's known folder paths
  // for the inbox target-folder dropdown: every distinct subfolder that
  // already holds a file, plus the (possibly empty) top-level skeleton
  // from the firm's folder template.
  // -----------------------------------------------------------------
  router.get(
    '/clients/:clientId/folders',
    requirePermission(deps, 'storage:folder:view'),
    async (req, res) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ folders: [] });
        return;
      }
      const clientId = req.params['clientId']!;
      const [folder] = await deps.db
        .select({ id: clientFolders.id })
        .from(clientFolders)
        .where(and(eq(clientFolders.clientId, clientId), eq(clientFolders.firmId, session.firmId)))
        .limit(1);
      const existing = folder
        ? await deps.db
            .selectDistinct({ subfolderPath: files.subfolderPath })
            .from(files)
            .where(and(eq(files.clientFolderId, folder.id), sql`${files.deletedAt} IS NULL`))
        : [];
      const template = await resolveClientFolders(deps.db, session.firmId, clientId).catch(
        () => [],
      );
      const out = new Set<string>();
      for (const r of existing) {
        const p = (r.subfolderPath ?? '').trim();
        if (p) out.add(p);
      }
      for (const t of template) {
        if (t.name) out.add(t.name);
      }
      res.json({ folders: [...out].sort((a, b) => a.localeCompare(b)) });
    },
  );

  return router;
}

// ── helpers ───────────────────────────────────────────────────────────
async function activateProfile(db: Database, firmId: string, profileId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(inboxRoutingProfiles)
      .set({ isActive: false })
      .where(eq(inboxRoutingProfiles.firmId, firmId));
    await tx
      .update(inboxRoutingProfiles)
      .set({ isActive: true })
      .where(and(eq(inboxRoutingProfiles.id, profileId), eq(inboxRoutingProfiles.firmId, firmId)));
  });
}

async function profileInFirm(db: Database, firmId: string, profileId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: inboxRoutingProfiles.id })
    .from(inboxRoutingProfiles)
    .where(and(eq(inboxRoutingProfiles.id, profileId), eq(inboxRoutingProfiles.firmId, firmId)))
    .limit(1);
  return Boolean(row);
}

async function firmRuleIds(db: Database, firmId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: inboxRoutingRules.id })
    .from(inboxRoutingRules)
    .innerJoin(inboxRoutingProfiles, eq(inboxRoutingProfiles.id, inboxRoutingRules.profileId))
    .where(eq(inboxRoutingProfiles.firmId, firmId));
  return new Set(rows.map((r) => r.id));
}
