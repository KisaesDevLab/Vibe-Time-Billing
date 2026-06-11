// SPDX-License-Identifier: Elastic-2.0
//
// requirePermission middleware. Resolves the staff user's role
// assignments from the database, applies the role templates plus the
// firm's permission-matrix overrides (0147), and gates the request.

import type { NextFunction, Request, Response } from 'express';
import { and, eq, inArray } from 'drizzle-orm';

import {
  type PermissionKey,
  type PermissionOverride,
  type RoleSlug,
  hasPermission,
  unionPermissionsWithOverrides,
} from '@vibe/core/rbac';
import type { Database } from '@vibe/db';
import { appUsers, rolePermissionOverrides, roles, userRoles } from '@vibe/db/schema';

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
    const perms = await resolveUserPermissions(deps, session.appUserId, session.firmId);
    if (!hasPermission(perms, key)) {
      res.status(403).json({ error: 'forbidden', required: key });
      return;
    }
    next();
  };
}

/**
 * 0147 — the single source of truth for a staff user's effective
 * permission set: role templates ± the firm's matrix overrides. Every
 * caller (this middleware, /me, files/visibility) must go through it
 * so UI gating and enforcement can never disagree.
 */
export async function resolveUserPermissions(
  deps: RbacDeps,
  appUserId: string,
  firmId?: string | null,
): Promise<Set<PermissionKey>> {
  const slugs = await loadRoleSlugs(deps, appUserId);
  const effectiveFirmId = firmId ?? (await loadFirmId(deps, appUserId));
  const overrides = await loadOverrides(deps, effectiveFirmId, slugs);
  return unionPermissionsWithOverrides(slugs, overrides);
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
  return hasPermission(await resolveUserPermissions(deps, appUserId), key);
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

async function loadFirmId(deps: RbacDeps, appUserId: string): Promise<string | null> {
  if (!deps.db) return null;
  const [row] = await deps.db
    .select({ firmId: appUsers.firmId })
    .from(appUsers)
    .where(eq(appUsers.id, appUserId))
    .limit(1);
  return row?.firmId ?? null;
}

/**
 * 0147 — the firm's permission-matrix deltas for the user's roles.
 * Admin never has overrides (write endpoint rejects them; the merge
 * ignores them too), so an admin-only user skips the query entirely.
 */
async function loadOverrides(
  deps: RbacDeps,
  firmId: string | null,
  slugs: RoleSlug[],
): Promise<PermissionOverride[]> {
  const overridable = slugs.filter((s): s is Exclude<RoleSlug, 'admin'> => s !== 'admin');
  if (!deps.db || !firmId || overridable.length === 0) return [];
  return deps.db
    .select({
      roleSlug: rolePermissionOverrides.roleSlug,
      permissionKey: rolePermissionOverrides.permissionKey,
      granted: rolePermissionOverrides.granted,
    })
    .from(rolePermissionOverrides)
    .where(
      and(
        eq(rolePermissionOverrides.firmId, firmId),
        inArray(rolePermissionOverrides.roleSlug, overridable),
      ),
    );
}
