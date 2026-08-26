// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Shared id → display-name resolution for the activity / audit / log
// surfaces. Those screens store a bare uuid (the actor who did the thing,
// the row it was done to) and several of them rendered it raw, so an
// operator reading their own trail saw
// "22a151d1-67a2-4af9-8b9a-e44aa690c0ab" instead of a staff name.
//
// Every helper here is batched: one query per entity kind regardless of how
// many rows are on the page. Unknown kinds and hard-deleted rows resolve to
// null — callers fall back to the short-id stub so the trail is never
// silently blank.

import { eq, inArray, sql } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';

import type { Database } from '@vibe/db';
import { UUID_RE } from './uuid-guard';
import {
  appUsers,
  appointments,
  clientContacts,
  clientFolders,
  clientRequests,
  clients,
  engagementLetterTemplates,
  engagementTemplates,
  engagementTypes,
  engagements,
  files,
  invoices,
  mcpTokens,
  milestones,
  offices,
  packages,
  persons,
  portalIdentity,
  proposals,
  requestTemplates,
  retainers,
  roles,
  serviceLines,
  servicesCatalog,
  signatureRequests,
  staffRateSnapshots,
  taxReturns,
  termsTemplates,
  threads,
  timeEntries,
  timeTimers,
  workCodes,
} from '@vibe/db/schema';

/** `${entityType}:${entityId}` → display name (absent when unresolvable). */
export type NameMap = Map<string, string>;

export interface EntityRef {
  entityType: string;
  entityId: string | null;
}

export interface ActorRefLike {
  actorAppUserId?: string | null;
  actorMcpTokenId?: string | null;
  actorPortalIdentityId?: string | null;
}

// Audit rows write the entity type as `thing` or `thing.subthing`
// ("service.tags", "signature_request.sent"). The id always belongs to the
// base kind, so resolve against that.
function baseType(entityType: string): string {
  const dot = entityType.indexOf('.');
  return dot === -1 ? entityType : entityType.slice(0, dot);
}

/** Map key for one resolved entity. */
export function entityKey(entityType: string, entityId: string): string {
  return `${baseType(entityType)}:${entityId}`;
}

type IdName = { id: string; name: string | null };

interface Source {
  /** Audit `entity_type` values that resolve through this source. */
  types: string[];
  select: (db: Database, ids: string[]) => Promise<IdName[]>;
}

/** Most kinds are a plain "id column + one label column" lookup. */
function simple(types: string[], table: PgTable, idCol: AnyPgColumn, nameCol: AnyPgColumn): Source {
  return {
    types,
    select: (db, ids) =>
      db
        .select({ id: idCol, name: nameCol })
        .from(table)
        .where(inArray(idCol, ids)) as unknown as Promise<IdName[]>,
  };
}

const SOURCES: Source[] = [
  // `app_user_roles` records the grant against the user it was granted to.
  simple(['app_user', 'staff_user', 'app_user_roles'], appUsers, appUsers.id, appUsers.fullName),
  simple(['client'], clients, clients.id, clients.name),
  simple(['engagement'], engagements, engagements.id, engagements.name),
  simple(['invoice'], invoices, invoices.id, invoices.invoiceNumber),
  simple(['appointment'], appointments, appointments.id, appointments.title),
  simple(['work_code'], workCodes, workCodes.id, workCodes.name),
  simple(['person'], persons, persons.id, persons.fullName),
  simple(['client_contact'], clientContacts, clientContacts.id, clientContacts.fullName),
  simple(['portal_identity'], portalIdentity, portalIdentity.id, portalIdentity.fullName),
  simple(['service'], servicesCatalog, servicesCatalog.id, servicesCatalog.name),
  simple(['service_line'], serviceLines, serviceLines.id, serviceLines.name),
  simple(['package'], packages, packages.id, packages.name),
  simple(['terms_template'], termsTemplates, termsTemplates.id, termsTemplates.name),
  simple(
    ['engagement_template'],
    engagementTemplates,
    engagementTemplates.id,
    engagementTemplates.name,
  ),
  simple(
    ['engagement_letter_template'],
    engagementLetterTemplates,
    engagementLetterTemplates.id,
    engagementLetterTemplates.name,
  ),
  simple(['engagement_type'], engagementTypes, engagementTypes.id, engagementTypes.name),
  simple(['office'], offices, offices.id, offices.name),
  simple(['role'], roles, roles.id, roles.name),
  simple(['signature_request'], signatureRequests, signatureRequests.id, signatureRequests.title),
  simple(['proposal'], proposals, proposals.id, proposals.title),
  simple(['tax_return'], taxReturns, taxReturns.id, taxReturns.title),
  simple(['client_request'], clientRequests, clientRequests.id, clientRequests.title),
  simple(['request_template'], requestTemplates, requestTemplates.id, requestTemplates.name),
  simple(['milestone'], milestones, milestones.id, milestones.name),
  simple(['retainer'], retainers, retainers.id, retainers.name),
  simple(['file'], files, files.id, files.originalFilename),
  simple(['client_folder'], clientFolders, clientFolders.id, clientFolders.storagePath),
  simple(['thread', 'internal_thread'], threads, threads.id, threads.title),
  simple(['mcp_token'], mcpTokens, mcpTokens.id, mcpTokens.name),

  // Composite labels — a bare id tells an operator nothing, so build the
  // sentence they'd otherwise have to look up by hand.
  {
    // "Client · 2026-07-12 · 1.50h". Archived entries still resolve (soft
    // delete); hard-deleted ones fall back to the short-id stub.
    types: ['time_entry'],
    select: (db, ids) =>
      db
        .select({
          id: timeEntries.id,
          name: sql<string>`${clients.name} || ' · ' || ${timeEntries.entryDate}::text || ' · ' || ${timeEntries.hours}::text || 'h'`,
        })
        .from(timeEntries)
        .innerJoin(engagements, eq(engagements.id, timeEntries.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(inArray(timeEntries.id, ids)),
  },
  {
    // Timers are deleted on save/discard, so most historical timer events
    // won't resolve — live ones show their classification.
    types: ['time_timer'],
    select: (db, ids) =>
      db
        .select({
          id: timeTimers.id,
          name: sql<string>`'Timer — ' || COALESCE(NULLIF(${timeTimers.description}, ''), ${clients.name}, 'unclassified')`,
        })
        .from(timeTimers)
        .leftJoin(clients, eq(clients.id, timeTimers.clientId))
        .where(inArray(timeTimers.id, ids)),
  },
  {
    // Rate snapshots are per-staff-per-date; name the staff member.
    types: ['staff_rate_snapshot'],
    select: (db, ids) =>
      db
        .select({
          id: staffRateSnapshots.id,
          name: sql<string>`${appUsers.fullName} || ' · ' || ${staffRateSnapshots.effectiveDate}::text`,
        })
        .from(staffRateSnapshots)
        .innerJoin(appUsers, eq(appUsers.id, staffRateSnapshots.appUserId))
        .where(inArray(staffRateSnapshots.id, ids)),
  },
];

const SOURCE_BY_TYPE = new Map<string, Source>();
for (const s of SOURCES) for (const t of s.types) SOURCE_BY_TYPE.set(t, s);

/** True when this entity type has a display name we can look up. */
export function isResolvableEntityType(entityType: string): boolean {
  return SOURCE_BY_TYPE.has(baseType(entityType));
}

/**
 * Batch-resolve `{entityType, entityId}` refs to display names, keyed by
 * `entityKey(type, id)`. One query per distinct entity kind present.
 */
export async function resolveEntityNames(
  db: Database,
  refs: Iterable<EntityRef>,
): Promise<NameMap> {
  const wanted = new Map<Source, Set<string>>();
  for (const r of refs) {
    if (!r.entityId || !UUID_RE.test(r.entityId)) continue;
    const source = SOURCE_BY_TYPE.get(baseType(r.entityType));
    if (!source) continue;
    let set = wanted.get(source);
    if (!set) {
      set = new Set();
      wanted.set(source, set);
    }
    set.add(r.entityId);
  }
  const out: NameMap = new Map();
  await Promise.all(
    [...wanted].map(async ([source, ids]) => {
      const rows = await source.select(db, [...ids]);
      for (const row of rows) {
        if (row.name == null || row.name === '') continue;
        // One source can back several entity types — key it under each so
        // callers can look up by whichever type their row carries.
        for (const type of source.types) out.set(`${type}:${row.id}`, row.name);
      }
    }),
  );
  return out;
}

/**
 * Batch-resolve staff display names for a set of app_user ids. Returns a
 * plain id → name map; ids with no matching user are absent.
 */
export async function resolveAppUserNames(
  db: Database,
  ids: Iterable<string | null | undefined>,
): Promise<Map<string, string>> {
  // Callers pass raw actor strings ("system", "signer:<id>", a uuid); the
  // id columns are uuid-typed, so a non-uuid would make Postgres throw 22P02.
  const wanted = [...new Set([...ids].filter((v): v is string => !!v && UUID_RE.test(v)))];
  if (wanted.length === 0) return new Map();
  const rows = await db
    .select({ id: appUsers.id, name: appUsers.fullName })
    .from(appUsers)
    .where(inArray(appUsers.id, wanted));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Batch-resolve portal-identity display names. */
export async function resolvePortalIdentityNames(
  db: Database,
  ids: Iterable<string | null | undefined>,
): Promise<Map<string, string>> {
  const wanted = [...new Set([...ids].filter((v): v is string => !!v && UUID_RE.test(v)))];
  if (wanted.length === 0) return new Map();
  const rows = await db
    .select({ id: portalIdentity.id, name: portalIdentity.fullName })
    .from(portalIdentity)
    .where(inArray(portalIdentity.id, wanted));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * Attach `actorName` + `entityName` to audit-log-shaped rows. Actors are a
 * staff user, an MCP token, or a portal identity; entities resolve through
 * the source table above.
 */
export async function enrichWithNames<T extends ActorRefLike & EntityRef>(
  db: Database,
  rows: T[],
): Promise<Array<T & { actorName: string | null; entityName: string | null }>> {
  const [users, identities, entityNames] = await Promise.all([
    resolveAppUserNames(
      db,
      rows.map((r) => r.actorAppUserId),
    ),
    resolvePortalIdentityNames(
      db,
      rows.map((r) => r.actorPortalIdentityId),
    ),
    resolveEntityNames(db, rows),
  ]);
  const tokenIds = [
    ...new Set(
      rows.map((r) => r.actorMcpTokenId).filter((v): v is string => !!v && UUID_RE.test(v)),
    ),
  ];
  const tokens = tokenIds.length
    ? new Map(
        (
          await db
            .select({ id: mcpTokens.id, name: mcpTokens.name })
            .from(mcpTokens)
            .where(inArray(mcpTokens.id, tokenIds))
        ).map((r) => [r.id, r.name]),
      )
    : new Map<string, string>();

  return rows.map((r) => {
    let actorName: string | null = null;
    if (r.actorAppUserId) actorName = users.get(r.actorAppUserId) ?? null;
    else if (r.actorMcpTokenId) actorName = `MCP token: ${tokens.get(r.actorMcpTokenId) ?? '?'}`;
    else if (r.actorPortalIdentityId) {
      const who = identities.get(r.actorPortalIdentityId);
      actorName = who ? `${who} (portal)` : 'Portal user';
    }
    const entityName = r.entityId
      ? (entityNames.get(entityKey(r.entityType, r.entityId)) ?? null)
      : null;
    return { ...r, actorName, entityName };
  });
}
