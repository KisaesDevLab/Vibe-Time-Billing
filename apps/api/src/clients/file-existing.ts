// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Server-side-copy sibling of createFileInClientFolder. The Vibe Filer
// route worker relocates an object that already lives in B2 (the Inbox/
// prefix) into a client's folder tree — so instead of streaming bytes
// through the worker (put(body)) it uses a server-side storage.copy, then
// registers the destination as a `files` row exactly like the upload
// path (subfolder normalize, Windows-safe name, collision resolution,
// firm visibility rules, audit).

import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clientFolders, clients, files, firmFolderVisibilityRules } from '@vibe/db/schema';
import {
  enforceKeyByteCap,
  joinPath,
  resolveCollision,
  sanitizeForWindows,
  type StorageClient,
} from '@vibe/storage';
import { storage as coreStorage } from '@vibe/core';

import { emitAudit } from '../auth/audit';

// Folder helpers inlined (not imported from ./files) so this module — used
// by the worker filer-route job — stays free of the Express/RBAC graph.
async function loadClientFolder(
  db: Database,
  firmId: string,
  clientId: string,
): Promise<{ clientFolderId: string; clientId: string; storagePath: string } | null> {
  const [row] = await db
    .select({
      id: clientFolders.id,
      clientId: clientFolders.clientId,
      storagePath: clientFolders.storagePath,
    })
    .from(clientFolders)
    .innerJoin(clients, eq(clients.id, clientFolders.clientId))
    .where(
      and(
        eq(clientFolders.firmId, firmId),
        eq(clientFolders.clientId, clientId),
        eq(clients.firmId, firmId),
      ),
    )
    .limit(1);
  if (!row) return null;
  return { clientFolderId: row.id, clientId: row.clientId, storagePath: row.storagePath };
}

function normalizeSubfolderPath(input: string): string {
  const trimmed = input.replace(/^\/+|\/+$/g, '');
  if (trimmed.length === 0) return '';
  return `${trimmed
    .split('/')
    .map((s) => sanitizeForWindows(s))
    .join('/')}/`;
}

async function loadFirmVisibilityRules(
  db: Database,
  firmId: string,
): Promise<coreStorage.VisibilityRule[]> {
  const rows = await db
    .select({
      subfolderPattern: firmFolderVisibilityRules.subfolderPattern,
      defaultVisibility: firmFolderVisibilityRules.defaultVisibility,
      priority: firmFolderVisibilityRules.priority,
      enabled: firmFolderVisibilityRules.enabled,
    })
    .from(firmFolderVisibilityRules)
    .where(eq(firmFolderVisibilityRules.firmId, firmId));
  return rows.map((r) => ({
    subfolderPattern: r.subfolderPattern,
    defaultVisibility: r.defaultVisibility as 'private' | 'client_visible',
    priority: r.priority,
    enabled: r.enabled,
  }));
}

export interface FileExistingObjectArgs {
  firmId: string;
  clientId: string;
  actorId: string;
  /** Full subfolder path under the client folder (rule path + year). */
  subfolderPath: string;
  originalFilename: string;
  /** Existing B2 key to copy from (server-side). */
  sourceKey: string;
  mimeType?: string | null;
  sizeBytes: number;
  /** etag of the source object (recomputed by the copy; this is a fallback). */
  etag?: string | null;
  visibility?: 'private' | 'client_visible';
  /** Provenance recorded on the row + audit (e.g. 'filer'). */
  source: string;
}

export type FileExistingObjectResult =
  | { ok: true; fileId: string; storageKey: string; etag: string }
  | { ok: false; code: 'client_folder_not_bound' | 'copy_failed'; detail?: string };

export async function fileExistingObjectIntoClientFolder(
  db: Database,
  storage: StorageClient,
  args: FileExistingObjectArgs,
): Promise<FileExistingObjectResult> {
  const folder = await loadClientFolder(db, args.firmId, args.clientId);
  if (!folder) return { ok: false, code: 'client_folder_not_bound' };

  const subfolder = normalizeSubfolderPath(args.subfolderPath);
  const safeFilename = sanitizeForWindows(args.originalFilename);
  const desired = enforceKeyByteCap(joinPath(folder.storagePath, subfolder, safeFilename));
  const storageKey = await resolveCollision(desired, async (k) => (await storage.head(k)) !== null);

  let etag: string;
  try {
    const out = await storage.copy(args.sourceKey, storageKey);
    etag = out.etag || args.etag || '';
  } catch (err) {
    return {
      ok: false,
      code: 'copy_failed',
      detail: err instanceof Error ? err.message : undefined,
    };
  }

  const visibilityRules = await loadFirmVisibilityRules(db, args.firmId);
  const visibility =
    args.visibility ?? coreStorage.resolveDefaultVisibility(subfolder, visibilityRules);

  const [row] = await db
    .insert(files)
    .values({
      firmId: args.firmId,
      clientId: folder.clientId,
      clientFolderId: folder.clientFolderId,
      subfolderPath: subfolder,
      originalFilename: safeFilename,
      storageKey,
      mimeType: args.mimeType ?? null,
      sizeBytes: args.sizeBytes,
      etag,
      category: 'other',
      source: args.source,
      visibility,
      uploadedBy: args.actorId,
      pendingUpload: false,
    })
    .returning({ id: files.id });

  await emitAudit(db, {
    action: 'CREATE',
    entityType: 'file',
    entityId: row?.id ?? null,
    actorAppUserId: args.actorId,
    after: { clientId: folder.clientId, storageKey, source: args.source, visibility },
  }).catch(() => undefined);

  return { ok: true, fileId: row!.id, storageKey, etag };
}

// =====================================================================
// 0153 — put-bytes sibling for the zip-import worker. Same registration
// path as the copy variant above, but the bytes come from an extracted
// zip entry, and collisions can SKIP instead of rename (zip import
// never overwrites and reports what it skipped — re-importing a
// cumulative export only adds the new files).
// =====================================================================

export interface FileBytesArgs {
  firmId: string;
  clientId: string;
  actorId: string;
  /** Full subfolder path under the client folder. */
  subfolderPath: string;
  originalFilename: string;
  body: Buffer;
  mimeType?: string | null;
  visibility?: 'private' | 'client_visible';
  /** Provenance recorded on the row + audit (e.g. 'zip_import'). */
  source: string;
  /** 'skip' → same-name file already there returns {code:'exists'}. */
  onCollision: 'skip' | 'rename';
}

export type FileBytesResult =
  | { ok: true; fileId: string; storageKey: string }
  | { ok: false; code: 'client_folder_not_bound' | 'exists' | 'put_failed'; detail?: string };

export async function fileBytesIntoClientFolder(
  db: Database,
  storage: StorageClient,
  args: FileBytesArgs,
): Promise<FileBytesResult> {
  const folder = await loadClientFolder(db, args.firmId, args.clientId);
  if (!folder) return { ok: false, code: 'client_folder_not_bound' };

  const subfolder = normalizeSubfolderPath(args.subfolderPath);
  const safeFilename = sanitizeForWindows(args.originalFilename);
  const desired = enforceKeyByteCap(joinPath(folder.storagePath, subfolder, safeFilename));

  let storageKey = desired;
  if (args.onCollision === 'skip') {
    if ((await storage.head(desired)) !== null) return { ok: false, code: 'exists' };
  } else {
    storageKey = await resolveCollision(desired, async (k) => (await storage.head(k)) !== null);
  }

  let etag: string;
  try {
    const out = await storage.put(storageKey, args.body, {
      contentType: args.mimeType ?? 'application/octet-stream',
    });
    etag = out.etag;
  } catch (err) {
    return {
      ok: false,
      code: 'put_failed',
      detail: err instanceof Error ? err.message : undefined,
    };
  }

  const visibility =
    args.visibility ??
    coreStorage.resolveDefaultVisibility(subfolder, await loadFirmVisibilityRules(db, args.firmId));

  const [row] = await db
    .insert(files)
    .values({
      firmId: args.firmId,
      clientId: folder.clientId,
      clientFolderId: folder.clientFolderId,
      subfolderPath: subfolder,
      originalFilename: safeFilename,
      storageKey,
      mimeType: args.mimeType ?? null,
      sizeBytes: args.body.byteLength,
      etag,
      category: 'other',
      source: args.source,
      visibility,
      uploadedBy: args.actorId,
      pendingUpload: false,
    })
    .returning({ id: files.id });

  await emitAudit(db, {
    action: 'CREATE',
    entityType: 'file',
    entityId: row?.id ?? null,
    actorAppUserId: args.actorId,
    after: { clientId: folder.clientId, storageKey, source: args.source, visibility },
  }).catch(() => undefined);

  return { ok: true, fileId: row!.id, storageKey };
}
