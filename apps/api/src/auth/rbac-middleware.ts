// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// requirePermission middleware. Resolves the staff user's role
// assignments from the database, applies the role templates plus the
// firm's permission-matrix overrides (0147), and gates the request.
// The resolvers themselves live in ./rbac-resolve (Express-free).

import type { NextFunction, Request, Response } from 'express';

import { type PermissionKey, hasPermission } from '@vibe/core/rbac';

import { resolveUserPermissions, type RbacDeps } from './rbac-resolve';

export {
  loadRoleSlugs,
  resolveUserPermissions,
  userHasPermission,
  type RbacDeps,
} from './rbac-resolve';

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
