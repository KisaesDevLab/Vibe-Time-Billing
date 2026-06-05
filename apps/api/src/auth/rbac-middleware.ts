// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// requirePermission middleware. Resolves the staff user's role
// assignments from the database, applies the role templates, and
// gates the request.

import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';

import {
  type PermissionKey,
  type RoleSlug,
  hasPermission,
  unionPermissions,
} from '@vibe/core/rbac';
import type { Database } from '@vibe/db';
import { roles, userRoles } from '@vibe/db/schema';

export interface RbacDeps {
  db: Database | null;
  // Test seam — explicit user→roles map overrides DB lookup when provided.
  fakeUserRoles?: Map<string, RoleSlug[]>;
}

export function requirePermission(deps: RbacDeps, key: PermissionKey) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const session = req.staffSession;
    if (!session) {
      res.status(401).json({ error: 'no_session' });
      return;
    }
    const userRoleSlugs = await loadRoleSlugs(deps, session.appUserId);
    const perms = unionPermissions(userRoleSlugs);
    if (!hasPermission(perms, key)) {
      res.status(403).json({ error: 'forbidden', required: key });
      return;
    }
    next();
  };
}

/**
 * Resolve whether a given staff user holds a permission. Used for
 * "self OR permission" gates (e.g. a staff member edits their own
 * booking settings; an admin edits anyone's).
 */
export async function userHasPermission(
  deps: RbacDeps,
  appUserId: string,
  key: PermissionKey,
): Promise<boolean> {
  const slugs = await loadRoleSlugs(deps, appUserId);
  return hasPermission(unionPermissions(slugs), key);
}

async function loadRoleSlugs(deps: RbacDeps, appUserId: string): Promise<RoleSlug[]> {
  if (deps.fakeUserRoles) {
    return deps.fakeUserRoles.get(appUserId) ?? [];
  }
  if (!deps.db) return [];
  const rows = await deps.db
    .select({ slug: roles.name })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(userRoles.appUserId, appUserId));
  const known: RoleSlug[] = ['partner', 'manager', 'senior', 'staff', 'admin'];
  return rows
    .map((r) => r.slug.toLowerCase() as RoleSlug)
    .filter((s): s is RoleSlug => known.includes(s));
}
