// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// FMv2 §4.1–§4.5 — Per-client folder linking API.
//
// Mounted under /api/staff/clients/:id by routes.ts:
//   POST /:id/folder/match           — candidate folders for the link modal
//   POST /:id/folder/match/search    — filter the candidate list by query
//   POST /:id/folder/link            — bind client to a folder; 409 on contest
//   POST /:id/folder/create          — create a new folder + bind
//   GET  /:id/folder/index-status    — SSE stream for post-link indexing
//
// All endpoints require `storage:folder:bind` (or `view` for the read
// surfaces). The conflict branch (409 with attempt_id) on /link is
// the seam to FMv2 Phase D.

import { type Request, type Response, type Router } from 'express';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { clientFolders, clients, folderLinkAttempts, folderSyncEvents } from '@vibe/db/schema';
import {
  buildStorageClient,
  match,
  readSentinel,
  sentinelKey,
  writeSentinel,
  type ClientForMatch,
  type FolderCandidate,
  type MatchOutput,
  type SentinelV1,
  type StorageClient,
} from '@vibe/storage';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';

export interface FolderLinkDeps extends RbacDeps {
  db: Database | null;
  /** Pre-built storage client; falls back to env. Test seam. */
  storage?: StorageClient;
}

const SearchSchema = z.object({
  query: z.string().min(1).max(120),
});

const LinkSchema = z.object({
  storage_path: z.string().min(1).max(1024),
});

const CreateSchema = z.object({
  folder_name: z.string().min(1).max(240),
});

// Windows-safe sanitization per v1 §Phase 8.
function sanitizeFolderName(name: string): string {
  // Windows-illegal chars + ASCII control range. Disable the control-
  // regex lint locally — the range IS the point of the rule.
  let s = name.replace(/[<>:"|?*]/g, '');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x1f]/g, '');
  return s.replace(/[/\\]/g, '-').replace(/\.+$/, '').replace(/\s+/g, ' ').trim();
}

function getStorage(deps: FolderLinkDeps): StorageClient | null {
  if (deps.storage) return deps.storage;
  try {
    return buildStorageClient(process.env);
  } catch {
    return null;
  }
}

// Read sentinel best-effort; missing or unparseable returns null
// rather than throwing so the match engine can still classify
// unbound vs orphan.
async function tryReadSentinel(storage: StorageClient, path: string): Promise<SentinelV1 | null> {
  try {
    const result = await readSentinel(storage, path);
    if (result.ok) return result.payload;
    return null;
  } catch {
    return null;
  }
}

async function loadClientForMatch(
  db: Database,
  clientId: string,
  firmId: string,
): Promise<ClientForMatch | null> {
  const [row] = await db
    .select({
      id: clients.id,
      name: clients.name,
      clientFacingName: clients.clientFacingName,
      taxSoftwareId: clients.taxSoftwareId,
    })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.firmId, firmId)))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    tax_software_id: row.taxSoftwareId,
    client_facing_name: row.clientFacingName,
  };
}

async function listFolderCandidates(
  storage: StorageClient,
  db: Database,
  firmId: string,
  query?: string,
): Promise<FolderCandidate[]> {
  const topPrefix = process.env['STORAGE_TOP_PREFIX'] ?? '';
  const systemPrefix = process.env['STORAGE_SYSTEM_PREFIX'] ?? '_system/';
  const observed: string[] = [];
  for await (const entry of storage.list(topPrefix, { delimiter: '/' })) {
    if (entry.kind !== 'prefix') continue;
    if (systemPrefix && entry.key.startsWith(systemPrefix)) continue;
    if (query && !entry.key.toLowerCase().includes(query.toLowerCase())) continue;
    observed.push(entry.key);
  }
  // Cap at 500 paths to honor the §3.6 perf budget even for very
  // large firms. Real listing pagination would page; this is enough
  // for the link modal which only shows the top 10 anyway.
  observed.splice(500);

  // Snapshot existing bindings to overlay sentinel + bound_to.
  const folderRows = await db
    .select({
      clientId: clientFolders.clientId,
      storagePath: clientFolders.storagePath,
    })
    .from(clientFolders)
    .where(eq(clientFolders.firmId, firmId));
  const byPath = new Map(folderRows.map((r) => [r.storagePath, r.clientId]));

  // Pull each bound-client's display name once.
  const boundClientIds = Array.from(new Set(folderRows.map((r) => r.clientId)));
  let nameMap = new Map<string, string>();
  if (boundClientIds.length > 0) {
    const rows = await db
      .select({ id: clients.id, name: clients.name })
      .from(clients)
      .where(inArray(clients.id, boundClientIds));
    nameMap = new Map(rows.map((r) => [r.id, r.name]));
  }

  const out: FolderCandidate[] = [];
  for (const path of observed) {
    const boundClientId = byPath.get(path) ?? null;
    // Read sentinel only when the path is bound, OR (conservatively)
    // when we want to surface stale-sentinel cases. For the match
    // endpoint we lean on the DB binding as truth and only fetch
    // sentinel when needed. This keeps the call O(1) B2 LIST per
    // request.
    let sentinel: SentinelV1 | null = null;
    if (boundClientId) {
      sentinel = await tryReadSentinel(storage, path);
    }
    out.push({
      storage_path: path,
      // Stats: keep them rough; v1 listing API may not return
      // per-folder size totals cheaply. The link modal only shows
      // them as flavor.
      file_count: 0,
      size_bytes: 0,
      last_modified: new Date().toISOString(),
      sentinel: sentinel
        ? {
            client_id: sentinel.client_id,
            display_name_at_creation: sentinel.display_name_at_creation ?? path,
          }
        : boundClientId
          ? {
              client_id: boundClientId,
              display_name_at_creation: path,
            }
          : undefined,
      bound_to: boundClientId
        ? {
            client_id: boundClientId,
            client_name: nameMap.get(boundClientId) ?? '(unknown)',
          }
        : undefined,
    });
  }
  return out;
}

async function runMatch(
  deps: FolderLinkDeps,
  clientId: string,
  firmId: string,
  query: string | undefined,
  res: Response,
): Promise<MatchOutput | null> {
  if (!deps.db) {
    res.status(503).json({ error: 'db_unavailable' });
    return null;
  }
  const storage = getStorage(deps);
  if (!storage) {
    res.status(503).json({ error: 'storage_unavailable' });
    return null;
  }
  const client = await loadClientForMatch(deps.db, clientId, firmId);
  if (!client) {
    res.status(404).json({ error: 'client_not_found' });
    return null;
  }
  const folders = await listFolderCandidates(storage, deps.db, firmId, query);
  return match({ client, folders });
}

export function mountFolderLinkRoutes(router: Router, deps: FolderLinkDeps): void {
  router.post(
    '/:id/folder/match',
    requirePermission(deps, 'storage:folder:bind'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId ?? '';
      const out = await runMatch(deps, req.params['id']!, firmId, undefined, res);
      if (!out) return;
      res.json(out);
    },
  );

  router.post(
    '/:id/folder/match/search',
    requirePermission(deps, 'storage:folder:bind'),
    async (req: Request, res: Response) => {
      const parsed = SearchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const firmId = req.staffSession?.firmId ?? '';
      const out = await runMatch(deps, req.params['id']!, firmId, parsed.data.query, res);
      if (!out) return;
      res.json(out);
    },
  );

  router.post(
    '/:id/folder/link',
    requirePermission(deps, 'storage:folder:bind'),
    async (req: Request, res: Response) => {
      const session = req.staffSession;
      if (!session || !deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = LinkSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const storage = getStorage(deps);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }
      const clientId = req.params['id']!;
      const storagePath = parsed.data.storage_path;

      // Verify client + firm.
      const [client] = await deps.db
        .select({ id: clients.id, name: clients.name })
        .from(clients)
        .where(and(eq(clients.id, clientId), eq(clients.firmId, session.firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }

      // Block when a different client_folders row points at this client.
      const [existingForClient] = await deps.db
        .select({ id: clientFolders.id, storagePath: clientFolders.storagePath })
        .from(clientFolders)
        .where(eq(clientFolders.clientId, clientId))
        .limit(1);
      if (existingForClient && existingForClient.storagePath !== storagePath) {
        res.status(409).json({
          code: 'client_already_bound',
          current_storage_path: existingForClient.storagePath,
        });
        return;
      }

      // Read sentinel. If it points at another client → contested.
      const sentinel = await tryReadSentinel(storage, storagePath);
      if (sentinel && sentinel.client_id !== clientId) {
        // Look up the other client for the response payload.
        const [other] = await deps.db
          .select({ id: clients.id, name: clients.name })
          .from(clients)
          .where(eq(clients.id, sentinel.client_id))
          .limit(1);
        const [attempt] = await deps.db
          .insert(folderLinkAttempts)
          .values({
            firmId: session.firmId,
            clientId,
            storagePath,
            attemptedBy: session.appUserId,
            outcome: 'contested',
          })
          .returning({ id: folderLinkAttempts.id });
        await deps.db
          .insert(folderSyncEvents)
          .values({
            firmId: session.firmId,
            eventType: 'link_contested',
            pathAfter: storagePath,
            notes: `Challenger ${client.name} vs current ${other?.name ?? 'unknown'}`,
          })
          .catch((err: unknown) => logger.error({ err }, 'failed to insert link_contested event'));
        res.status(409).json({
          code: 'folder_already_bound',
          bound_to: other ? { client_id: other.id, client_name: other.name } : null,
          attempt_id: attempt?.id ?? null,
          admin_url: attempt?.id ? `/admin/storage/conflicts/${attempt.id}` : null,
        });
        return;
      }

      // Idempotent: sentinel matches this client → ensure client_folders
      // row exists, return 200.
      if (sentinel && sentinel.client_id === clientId) {
        let folderId: string;
        if (existingForClient) {
          folderId = existingForClient.id;
        } else {
          const [created] = await deps.db
            .insert(clientFolders)
            .values({
              firmId: session.firmId,
              clientId,
              storagePath,
              status: 'active',
              lastSyncedAt: new Date(),
            })
            .returning({ id: clientFolders.id });
          folderId = created!.id;
        }
        res.status(200).json({
          client_folder_id: folderId,
          storage_path: storagePath,
          status: 'active',
          index_channel: `storage:index:${folderId}`,
          idempotent: true,
        });
        return;
      }

      // No sentinel → write one, create client_folders + audit rows.
      try {
        await writeSentinel(storage, storagePath, {
          version: 1,
          client_id: clientId,
          firm_id: session.firmId,
          tax_software_id: null,
          created_at: new Date().toISOString(),
          created_by: session.appUserId,
          display_name_at_creation: client.name,
        });
      } catch (err) {
        logger.error({ err, storagePath }, 'sentinel write failed');
        res.status(502).json({ error: 'sentinel_write_failed' });
        return;
      }
      const [folder] = await deps.db
        .insert(clientFolders)
        .values({
          firmId: session.firmId,
          clientId,
          storagePath,
          status: 'active',
          lastSyncedAt: new Date(),
        })
        .returning({ id: clientFolders.id });
      await deps.db
        .insert(folderLinkAttempts)
        .values({
          firmId: session.firmId,
          clientId,
          storagePath,
          attemptedBy: session.appUserId,
          outcome: 'linked',
        })
        .catch(() => undefined);
      await deps.db
        .insert(folderSyncEvents)
        .values({
          firmId: session.firmId,
          clientFolderId: folder!.id,
          eventType: 'link_attempted',
          pathAfter: storagePath,
        })
        .catch(() => undefined);
      res.status(201).json({
        client_folder_id: folder!.id,
        storage_path: storagePath,
        status: 'indexing',
        index_channel: `storage:index:${folder!.id}`,
        estimated_file_count: 0,
      });
    },
  );

  router.post(
    '/:id/folder/create',
    requirePermission(deps, 'storage:folder:bind'),
    async (req: Request, res: Response) => {
      const session = req.staffSession;
      if (!session || !deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const storage = getStorage(deps);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }
      const clientId = req.params['id']!;
      const sanitized = sanitizeFolderName(parsed.data.folder_name);
      if (sanitized.length === 0) {
        res.status(400).json({ error: 'invalid_folder_name' });
        return;
      }
      const storagePath = `${sanitized}/`;
      const [client] = await deps.db
        .select({ id: clients.id, name: clients.name })
        .from(clients)
        .where(and(eq(clients.id, clientId), eq(clients.firmId, session.firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }
      // Block when a client is already bound to anything.
      const [existing] = await deps.db
        .select({ id: clientFolders.id })
        .from(clientFolders)
        .where(eq(clientFolders.clientId, clientId))
        .limit(1);
      if (existing) {
        res.status(409).json({ code: 'client_already_bound' });
        return;
      }
      // Refuse if path already exists in the bucket (sentinel present).
      const existingSentinel = await tryReadSentinel(storage, storagePath);
      if (existingSentinel) {
        res.status(409).json({ code: 'folder_already_exists' });
        return;
      }
      try {
        await writeSentinel(storage, storagePath, {
          version: 1,
          client_id: clientId,
          firm_id: session.firmId,
          tax_software_id: null,
          created_at: new Date().toISOString(),
          created_by: session.appUserId,
          display_name_at_creation: client.name,
        });
      } catch (err) {
        logger.error({ err, storagePath }, 'sentinel write failed (create)');
        res.status(502).json({ error: 'sentinel_write_failed' });
        return;
      }
      const [folder] = await deps.db
        .insert(clientFolders)
        .values({
          firmId: session.firmId,
          clientId,
          storagePath,
          status: 'active',
          lastSyncedAt: new Date(),
        })
        .returning({ id: clientFolders.id });
      await deps.db
        .insert(folderLinkAttempts)
        .values({
          firmId: session.firmId,
          clientId,
          storagePath,
          attemptedBy: session.appUserId,
          outcome: 'linked',
          notes: 'Created via /folder/create',
        })
        .catch(() => undefined);
      await deps.db
        .insert(folderSyncEvents)
        .values({
          firmId: session.firmId,
          clientFolderId: folder!.id,
          eventType: 'link_attempted',
          pathAfter: storagePath,
          notes: 'created',
        })
        .catch(() => undefined);
      res.status(201).json({
        client_folder_id: folder!.id,
        storage_path: storagePath,
        status: 'indexing',
        index_channel: `storage:index:${folder!.id}`,
        estimated_file_count: 0,
      });
    },
  );

  // Index-status SSE — when Redis is wired we publish to the channel
  // returned by /link. For v1 of this route, we provide a polling
  // fallback that reads the latest folder state from the DB.
  router.get(
    '/:id/folder/index-status',
    requirePermission(deps, 'storage:folder:view'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const session = req.staffSession;
      if (!session) {
        res.status(401).json({ error: 'no_session' });
        return;
      }
      const clientId = req.params['id']!;
      const [folder] = await deps.db
        .select({
          id: clientFolders.id,
          status: clientFolders.status,
          lastSyncedAt: clientFolders.lastSyncedAt,
        })
        .from(clientFolders)
        .where(and(eq(clientFolders.clientId, clientId), eq(clientFolders.firmId, session.firmId)))
        .limit(1);
      if (!folder) {
        res.status(404).json({ error: 'folder_not_found' });
        return;
      }
      // Honest snapshot — production wires the SSE stream over Redis;
      // this surface still returns a usable JSON for polling clients.
      res.json({
        client_folder_id: folder.id,
        status: folder.status,
        last_synced_at: folder.lastSyncedAt?.toISOString() ?? null,
        index_channel: `storage:index:${folder.id}`,
      });
    },
  );

  // Silence unused imports retained for future expansion.
  void sentinelKey;
  void isNull;
}
