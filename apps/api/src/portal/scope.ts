// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CP7 — Portal scope resolution for the §2.13 "view all entities"
// feature.
//
// resolveScope reads the optional ?scope=all_accessible query param
// and returns the set of client ids the request applies to:
//   • default              → [session.activeClientId]
//   • scope=all_accessible → every client the identity has an ACTIVE
//                            clientPortalAccess row for
//
// Callers feed the resulting array into their WHERE clauses via
// inArray() (or sql.inArray for raw queries).

import { and, eq } from 'drizzle-orm';
import type { Request } from 'express';

import type { Database } from '@vibe/db';
import { clientPortalAccess } from '@vibe/db/schema';

import type { PortalSession } from '@vibe/core/auth';

export interface ResolvedScope {
  clientIds: string[];
  /** True when the caller asked for all_accessible AND has >1 client. */
  isConsolidated: boolean;
}

export async function resolveScope(
  db: Database,
  session: PortalSession,
  req: Request,
): Promise<ResolvedScope> {
  const requested = String(req.query['scope'] ?? '').toLowerCase();
  if (requested !== 'all_accessible') {
    return { clientIds: [session.activeClientId], isConsolidated: false };
  }
  const rows = await db
    .select({ clientId: clientPortalAccess.clientId })
    .from(clientPortalAccess)
    .where(
      and(
        eq(clientPortalAccess.portalIdentityId, session.portalIdentityId),
        eq(clientPortalAccess.status, 'ACTIVE'),
      ),
    );
  const ids = rows.map((r) => r.clientId);
  // Defensive: always include the active client even if the access row
  // is mid-transition. Dedup at the end.
  if (!ids.includes(session.activeClientId)) ids.push(session.activeClientId);
  return {
    clientIds: ids,
    isConsolidated: ids.length > 1,
  };
}
