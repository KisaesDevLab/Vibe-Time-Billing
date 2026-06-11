// SPDX-License-Identifier: Elastic-2.0
//
// Inbox scan + client match for Vibe Filer. Lists the B2 Inbox/ prefix,
// parses each filename, matches it to a client (clients.external_id first,
// then ≥95% name-fuzzy via @vibe/storage's jaro-winkler), evaluates the
// active routing profile, and upserts inbox_items — preserving any
// in-progress review state on re-scan.

import { and, eq, inArray, notInArray } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  clients,
  clientFolders,
  inboxItems,
  inboxRoutingProfiles,
  inboxRoutingRules,
} from '@vibe/db/schema';
import { jaroWinkler, normalizeNameString, type StorageClient } from '@vibe/storage';
import {
  evaluateRules,
  extractIdCandidates,
  parseFilename,
  resolveYearSubfolder,
  type RoutingRule,
} from '@vibe/core/filer';

export const INBOX_PREFIX = process.env['FILER_INBOX_PREFIX'] ?? 'Inbox/';
const PLACEHOLDER = '.bzEmpty';
const FUZZY_THRESHOLD = 0.95;
const ID_MISMATCH_THRESHOLD = 0.6; // id hit but name this dissimilar → name_mismatch

export type MatchStatus =
  | 'matched'
  | 'fuzzy'
  | 'inactive'
  | 'name_mismatch'
  | 'year_needed'
  | 'folder_unbound'
  | 'unparseable';

interface ClientLite {
  id: string;
  name: string;
  externalId: string | null;
  status: string;
}

export interface MatchResult {
  parsedName: string | null;
  parsedId: string | null;
  parsedYear: number | null;
  matchStatus: MatchStatus;
  matchedClient: string | null;
  suggestedRule: string | null;
  suggestedPath: string | null;
}

/** Pure matcher — exposed for unit tests. */
export function matchObject(
  originalName: string,
  clientList: ClientLite[],
  rules: RoutingRule[],
  boundClientIds: Set<string>,
  now: Date = new Date(),
): MatchResult {
  const parsed = parseFilename(originalName, { now });
  const base: MatchResult = {
    parsedName: parsed.name,
    parsedId: parsed.id,
    parsedYear: parsed.year,
    matchStatus: 'unparseable',
    matchedClient: null,
    suggestedRule: null,
    suggestedPath: null,
  };
  // (No early unparseable return — a unique external-id hit anywhere in
  // the filename still matches even when the name segment is unusable.)

  // 1. ID hit against clients.external_id. Strict `name_ID_rest` slot
  //    first; failing that, try every id-pattern token anywhere in the
  //    filename (a hit is only taken when exactly ONE client matches —
  //    ambiguity falls through to the name path).
  let client: ClientLite | null = null;
  let status: MatchStatus = 'unparseable';
  let strictIdHit = false;
  if (parsed.id) {
    client = clientList.find((c) => c.externalId && c.externalId === parsed.id) ?? null;
    strictIdHit = client != null;
  }
  if (!client) {
    const candidates = extractIdCandidates(originalName).filter((c) => c !== parsed.id);
    const hits = new Map<string, { c: ClientLite; id: string }>();
    for (const cand of candidates) {
      const hit = clientList.find((c) => c.externalId && c.externalId === cand);
      if (hit) hits.set(hit.id, { c: hit, id: cand });
    }
    if (hits.size === 1) {
      const only = [...hits.values()][0]!;
      client = only.c;
      base.parsedId = only.id;
    }
  }
  if (client) {
    // The name-similarity gate only applies to strict-format names —
    // loose (anywhere-in-filename) hits have no reliable name segment.
    const nameSim =
      strictIdHit && parsed.name != null
        ? jaroWinkler(normalizeNameString(parsed.name), normalizeNameString(client.name))
        : 1;
    status =
      client.status !== 'ACTIVE'
        ? 'inactive'
        : nameSim < ID_MISMATCH_THRESHOLD
          ? 'name_mismatch'
          : 'matched';
  } else if (parsed.name) {
    // 2. Name fuzzy ≥ 95%.
    const target = normalizeNameString(parsed.name);
    let best: { c: ClientLite; score: number } | null = null;
    for (const c of clientList) {
      const score = jaroWinkler(target, normalizeNameString(c.name));
      if (!best || score > best.score) best = { c, score };
    }
    if (best && best.score >= FUZZY_THRESHOLD) {
      client = best.c;
      status = client.status !== 'ACTIVE' ? 'inactive' : 'fuzzy';
    }
  }

  if (!client) return base; // red — no match, manual assign

  // Folder must be bound before we can file.
  if (!boundClientIds.has(client.id)) {
    return { ...base, matchStatus: 'folder_unbound', matchedClient: client.id };
  }

  // Routing rule.
  const rule = evaluateRules(originalName, rules);
  let suggestedPath: string | null = null;
  if (rule) {
    const yearSub = resolveYearSubfolder(parsed.year, rule.yearBehavior);
    if (yearSub === null) {
      // rule needs a year but none parsed
      return {
        ...base,
        matchStatus: 'year_needed',
        matchedClient: client.id,
        suggestedRule: rule.id,
      };
    }
    suggestedPath = `${rule.targetPath}${rule.targetPath && !rule.targetPath.endsWith('/') ? '/' : ''}${yearSub}`;
  }

  return {
    ...base,
    matchStatus: status,
    matchedClient: client.id,
    suggestedRule: rule?.id ?? null,
    suggestedPath,
  };
}

export interface ScanResult {
  scanned: number;
  matched: number;
}

/** List the Inbox/ prefix and upsert inbox_items, preserving review state. */
export async function scanInbox(
  db: Database,
  storage: StorageClient,
  firmId: string,
  now: Date = new Date(),
): Promise<ScanResult> {
  // Discover objects.
  const objects: Array<{ key: string; name: string; size: number; etag: string }> = [];
  for await (const entry of storage.list(INBOX_PREFIX, { recursive: true })) {
    if (entry.kind !== 'object' || !entry.meta) continue;
    const name = entry.key.slice(entry.key.lastIndexOf('/') + 1);
    if (name === PLACEHOLDER || name.length === 0) continue;
    objects.push({ key: entry.key, name, size: entry.meta.sizeBytes, etag: entry.meta.etag });
  }

  // Reference data.
  const clientList = await db
    .select({
      id: clients.id,
      name: clients.name,
      externalId: clients.externalId,
      status: clients.status,
    })
    .from(clients)
    .where(eq(clients.firmId, firmId));
  const bound = await db
    .select({ clientId: clientFolders.clientId })
    .from(clientFolders)
    .where(eq(clientFolders.firmId, firmId));
  const boundIds = new Set(bound.map((b) => b.clientId));

  const [profile] = await db
    .select({ id: inboxRoutingProfiles.id })
    .from(inboxRoutingProfiles)
    .where(and(eq(inboxRoutingProfiles.firmId, firmId), eq(inboxRoutingProfiles.isActive, true)))
    .limit(1);
  const rules: RoutingRule[] = profile
    ? (
        await db.select().from(inboxRoutingRules).where(eq(inboxRoutingRules.profileId, profile.id))
      ).map((r) => ({
        id: r.id,
        sortOrder: r.sortOrder,
        identifier: r.identifier,
        matchMode: r.matchMode as RoutingRule['matchMode'],
        caseSensitive: r.caseSensitive,
        targetPath: r.targetPath,
        yearBehavior: r.yearBehavior as RoutingRule['yearBehavior'],
        isTaxReturn: r.isTaxReturn,
        enabled: r.enabled,
      }))
    : [];

  let matched = 0;
  const liveKeys: string[] = [];
  for (const obj of objects) {
    liveKeys.push(obj.key);
    const m = matchObject(obj.name, clientList, rules, boundIds, now);
    if (m.matchStatus === 'matched' || m.matchStatus === 'fuzzy') matched += 1;
    await db
      .insert(inboxItems)
      .values({
        firmId,
        objectKey: obj.key,
        originalName: obj.name,
        sizeBytes: obj.size,
        etag: obj.etag,
        parsedName: m.parsedName,
        parsedId: m.parsedId,
        parsedYear: m.parsedYear,
        matchStatus: m.matchStatus,
        matchedClient: m.matchedClient,
        suggestedRule: m.suggestedRule,
        suggestedPath: m.suggestedPath,
      })
      .onConflictDoUpdate({
        target: [inboxItems.firmId, inboxItems.objectKey],
        // Recompute parse/match on every scan; never clobber review state.
        set: {
          originalName: obj.name,
          sizeBytes: obj.size,
          etag: obj.etag,
          parsedName: m.parsedName,
          parsedId: m.parsedId,
          parsedYear: m.parsedYear,
          matchStatus: m.matchStatus,
          matchedClient: m.matchedClient,
          suggestedRule: m.suggestedRule,
          suggestedPath: m.suggestedPath,
          updatedAt: now,
        },
      });
  }

  // Drop rows whose object is gone from the inbox.
  if (liveKeys.length > 0) {
    await db
      .delete(inboxItems)
      .where(and(eq(inboxItems.firmId, firmId), notInArray(inboxItems.objectKey, liveKeys)));
  } else {
    await db.delete(inboxItems).where(eq(inboxItems.firmId, firmId));
  }

  return { scanned: objects.length, matched };
}

// Re-export for callers that filter selected items.
export { inArray };
