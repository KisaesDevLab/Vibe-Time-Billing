// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Storage onboarding endpoints (Phase 4 of FILE_MANAGER_ADDENDUM.md).
// Surfaces every top-level folder in the firm's bucket area, classifies
// it as bound / unbound / orphan / conflict, computes match candidates
// against clients without folders, and lets the admin bind or unbind a
// folder to a client. Binding writes the sentinel + creates the
// client_folders row + resolves the open discovered event in a single
// transaction.
//
// Permission gating uses `client:write` for now — the granular
// `storage.folder.bind` / `storage.folder.reconcile` codes land in
// Phase 7 and the swap is one-line.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import type { Database } from '@vibe/db';
import { clientFolders, clients, folderSyncEvents } from '@vibe/db/schema';
import { storage as coreStorage } from '@vibe/core';
import {
  buildStorageClient,
  folderBasename,
  readSentinel,
  sentinelKey,
  writeSentinel,
  type SentinelV1,
  type StorageClient,
} from '@vibe/storage';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';

export interface StorageOnboardingDeps extends RbacDeps {
  db: Database | null;
  /** Pre-built storage client. When omitted, the factory is invoked
   *  with process.env — useful for tests that want to inject a mock. */
  storage?: StorageClient;
}

interface ScanResult {
  bucketArea: string;
  systemPrefix: string;
  unmatchedFolders: UnmatchedFolderRow[];
  boundFolders: BoundFolderRow[];
  problemFolders: ProblemFolderRow[];
  unmatchedClients: UnmatchedClientRow[];
}

interface UnmatchedFolderRow {
  path: string;
  taxSoftwareIdParsed: string | null;
  candidates: ReturnType<typeof coreStorage.scoreFolderMatches>;
}

interface BoundFolderRow {
  path: string;
  clientFolderId: string;
  clientId: string;
  clientName: string;
}

interface ProblemFolderRow {
  path: string;
  kind: 'orphan' | 'sentinel_changed' | 'conflict';
  detail?: string;
}

interface UnmatchedClientRow {
  id: string;
  name: string;
  clientFacingName: string | null;
  taxSoftwareId: string | null;
}

const BindSchema = z.object({
  folderPath: z.string().min(1).max(1024),
  clientId: z.string().uuid(),
  taxSoftwareId: z.string().max(64).optional(),
  taxSoftwareKind: z.string().max(64).optional(),
});

const UnbindSchema = z.object({
  clientFolderId: z.string().uuid(),
  deleteSentinel: z.boolean().optional(),
});

function getStorage(deps: StorageOnboardingDeps): StorageClient | null {
  if (deps.storage) return deps.storage;
  try {
    return buildStorageClient(process.env);
  } catch {
    return null;
  }
}

export function createStorageOnboardingRouter(deps: StorageOnboardingDeps): Router {
  const router = express.Router();

  router.get(
    '/scan',
    requirePermission(deps, 'storage:folder:view'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({
          bucketArea: '',
          systemPrefix: '_system/',
          unmatchedFolders: [],
          boundFolders: [],
          problemFolders: [],
          unmatchedClients: [],
        });
        return;
      }
      const storage = getStorage(deps);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }

      const topPrefix = process.env['STORAGE_TOP_PREFIX'] ?? '';
      const systemPrefix = process.env['STORAGE_SYSTEM_PREFIX'] ?? '_system/';

      // 1) List top-level prefixes from storage.
      const observedPaths: string[] = [];
      for await (const entry of storage.list(topPrefix, { delimiter: '/' })) {
        if (entry.kind !== 'prefix') continue;
        if (systemPrefix && entry.key.startsWith(systemPrefix)) continue;
        observedPaths.push(entry.key);
      }

      // 2) Snapshot existing folder bindings + clients for this firm.
      const folderRows = await deps.db
        .select({
          id: clientFolders.id,
          clientId: clientFolders.clientId,
          storagePath: clientFolders.storagePath,
          status: clientFolders.status,
        })
        .from(clientFolders)
        .where(eq(clientFolders.firmId, firmId));
      const boundByPath = new Map<string, (typeof folderRows)[number]>();
      const boundClientIds = new Set<string>();
      for (const f of folderRows) {
        boundByPath.set(f.storagePath, f);
        boundClientIds.add(f.clientId);
      }

      const clientRows = await deps.db
        .select({
          id: clients.id,
          name: clients.name,
          clientFacingName: clients.clientFacingName,
          taxSoftwareId: clients.taxSoftwareId,
          status: clients.status,
        })
        .from(clients)
        .where(eq(clients.firmId, firmId));
      const activeClients = clientRows.filter((c) => c.status === 'ACTIVE');
      const clientById = new Map(activeClients.map((c) => [c.id, c]));

      // 3) Classify each observed folder.
      const unmatchedFolders: UnmatchedFolderRow[] = [];
      const boundFolders: BoundFolderRow[] = [];
      const problemFolders: ProblemFolderRow[] = [];

      const seenClientFromSentinel = new Map<string, string>();

      for (const path of observedPaths) {
        const sentinel = await readSentinel(storage, path, { expectedFirmId: firmId });
        const existing = boundByPath.get(path) ?? null;

        if (!sentinel.ok) {
          if (sentinel.reason === 'wrong_firm') {
            problemFolders.push({
              path,
              kind: 'orphan',
              detail: 'Sentinel belongs to a different firm',
            });
            continue;
          }
          if (sentinel.reason === 'schema_invalid' || sentinel.reason === 'unparseable') {
            problemFolders.push({
              path,
              kind: 'sentinel_changed',
              detail: sentinel.reason,
            });
            continue;
          }
          // sentinel.reason === 'missing'
          if (existing) {
            // Bound row + missing sentinel → surface as a problem
            // (sentinel_lost is handled by the sync worker; we list it
            // here too so the admin sees it on the onboarding screen).
            problemFolders.push({
              path,
              kind: 'sentinel_changed',
              detail: 'Sentinel file missing',
            });
            continue;
          }
          // Unbound + no sentinel → candidates by folder name only.
          // Match on the basename — under STORAGE_TOP_PREFIX the full
          // path carries leading segments that aren't part of the name.
          const candidates = coreStorage.scoreFolderMatches(folderBasename(path), activeClients);
          unmatchedFolders.push({
            path,
            taxSoftwareIdParsed: coreStorage.parseTaxSoftwareId(folderBasename(path)),
            candidates,
          });
          continue;
        }

        // Sentinel valid.
        const prior = seenClientFromSentinel.get(sentinel.payload.client_id);
        if (prior && prior !== path) {
          problemFolders.push({
            path,
            kind: 'conflict',
            detail: `Shares client_id with ${prior}`,
          });
          continue;
        }
        seenClientFromSentinel.set(sentinel.payload.client_id, path);

        const client = clientById.get(sentinel.payload.client_id);
        if (!client) {
          problemFolders.push({
            path,
            kind: 'orphan',
            detail: 'Sentinel points at an unknown client',
          });
          continue;
        }

        if (existing) {
          boundFolders.push({
            path,
            clientFolderId: existing.id,
            clientId: client.id,
            clientName: client.name,
          });
          continue;
        }

        // Sentinel valid + client exists + no DB row → surface as
        // unmatched so admin can confirm a sync-worker discovery.
        unmatchedFolders.push({
          path,
          taxSoftwareIdParsed: coreStorage.parseTaxSoftwareId(folderBasename(path)),
          candidates: [
            {
              clientId: client.id,
              confidence: 1,
              reason: 'tax_software_id',
            },
          ],
        });
      }

      // 4) Clients without any folder binding.
      const unmatchedClients: UnmatchedClientRow[] = activeClients
        .filter((c) => !boundClientIds.has(c.id))
        .map((c) => ({
          id: c.id,
          name: c.name,
          clientFacingName: c.clientFacingName ?? null,
          taxSoftwareId: c.taxSoftwareId ?? null,
        }));

      const result: ScanResult = {
        bucketArea: topPrefix,
        systemPrefix,
        unmatchedFolders,
        boundFolders,
        problemFolders,
        unmatchedClients,
      };
      res.json(result);
    },
  );

  router.post(
    '/bind',
    requirePermission(deps, 'storage:folder:bind'),
    async (req: Request, res: Response) => {
      const parsed = BindSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const firmId = req.staffSession?.firmId;
      const actorId = req.staffSession?.appUserId ?? null;
      if (!firmId || !deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const storage = getStorage(deps);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }

      const folderPath = parsed.data.folderPath.endsWith('/')
        ? parsed.data.folderPath
        : `${parsed.data.folderPath}/`;

      // Verify the client exists in this firm.
      const [client] = await deps.db
        .select({
          id: clients.id,
          name: clients.name,
          taxSoftwareId: clients.taxSoftwareId,
          taxSoftwareKind: clients.taxSoftwareKind,
        })
        .from(clients)
        .where(and(eq(clients.id, parsed.data.clientId), eq(clients.firmId, firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }

      // Refuse if the client is already bound or another binding owns the path.
      const [conflict] = await deps.db
        .select({ id: clientFolders.id, clientId: clientFolders.clientId })
        .from(clientFolders)
        .where(and(eq(clientFolders.firmId, firmId), eq(clientFolders.storagePath, folderPath)))
        .limit(1);
      if (conflict && conflict.clientId !== client.id) {
        res.status(409).json({ error: 'path_already_bound' });
        return;
      }
      const [existingForClient] = await deps.db
        .select({ id: clientFolders.id, storagePath: clientFolders.storagePath })
        .from(clientFolders)
        .where(and(eq(clientFolders.firmId, firmId), eq(clientFolders.clientId, client.id)))
        .limit(1);
      if (existingForClient && existingForClient.storagePath !== folderPath) {
        res.status(409).json({
          error: 'client_already_bound',
          existingPath: existingForClient.storagePath,
        });
        return;
      }

      // Write sentinel first. If storage fails, we don't touch the DB.
      const sentinelPayload: SentinelV1 = {
        version: 1,
        client_id: client.id,
        firm_id: firmId,
        tax_software_id: parsed.data.taxSoftwareId ?? client.taxSoftwareId ?? null,
        display_name_at_creation: client.name,
        created_at: new Date().toISOString(),
        created_by: actorId,
      };
      let sentinelEtag: string;
      try {
        const written = await writeSentinel(storage, folderPath, sentinelPayload);
        sentinelEtag = written.etag;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'sentinel_write_failed';
        res.status(502).json({ error: 'sentinel_write_failed', detail: message });
        return;
      }

      // If the caller passed a tax_software_id and the client didn't have
      // one, persist it. Same for kind.
      const clientUpdates: Record<string, unknown> = {};
      if (parsed.data.taxSoftwareId && !client.taxSoftwareId) {
        clientUpdates.taxSoftwareId = parsed.data.taxSoftwareId;
      }
      if (parsed.data.taxSoftwareKind && !client.taxSoftwareKind) {
        clientUpdates.taxSoftwareKind = parsed.data.taxSoftwareKind;
      }

      let newClientFolderId: string | null = existingForClient?.id ?? null;
      await deps.db.transaction(async (tx) => {
        if (existingForClient) {
          await tx
            .update(clientFolders)
            .set({
              storagePath: folderPath,
              sentinelEtag,
              status: 'active',
              lastSyncedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(clientFolders.id, existingForClient.id));
        } else {
          const id = randomUUID();
          await tx.insert(clientFolders).values({
            id,
            firmId,
            clientId: client.id,
            storagePath: folderPath,
            sentinelEtag,
            status: 'active',
            lastSyncedAt: new Date(),
          });
          newClientFolderId = id;
        }
        if (Object.keys(clientUpdates).length > 0) {
          await tx.update(clients).set(clientUpdates).where(eq(clients.id, client.id));
        }
        // Resolve any open `discovered` event that points at this path.
        await tx
          .update(folderSyncEvents)
          .set({
            resolvedAt: new Date(),
            resolvedBy: actorId,
            resolution: 'bound',
            clientFolderId: newClientFolderId,
          })
          .where(
            and(
              eq(folderSyncEvents.firmId, firmId),
              eq(folderSyncEvents.eventType, 'discovered'),
              eq(folderSyncEvents.pathAfter, folderPath),
              isNull(folderSyncEvents.resolvedAt),
            ),
          );
      });

      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'client_folder',
        entityId: newClientFolderId,
        actorAppUserId: actorId,
        after: {
          clientId: client.id,
          storagePath: folderPath,
          sentinelEtag,
        },
      }).catch(() => undefined);

      res.status(201).json({
        clientFolderId: newClientFolderId,
        storagePath: folderPath,
        sentinelEtag,
      });
    },
  );

  router.post(
    '/unbind',
    requirePermission(deps, 'storage:folder:bind'),
    async (req: Request, res: Response) => {
      const parsed = UnbindSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const firmId = req.staffSession?.firmId;
      const actorId = req.staffSession?.appUserId ?? null;
      if (!firmId || !deps.db) {
        res.json({ ok: true });
        return;
      }
      const storage = getStorage(deps);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }

      const [row] = await deps.db
        .select({
          id: clientFolders.id,
          clientId: clientFolders.clientId,
          storagePath: clientFolders.storagePath,
        })
        .from(clientFolders)
        .where(
          and(eq(clientFolders.id, parsed.data.clientFolderId), eq(clientFolders.firmId, firmId)),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'client_folder_not_found' });
        return;
      }

      // Optionally delete the sentinel file.
      if (parsed.data.deleteSentinel) {
        try {
          await storage.delete(sentinelKey(row.storagePath));
        } catch (err) {
          const message = err instanceof Error ? err.message : 'sentinel_delete_failed';
          res.status(502).json({ error: 'sentinel_delete_failed', detail: message });
          return;
        }
      }

      await deps.db.transaction(async (tx) => {
        await tx.delete(clientFolders).where(eq(clientFolders.id, row.id));
        await tx.insert(folderSyncEvents).values({
          firmId,
          clientFolderId: null,
          eventType: 'missing',
          pathBefore: row.storagePath,
          pathAfter: null,
          sentinelPayload: { reason: 'unbound_by_admin' },
          resolvedAt: new Date(),
          resolvedBy: actorId,
          resolution: 'unbound',
        });
      });

      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'client_folder',
        entityId: row.id,
        actorAppUserId: actorId,
        before: { clientId: row.clientId, storagePath: row.storagePath },
      }).catch(() => undefined);

      res.json({ ok: true });
    },
  );

  return router;
}
