// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Firm + restricted-client scoping shared by the token-authenticated
// surfaces (MCP server and REST v1). Both surfaces authorize with the same
// mcp_token claims, so they must apply identical guards: every read/write
// is bounded to the token's firm, and engagements of clients the token's
// creator can't access (0165) are invisible.

import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clients, engagements } from '@vibe/db/schema';

import { getBlockedClientIds } from '../clients/access';

/** Restricted-client ids (0165) for a token. A null creator has no special
 *  access, so every restricted client is blocked. */
export async function tokenBlockedClientIds(
  db: Database,
  token: { firmId: string; createdById: string | null },
): Promise<Set<string>> {
  return new Set(await getBlockedClientIds({ db }, token.createdById ?? '', token.firmId));
}

/** All engagement ids of the token's firm, minus blocked clients'. */
export async function firmEngagementIdSet(
  db: Database,
  firmId: string,
  blocked: ReadonlySet<string>,
): Promise<string[]> {
  const rows = await db
    .select({ id: engagements.id, clientId: engagements.clientId })
    .from(engagements)
    .innerJoin(clients, eq(clients.id, engagements.clientId))
    .where(eq(clients.firmId, firmId));
  return rows.filter((r) => !blocked.has(r.clientId)).map((r) => r.id);
}

export interface TokenEngagement {
  id: string;
  clientId: string;
  mixedModeEnabled: boolean;
  inScopeWorkCodeIds: string[];
  firmAdmin: boolean;
}

/** Single-row engagement lookup for write paths: null when the engagement
 *  doesn't exist, belongs to another firm, or its client is blocked. Also
 *  carries the fields entry creation needs for write-time flags. */
export async function findFirmEngagement(
  db: Database,
  firmId: string,
  blocked: ReadonlySet<string>,
  engagementId: string,
): Promise<TokenEngagement | null> {
  const [row] = await db
    .select({
      id: engagements.id,
      clientId: engagements.clientId,
      mixedModeEnabled: engagements.mixedModeEnabled,
      inScopeWorkCodeIds: engagements.inScopeWorkCodeIds,
      firmAdmin: engagements.firmAdmin,
    })
    .from(engagements)
    .innerJoin(clients, eq(clients.id, engagements.clientId))
    .where(and(eq(engagements.id, engagementId), eq(clients.firmId, firmId)))
    .limit(1);
  if (!row || blocked.has(row.clientId)) return null;
  return row;
}

/** Write-time entry flags, mirroring staff creation: Q20 in-scope tagging
 *  from the engagement's array, and 0208 firm-admin time never billable. */
export function tokenEntryFlags(
  eng: TokenEngagement,
  workCodeId: string | undefined,
): { inScopeFlag: boolean; billableFlag: boolean } {
  const inScopeFlag =
    eng.mixedModeEnabled && workCodeId ? eng.inScopeWorkCodeIds.includes(workCodeId) : true;
  return { inScopeFlag, billableFlag: !eng.firmAdmin };
}
