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

import { canAccessClient, getBlockedClientIds, type AccessDeps } from './access-resolve';

export { canAccessClient, getBlockedClientIds, type AccessDeps } from './access-resolve';

/** Cache key on the request so a single request resolves the blocked set once. */
const BLOCKED_CACHE = Symbol('vibeBlockedClientIds');

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
