// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Batch id→name resolution for report rows so the UI shows names rather than
// raw UUIDs. One query per kind regardless of row count.

import { inArray } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { appUsers, clients, engagements } from '@vibe/db/schema';

export type NameKind = 'partner' | 'client' | 'engagement' | 'appUser';

export async function namesByIds(
  db: Database,
  ids: ReadonlyArray<string | null | undefined>,
  kind: NameKind,
): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (list.length === 0) return new Map();
  if (kind === 'partner' || kind === 'appUser') {
    const rows = await db
      .select({ id: appUsers.id, name: appUsers.fullName })
      .from(appUsers)
      .where(inArray(appUsers.id, list));
    return new Map(rows.map((r) => [r.id, r.name]));
  }
  if (kind === 'client') {
    const rows = await db
      .select({ id: clients.id, name: clients.name })
      .from(clients)
      .where(inArray(clients.id, list));
    return new Map(rows.map((r) => [r.id, r.name]));
  }
  const rows = await db
    .select({ id: engagements.id, name: engagements.name })
    .from(engagements)
    .where(inArray(engagements.id, list));
  return new Map(rows.map((r) => [r.id, r.name]));
}
