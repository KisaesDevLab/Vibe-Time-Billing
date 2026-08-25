// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Collision predicate for client-folder storage keys.
//
// `files_firm_storage_key_uk` (0046) is NOT partial: a soft-deleted row
// (an undone route, a deleted file) keeps its storage_key and still owns
// it in the index. Checking only `storage.head()` therefore hands back a
// key the INSERT will reject — the caller crashes on the unique index
// instead of renaming past it. Every resolveCollision caller that inserts
// a `files` row must use this predicate.

import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { files } from '@vibe/db/schema';
import type { StorageClient } from '@vibe/storage';

export function storageKeyTaken(
  db: Database,
  storage: StorageClient,
  firmId: string,
): (key: string) => Promise<boolean> {
  return async (key: string): Promise<boolean> => {
    if ((await storage.head(key)) !== null) return true;
    const rows = await db
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.firmId, firmId), eq(files.storageKey, key)))
      .limit(1);
    return rows.length > 0;
  };
}
