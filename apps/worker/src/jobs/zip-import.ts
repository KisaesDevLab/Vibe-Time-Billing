// SPDX-License-Identifier: Elastic-2.0
//
// 0153 — Vibe Filer zip import. Staff uploaded a client document export
// (.zip) and picked a client + destination folder; this job downloads
// the temp zip from B2, extracts it, and registers each entry as a
// client file — preserving the zip's internal folder structure under
// the chosen destination, NEVER overwriting (same-name files are
// skipped and reported), always internal-only (visibility 'private').
//
// Retry-safe: a partially completed run that retries skips the entries
// it already imported (the collision check sees them) and finishes the
// rest.

import AdmZip from 'adm-zip';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import { zipImports, type ZipImportResultEntry } from '@vibe/db/schema';
import type { StorageClient } from '@vibe/storage';

import { fileBytesIntoClientFolder } from '../../../api/src/clients/file-existing';

export interface ZipImportJob {
  importId: string;
  firmId: string;
  actorId: string;
}

const MAX_ENTRIES = 2000;
const MAX_ENTRY_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024; // zip-bomb guard (uncompressed)
const BLOCKED_EXT =
  /\.(exe|com|bat|cmd|msi|scr|pif|cpl|js|jse|vbs|vbe|wsf|wsh|ps1|sh|jar|app|dll|sys|reg)$/i;
// macOS/Windows packaging junk that no one wants imported.
const JUNK_RE = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  csv: 'text/csv',
  txt: 'text/plain',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function mimeFor(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/**
 * Normalize a zip entry path: forward slashes, no leading slash, and
 * NO traversal — any `..` segment (zip-slip) returns null → entry is
 * reported as an error instead of escaping the destination folder.
 */
export function safeEntryPath(entryName: string): string | null {
  const norm = entryName.replace(/\\/g, '/').replace(/^\/+/, '');
  if (norm.length === 0) return null;
  const segments = norm.split('/');
  if (segments.some((s) => s === '..' || s === '.')) return null;
  return segments.join('/');
}

async function readObject(storage: StorageClient, key: string): Promise<Buffer> {
  const obj = await storage.get(key);
  const chunks: Buffer[] = [];
  for await (const chunk of obj.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

export async function runZipImport(
  db: Database,
  storage: StorageClient,
  logger: Logger,
  job: ZipImportJob,
): Promise<void> {
  const [row] = await db.select().from(zipImports).where(eq(zipImports.id, job.importId)).limit(1);
  if (!row || row.firmId !== job.firmId) {
    logger.warn({ importId: job.importId }, 'zip-import: row missing — nothing to do');
    return;
  }
  if (row.status === 'done') return; // idempotent re-delivery
  if (!row.matchedClient || row.destFolder == null) {
    await db
      .update(zipImports)
      .set({ status: 'error', error: 'client_or_folder_missing', updatedAt: new Date() })
      .where(eq(zipImports.id, row.id));
    return;
  }

  await db
    .update(zipImports)
    .set({ status: 'running', updatedAt: new Date() })
    .where(eq(zipImports.id, row.id));

  const results: ZipImportResultEntry[] = [];
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  try {
    const zipBytes = await readObject(storage, row.zipKey);
    const zip = new AdmZip(zipBytes);
    const entries = zip.getEntries().filter((e) => !e.isDirectory);

    if (entries.length > MAX_ENTRIES) {
      throw new Error(`too_many_entries (${entries.length} > ${MAX_ENTRIES})`);
    }
    const totalUncompressed = entries.reduce((sum, e) => sum + e.header.size, 0);
    if (totalUncompressed > MAX_TOTAL_BYTES) {
      throw new Error(`uncompressed_too_large (${totalUncompressed} bytes)`);
    }

    for (const entry of entries) {
      const path = safeEntryPath(entry.entryName);
      if (path === null) {
        errors += 1;
        results.push({ path: entry.entryName, status: 'error', detail: 'unsafe_path' });
        continue;
      }
      if (JUNK_RE.test(path)) continue; // silently drop packaging junk
      if (BLOCKED_EXT.test(path)) {
        errors += 1;
        results.push({ path, status: 'error', detail: 'blocked_type' });
        continue;
      }
      if (entry.header.size > MAX_ENTRY_BYTES) {
        errors += 1;
        results.push({ path, status: 'error', detail: 'entry_too_large' });
        continue;
      }

      const slash = path.lastIndexOf('/');
      const entryDir = slash >= 0 ? path.slice(0, slash) : '';
      const filename = slash >= 0 ? path.slice(slash + 1) : path;
      const subfolderPath = [row.destFolder, entryDir].filter(Boolean).join('/');

      const body = entry.getData();
      const out = await fileBytesIntoClientFolder(db, storage, {
        firmId: row.firmId,
        clientId: row.matchedClient,
        actorId: job.actorId,
        subfolderPath,
        originalFilename: filename,
        body,
        mimeType: mimeFor(filename),
        visibility: 'private',
        source: 'zip_import',
        onCollision: 'skip',
      });
      if (out.ok) {
        imported += 1;
        results.push({ path, status: 'imported' });
      } else if (out.code === 'exists') {
        skipped += 1;
        results.push({ path, status: 'skipped', detail: 'already_exists' });
      } else {
        errors += 1;
        results.push({ path, status: 'error', detail: out.detail ?? out.code });
        // A missing folder binding fails every entry the same way — bail.
        if (out.code === 'client_folder_not_bound') throw new Error('client_folder_not_bound');
      }
    }

    await db
      .update(zipImports)
      .set({
        status: 'done',
        totalEntries: results.length,
        importedCount: imported,
        skippedCount: skipped,
        errorCount: errors,
        results,
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(zipImports.id, row.id));

    // Imported zips don't need to linger in the temp prefix — delete the
    // temp object now that every entry is filed. Best-effort, but a
    // failure is logged (not silently swallowed) so an undeletable zip
    // can't pile up in storage unnoticed.
    try {
      await storage.delete(row.zipKey);
    } catch (err) {
      logger.warn(
        { err, importId: row.id, zipKey: row.zipKey },
        'zip-import: temp zip delete failed — object may linger in storage',
      );
    }
    logger.info({ importId: row.id, imported, skipped, errors }, 'zip-import complete');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'zip_import_failed';
    await db
      .update(zipImports)
      .set({
        status: 'error',
        totalEntries: results.length || null,
        importedCount: imported,
        skippedCount: skipped,
        errorCount: errors,
        results: results.length > 0 ? results : null,
        error: message,
        updatedAt: new Date(),
      })
      .where(eq(zipImports.id, row.id));
    logger.error({ err, importId: row.id }, 'zip-import failed');
    throw err; // let BullMQ retry — already-imported entries skip on rerun
  }
}
