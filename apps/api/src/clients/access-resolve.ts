// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Request-free half of the 0165 restricted-client rules.
//
// Split out of ./access so code reachable from the WORKER can use it.
// access.ts types its middleware against Express's Request, which pulls in
// the `req.staffSession` augmentation the worker's tsconfig does not see —
// importing it there breaks the worker build (the same reason
// auth/rbac-resolve.ts exists apart from auth/rbac-middleware.ts).

import { and, eq, inArray } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clientAccessGrants, clients } from '@vibe/db/schema';

import { loadRoleSlugs, type RbacDeps } from '../auth/rbac-resolve';

export interface AccessDeps extends RbacDeps {
  db: Database | null;
}

async function userIsAdmin(deps: AccessDeps, appUserId: string): Promise<boolean> {
  const slugs = await loadRoleSlugs(deps, appUserId);
  return slugs.includes('admin');
}

/**
 * Client ids the user must NOT see the restricted surfaces of. Empty for
 * admins (and when the db is absent — tests/dev with no persistence).
 * Restricted clients where the user is the partner-in-charge or holds a
 * grant are excluded from the blocked set.
 */
export async function getBlockedClientIds(
  deps: AccessDeps,
  appUserId: string,
  firmId: string,
): Promise<string[]> {
  if (!deps.db) return [];

  const restricted = await deps.db
    .select({ id: clients.id, partnerInChargeId: clients.partnerInChargeId })
    .from(clients)
    .where(and(eq(clients.firmId, firmId), eq(clients.restricted, true)));
  if (restricted.length === 0) return [];

  // A missing user id (e.g. an MCP token with no creator) has no special
  // access — block every restricted client. Guarded here so the empty
  // string never reaches a uuid-typed WHERE (which would raise 22P02).
  if (!appUserId) return restricted.map((c) => c.id);
  if (await userIsAdmin(deps, appUserId)) return [];

  const grants = await deps.db
    .select({ clientId: clientAccessGrants.clientId })
    .from(clientAccessGrants)
    .where(
      and(
        eq(clientAccessGrants.appUserId, appUserId),
        inArray(
          clientAccessGrants.clientId,
          restricted.map((r) => r.id),
        ),
      ),
    );
  const granted = new Set(grants.map((g) => g.clientId));

  return restricted
    .filter((c) => c.partnerInChargeId !== appUserId && !granted.has(c.id))
    .map((c) => c.id);
}

export async function canAccessClient(
  deps: AccessDeps,
  appUserId: string,
  firmId: string,
  clientId: string,
): Promise<boolean> {
  if (!deps.db) return true;
  const [client] = await deps.db
    .select({ restricted: clients.restricted, partnerInChargeId: clients.partnerInChargeId })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.firmId, firmId)))
    .limit(1);
  // Unknown / cross-firm client: let the caller's own 404 handling deal
  // with it (this helper only decides the restriction gate).
  if (!client) return true;
  if (!client.restricted) return true;
  if (client.partnerInChargeId === appUserId) return true;
  if (await userIsAdmin(deps, appUserId)) return true;

  const [grant] = await deps.db
    .select({ id: clientAccessGrants.id })
    .from(clientAccessGrants)
    .where(
      and(eq(clientAccessGrants.clientId, clientId), eq(clientAccessGrants.appUserId, appUserId)),
    )
    .limit(1);
  return Boolean(grant);
}
