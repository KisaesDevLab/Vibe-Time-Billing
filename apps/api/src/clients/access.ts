// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0165 — per-client visibility restriction access resolution. Single
// source of truth reused by the clients router (per-client section guard),
// every cross-client list/board, and the MCP dispatcher, so UI gating and
// server enforcement can never disagree.
//
// A staff user has FULL access to a restricted client iff they are an
// admin, the client's partner-in-charge, or hold a client_access_grant
// row. Non-restricted clients are always fully accessible. Basic data
// (client info, people/contacts, billing/A-R) is NOT gated here — callers
// only consult this for the "everything else" surfaces.

import type { Request, Response, NextFunction } from 'express';
import { and, eq, inArray } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clientAccessGrants, clients } from '@vibe/db/schema';

import { loadRoleSlugs, type RbacDeps } from '../auth/rbac-middleware';

export interface AccessDeps extends RbacDeps {
  db: Database | null;
}

/** Cache key on the request so a single request resolves the blocked set once. */
const BLOCKED_CACHE = Symbol('vibeBlockedClientIds');

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

/** Memoized per-request variant — safe to call from multiple handlers. */
export async function getBlockedClientIdsCached(
  deps: AccessDeps,
  req: Request,
  appUserId: string,
  firmId: string,
): Promise<string[]> {
  const bag = req as unknown as Record<symbol, Promise<string[]> | undefined>;
  if (!bag[BLOCKED_CACHE]) {
    bag[BLOCKED_CACHE] = getBlockedClientIds(deps, appUserId, firmId);
  }
  return bag[BLOCKED_CACHE]!;
}

/**
 * Whether the user may see the restricted surfaces of a single client.
 * True when the client isn't restricted, or the user is admin /
 * partner-in-charge / granted.
 */
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

/**
 * Express helper: 403 if the session user can't access the given client's
 * restricted surfaces. Returns true when the response has been sent so the
 * caller can `return`.
 */
export async function blockIfClientRestricted(
  deps: AccessDeps,
  req: Request,
  res: Response,
  clientId: string,
): Promise<boolean> {
  const session = req.staffSession;
  if (!session) {
    res.status(401).json({ error: 'no_session' });
    return true;
  }
  const ok = await canAccessClient(deps, session.appUserId, session.firmId, clientId);
  if (!ok) {
    res.status(403).json({ error: 'client_restricted' });
    return true;
  }
  return false;
}

/** RESTRICTED sections under /clients/:id/<section> the Layer-1 guard gates. */
const RESTRICTED_SECTIONS = new Set([
  'notes',
  'tasks',
  'files',
  'folder',
  'communications',
  'credentials',
]);

/**
 * Layer-1 middleware mounted at `/:id/:section` on the clients router. Only
 * the RESTRICTED sections are gated; basic sections (contacts, people,
 * tax-id, pin) and the client detail GET pass straight through.
 */
export function requireFullClientAccessForSection(deps: AccessDeps) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const section = req.params['section'];
    if (!section || !RESTRICTED_SECTIONS.has(section)) {
      next();
      return;
    }
    const clientId = req.params['id'];
    if (!clientId) {
      next();
      return;
    }
    if (await blockIfClientRestricted(deps, req, res, clientId)) return;
    next();
  };
}
