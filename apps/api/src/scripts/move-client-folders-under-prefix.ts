// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// One-time layout migration: move client folders from the bucket root
// under STORAGE_TOP_PREFIX (default `Client Files/`).
//
// The FMv2 storage layout originally put every client folder at the
// top of the bucket, next to app-managed prefixes (Inbox/, messages/,
// branding/, intake/, signatures/, …). This script relocates the
// client folders under one parent so the sync worker's listing scope
// is exactly "client folders" and nothing else.
//
// What it does, per top-level folder that is NOT a known app prefix:
//   1. Server-side copies every object to `<prefix><old key>`.
//   2. Verifies the destination exists with the same size.
//   3. Deletes the source object.
// Then rewrites DB rows that carry full storage paths/keys:
//   - client_folders.storage_path
//   - files.storage_key
//   - folder_link_attempts.storage_path (open attempts only)
//   - folder_sync_events.path_before/path_after (open events only)
//
// Dry-run by default — prints the plan. Pass --execute to apply.
// Idempotent: a source object whose destination already exists (same
// size) is treated as copied; re-running after a partial failure
// finishes the job.
//
// Usage (inside the appliance container, where the sealed firm key +
// DB-held storage credentials resolve):
//   DATABASE_URL=... node .../move-client-folders-under-prefix.js [--execute] [--prefix "Client Files/"]

import { eq, inArray, isNull, and, like, sql } from 'drizzle-orm';

import { createDb, schemaTables } from '@vibe/db';
import { buildStorageClient, normalizeTopPrefix, type StorageClient } from '@vibe/storage';

import { bootCrypto } from '../crypto/boot';
import { applyStorageSettingsFromDb } from '../admin/storage-settings/boot';

const { clientFolders, files, folderLinkAttempts, folderSyncEvents } = schemaTables;

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1] ?? null;
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const execute = process.argv.includes('--execute');

  const prefix = normalizeTopPrefix(
    argValue('--prefix') ?? process.env['STORAGE_TOP_PREFIX'] ?? 'Client Files/',
  );
  if (!prefix) throw new Error('Refusing to run with an empty target prefix');

  // Top-level prefixes that are NOT client folders and must stay put.
  const systemPrefix = process.env['STORAGE_SYSTEM_PREFIX'] ?? '_system/';
  const inboxPrefix = process.env['FILER_INBOX_PREFIX'] ?? 'Inbox/';
  const keepPrefixes = new Set(
    [
      prefix, // the destination itself
      systemPrefix,
      inboxPrefix,
      'signatures/',
      'signature-templates/',
      'messages/',
      'branding/',
      'intake/',
      '_vibe_health/',
    ].filter((p) => p.length > 0),
  );

  const { db, close } = createDb({ connectionString: databaseUrl });
  try {
    // Unseal the firm key, then fold DB-held storage credentials into
    // process.env — same boot sequence the api/worker use.
    const lockState = await bootCrypto(db);
    console.log(`crypto boot: ${JSON.stringify(lockState)}`);
    await applyStorageSettingsFromDb(db);
    const storage: StorageClient = buildStorageClient(process.env);
    console.log(`storage provider: ${storage.kind}; target prefix: ${JSON.stringify(prefix)}`);

    // 1) Find top-level folders to move.
    const foldersToMove: string[] = [];
    for await (const entry of storage.list('', { delimiter: '/' })) {
      if (entry.kind !== 'prefix') continue;
      if (keepPrefixes.has(entry.key)) continue;
      foldersToMove.push(entry.key);
    }
    console.log(`top-level folders to move: ${foldersToMove.length}`);
    for (const f of foldersToMove) console.log(`  ${f}  →  ${prefix}${f}`);
    if (foldersToMove.length === 0) {
      console.log('nothing to move.');
      return;
    }

    // 2) Move objects folder by folder.
    let copied = 0;
    let skipped = 0;
    let deleted = 0;
    for (const folder of foldersToMove) {
      const keys: { key: string; sizeBytes: number }[] = [];
      for await (const entry of storage.list(folder, { recursive: true })) {
        if (entry.kind !== 'object' || !entry.meta) continue;
        keys.push({ key: entry.key, sizeBytes: entry.meta.sizeBytes });
      }
      console.log(`${folder}: ${keys.length} objects`);
      for (const obj of keys) {
        const destKey = `${prefix}${obj.key}`;
        if (!execute) {
          console.log(`  [dry-run] ${obj.key} → ${destKey}`);
          continue;
        }
        const existing = await storage.head(destKey);
        if (existing && existing.sizeBytes === obj.sizeBytes) {
          skipped += 1;
        } else {
          await storage.copy(obj.key, destKey);
          const verify = await storage.head(destKey);
          if (!verify || verify.sizeBytes !== obj.sizeBytes) {
            throw new Error(
              `verify failed for ${destKey} — aborting before any delete of ${obj.key}`,
            );
          }
          copied += 1;
        }
        await storage.delete(obj.key);
        deleted += 1;
      }
    }
    console.log(
      `objects copied: ${copied}, already-present: ${skipped}, sources deleted: ${deleted}`,
    );

    // 3) Rewrite DB paths.
    if (!execute) {
      console.log('[dry-run] skipping DB rewrites');
      return;
    }
    await db.transaction(async (tx) => {
      for (const folder of foldersToMove) {
        const newFolder = `${prefix}${folder}`;
        await tx
          .update(clientFolders)
          .set({ storagePath: newFolder, updatedAt: new Date() })
          .where(eq(clientFolders.storagePath, folder));
        await tx
          .update(files)
          .set({
            storageKey: sql`${prefix} || ${files.storageKey}`,
          })
          .where(like(files.storageKey, `${folder}%`));
        await tx
          .update(folderLinkAttempts)
          .set({ storagePath: newFolder })
          .where(
            and(
              eq(folderLinkAttempts.storagePath, folder),
              inArray(folderLinkAttempts.outcome, ['pending', 'contested']),
            ),
          );
        await tx
          .update(folderSyncEvents)
          .set({ pathAfter: newFolder })
          .where(and(eq(folderSyncEvents.pathAfter, folder), isNull(folderSyncEvents.resolvedAt)));
        await tx
          .update(folderSyncEvents)
          .set({ pathBefore: newFolder })
          .where(and(eq(folderSyncEvents.pathBefore, folder), isNull(folderSyncEvents.resolvedAt)));
      }
    });
    console.log('DB paths rewritten.');
    console.log('done. Set STORAGE_TOP_PREFIX on api + worker and restart them.');
  } finally {
    await close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
