// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Inbox scan + client match for Vibe Filer. Lists the B2 Inbox/ prefix,
// parses each filename, matches it to a client (clients.external_id first,
// then ≥95% name-fuzzy via @vibe/storage's jaro-winkler), evaluates the
// active routing profile, and upserts inbox_items — preserving any
// in-progress review state on re-scan.

import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';

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
  DEFAULT_K1_TARGET_PATH,
  DEFAULT_K1_YEAR_BEHAVIOR,
  clientNameVariants,
  detectYearAnywhere,
  evaluateRules,
  joinTargetPath,
  parseFilename,
  parseK1Recipient,
  resolveYearSubfolder,
  type K1Recipient,
  type K1RouteConfig,
  type RoutingRule,
} from '@vibe/core/filer';

export const INBOX_PREFIX = process.env['FILER_INBOX_PREFIX'] ?? 'Inbox/';
// 0153 — temp home for uploaded zip imports awaiting extraction. Lives
// under Inbox/ (already excluded from storage-sync) but is hidden from
// the document-inbox scan below.
export const ZIP_IMPORT_PREFIX = `${INBOX_PREFIX}_imports/`;
const PLACEHOLDER = '.bzEmpty';
const FUZZY_THRESHOLD = 0.95;
const ID_MISMATCH_THRESHOLD = 0.6; // id hit but name this dissimilar → name_mismatch
// K-1 recipient suggestions are ALWAYS verified by staff before filing,
// so a looser threshold than the primary 0.95 is safe — a decent guess
// beats no suggestion.
const K1_FUZZY_SUGGEST_THRESHOLD = 0.85;

export type MatchStatus =
  | 'matched'
  | 'fuzzy'
  | 'inactive'
  | 'name_mismatch'
  | 'year_needed'
  | 'folder_unbound'
  | 'unparseable';

export interface ClientLite {
  id: string;
  name: string;
  externalId: string | null;
  // 0152 — second identifier ("AWS Id"); the matcher accepts either.
  // Optional so pure-matcher callers/tests without one stay terse.
  awsId?: string | null;
  status: string;
}

/** The client's identifiers usable for filename matching, trimmed. */
function clientIds(c: ClientLite): string[] {
  const out: string[] = [];
  for (const id of [c.externalId, c.awsId]) {
    const t = id?.trim();
    if (t) out.push(t);
  }
  return out;
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 0153 — zip-import client match. Export pipelines often concatenate the
 * client id straight onto a timestamp (…084954GAMB1540.zip), so the
 * boundary-guarded `idAppearsIn` can't see it. Plain case-insensitive
 * substring containment instead, taken only on a UNIQUE client hit —
 * the import UI always shows the match for confirmation/override.
 */
export function matchClientByIdSubstring(
  name: string,
  clientList: ClientLite[],
): { clientId: string; id: string } | null {
  const lower = name.toLowerCase();
  const hits = new Map<string, { clientId: string; id: string }>();
  for (const c of clientList) {
    for (const id of clientIds(c)) {
      if (id.length < 4) continue;
      if (lower.includes(id.toLowerCase())) {
        hits.set(c.id, { clientId: c.id, id });
        break;
      }
    }
  }
  if (hits.size === 1) return [...hits.values()][0]!;
  return null;
}

/** True when `id` appears in `filename` bounded by non-alphanumerics. */
export function idAppearsIn(filename: string, id: string): boolean {
  const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(id)}(?![A-Za-z0-9])`, 'i');
  return re.test(filename);
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

  // 1. ID hit against clients.external_id OR clients.aws_id (0152 —
  //    some export pipelines stamp filenames with the AWS Id instead).
  //    Strict `name_ID_rest` slot first; failing that, try every
  //    id-pattern token anywhere in the filename (a hit is only taken
  //    when exactly ONE client matches — ambiguity falls through to the
  //    name path).
  let client: ClientLite | null = null;
  let status: MatchStatus = 'unparseable';
  let strictIdHit = false;
  if (parsed.id) {
    client = clientList.find((c) => clientIds(c).includes(parsed.id!)) ?? null;
    strictIdHit = client != null;
  }
  if (!client) {
    // Client-driven scan: look for each client's actual ids (external
    // or AWS) anywhere in the filename. Handles alphanumeric ids
    // (ALLE1234) that the digit-run pattern can't see. Boundary-guarded
    // so an id can't match inside a longer token, min length 4 to avoid
    // noise, case-insensitive. Taken only on a unique client hit.
    const hits = new Map<string, { c: ClientLite; id: string }>();
    for (const c of clientList) {
      for (const id of clientIds(c)) {
        if (id.length < 4) continue;
        if (idAppearsIn(originalName, id)) {
          hits.set(c.id, { c, id });
          break;
        }
      }
    }
    if (hits.size === 1) {
      const only = [...hits.values()][0]!;
      client = only.c;
      base.parsedId = only.id;
      // The strict parse may have consumed a year-like number as the
      // (wrong) id; recover the year from the full filename.
      if (base.parsedYear == null) base.parsedYear = detectYearAnywhere(originalName, { now });
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
    const best = bestFuzzy(normalizeNameString(parsed.name), clientList, (c) => [
      normalizeNameString(c.name),
    ]);
    if (best && best.score >= FUZZY_THRESHOLD) {
      client = best.item;
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
    const yearSub = resolveYearSubfolder(base.parsedYear, rule.yearBehavior);
    if (yearSub === null) {
      // rule needs a year but none parsed
      return {
        ...base,
        matchStatus: 'year_needed',
        matchedClient: client.id,
        suggestedRule: rule.id,
      };
    }
    suggestedPath = joinTargetPath(rule.targetPath, yearSub);
  }

  return {
    ...base,
    matchStatus: status,
    matchedClient: client.id,
    suggestedRule: rule?.id ?? null,
    suggestedPath,
  };
}

export interface K1MatchResult {
  matchedClient: string | null;
  score: number | null;
}

export interface K1Candidate {
  id: string;
  /** clientNameVariants(name), pre-normalized — computed once per scan. */
  normalizedVariants: string[];
}

/**
 * 0229 — the clients a K-1 recipient suggestion may point at: ACTIVE and
 * folder-bound only, the same gates the primary matcher applies before a
 * client is fileable (review finding — an unbound suggestion would fail
 * at commit time). Variant expansion + normalization happen here, once
 * per scan, instead of per object x per client.
 */
export function k1Candidates(clientList: ClientLite[], boundClientIds: Set<string>): K1Candidate[] {
  return clientList
    .filter((c) => c.status === 'ACTIVE' && boundClientIds.has(c.id))
    .map((c) => ({
      id: c.id,
      normalizedVariants: clientNameVariants(c.name).map((v) => normalizeNameString(v)),
    }));
}

/** Best jaro-winkler score over candidate name lists — the ONE fuzzy loop
 *  both the primary name match and the K-1 recipient match run through. */
function bestFuzzy<T>(
  normalizedTarget: string,
  items: readonly T[],
  namesOf: (item: T) => readonly string[],
): { item: T; score: number } | null {
  let best: { item: T; score: number } | null = null;
  for (const item of items) {
    for (const name of namesOf(item)) {
      const score = jaroWinkler(normalizedTarget, name);
      if (!best || score > best.score) best = { item, score };
    }
  }
  return best;
}

/**
 * 0229 — K-1 recipient suggestion, name-only. The filename gives the
 * recipient as `First Last` while client records are mostly stored
 * `Last, First [& Spouse]`, so each candidate carries pre-normalized
 * variants (one per spouse) and the best variant score wins. The
 * primary-matched entity is always excluded — a recipient copy never
 * files back into the entity's own folder. Pure; exposed for tests.
 */
export function matchK1Recipient(
  rec: K1Recipient,
  candidates: K1Candidate[],
  primaryClientId: string | null,
): K1MatchResult {
  const best = bestFuzzy(
    normalizeNameString(rec.recipientName),
    candidates.filter((c) => c.id !== primaryClientId),
    (c) => c.normalizedVariants,
  );
  if (best && best.score >= K1_FUZZY_SUGGEST_THRESHOLD) {
    return { matchedClient: best.item.id, score: best.score };
  }
  return { matchedClient: null, score: null };
}

export interface ScanResult {
  scanned: number;
  matched: number;
}

/** List the Inbox/ prefix and upsert inbox_items, preserving review state. */
/** The active routing profile's rules, mapped to the core shape. */
export async function loadActiveRules(db: Database, firmId: string): Promise<RoutingRule[]> {
  const [profile] = await db
    .select({ id: inboxRoutingProfiles.id })
    .from(inboxRoutingProfiles)
    .where(and(eq(inboxRoutingProfiles.firmId, firmId), eq(inboxRoutingProfiles.isActive, true)))
    .limit(1);
  if (!profile) return [];
  const rows = await db
    .select()
    .from(inboxRoutingRules)
    .where(eq(inboxRoutingRules.profileId, profile.id));
  return rows.map((r) => ({
    id: r.id,
    sortOrder: r.sortOrder,
    identifier: r.identifier,
    matchMode: r.matchMode as RoutingRule['matchMode'],
    caseSensitive: r.caseSensitive,
    targetPath: r.targetPath,
    yearBehavior: r.yearBehavior as RoutingRule['yearBehavior'],
    isTaxReturn: r.isTaxReturn,
    enabled: r.enabled,
  }));
}

/**
 * 0229 — destination config for K-1 recipient copies, from the active
 * routing profile. Defaults apply when no profile is active. The shape
 * lives in @vibe/core/filer (K1RouteConfig) so the loader, the commit
 * payload, and the route worker cannot drift.
 */
export async function loadK1Config(db: Database, firmId: string): Promise<K1RouteConfig> {
  const [profile] = await db
    .select({
      k1TargetPath: inboxRoutingProfiles.k1TargetPath,
      k1YearBehavior: inboxRoutingProfiles.k1YearBehavior,
    })
    .from(inboxRoutingProfiles)
    .where(and(eq(inboxRoutingProfiles.firmId, firmId), eq(inboxRoutingProfiles.isActive, true)))
    .limit(1);
  if (!profile)
    return { targetPath: DEFAULT_K1_TARGET_PATH, yearBehavior: DEFAULT_K1_YEAR_BEHAVIOR };
  return {
    targetPath: profile.k1TargetPath,
    // reason: the text column is constrained to the YearBehavior values by
    // the DB CHECK (0229), invisible to the type system here.
    yearBehavior: profile.k1YearBehavior as RoutingRule['yearBehavior'],
  };
}

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
    if (entry.key.startsWith(ZIP_IMPORT_PREFIX)) continue; // 0153 — pending zip imports
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
      awsId: clients.awsId,
      status: clients.status,
    })
    .from(clients)
    .where(eq(clients.firmId, firmId));
  const bound = await db
    .select({ clientId: clientFolders.clientId })
    .from(clientFolders)
    .where(eq(clientFolders.firmId, firmId));
  const boundIds = new Set(bound.map((b) => b.clientId));

  const rules = await loadActiveRules(db, firmId);

  // 0229 — a staff-confirmed/dismissed K-1 decision survives re-scan.
  // The decision lives ENTIRELY in the upsert's SQL CASE, evaluated
  // against the row's LIVE state — no prefetched snapshot to go stale
  // (a Dismiss→Restore racing the scan used to null the suggestion
  // because the snapshot and the CASE disagreed — review finding).
  // A CONFIRMED recipient that the re-matched primary would alias is
  // NOT kept: that state is invalid (the worker refuses it), so the row
  // falls back to a fresh suggestion, which excludes the entity.
  const candidates = k1Candidates(clientList, boundIds);

  let matched = 0;
  const liveKeys: string[] = [];
  for (const obj of objects) {
    liveKeys.push(obj.key);
    const m = matchObject(obj.name, clientList, rules, boundIds, now);
    if (m.matchStatus === 'matched' || m.matchStatus === 'fuzzy') matched += 1;
    const k1 = parseK1Recipient(obj.name);
    const k1m = k1 ? matchK1Recipient(k1, candidates, m.matchedClient) : null;
    const k1Keep = sql`(
      ${inboxItems.k1Status} = 'dismissed'
      OR (${inboxItems.k1Status} = 'confirmed'
          AND ${inboxItems.k1MatchedClient} IS DISTINCT FROM ${m.matchedClient}::uuid)
    )`;
    const k1Fields = {
      k1RecipientName: k1?.recipientName ?? null,
      k1MatchedClient: k1m?.matchedClient ?? null,
      k1MatchScore: k1m?.score ?? null,
      k1Status: k1 ? ('suggested' as const) : null,
    };
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
        ...k1Fields,
      })
      .onConflictDoUpdate({
        target: [inboxItems.firmId, inboxItems.objectKey],
        // Recompute parse/match on every scan; never clobber review state.
        // K-1 suggestion columns refresh only while the LIVE row is still
        // undecided — the CASE reads the target row, not a snapshot.
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
          k1RecipientName: sql`CASE WHEN ${k1Keep} THEN ${inboxItems.k1RecipientName} ELSE ${k1Fields.k1RecipientName} END`,
          k1MatchedClient: sql`CASE WHEN ${k1Keep} THEN ${inboxItems.k1MatchedClient} ELSE ${k1Fields.k1MatchedClient}::uuid END`,
          k1MatchScore: sql`CASE WHEN ${k1Keep} THEN ${inboxItems.k1MatchScore} ELSE ${k1Fields.k1MatchScore}::real END`,
          k1Status: sql`CASE WHEN ${k1Keep} THEN ${inboxItems.k1Status} ELSE ${k1Fields.k1Status} END`,
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
