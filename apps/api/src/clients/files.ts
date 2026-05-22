// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// File-manager v1 was removed in Phase 0 of the rebuild (see
// FILE_MANAGER_ADDENDUM.md and the master plan). Every legacy
// /clients/:id/files endpoint now returns 410 Gone so callers learn
// the surface is moving rather than getting silent failures. Phase 8
// re-introduces a presigned-PUT upload path against the new schema.

import { type Request, type Response, type Router } from 'express';

import type { Database } from '@vibe/db';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import type { StorageAdapter } from '../files/storage';

export interface FileRoutesDeps extends RbacDeps {
  db: Database | null;
  storage: StorageAdapter;
}

const GONE_BODY = {
  error: 'file_manager_v1_removed',
  message: 'The legacy file manager was removed; v2 ships in a subsequent phase.',
} as const;

function gone(_req: Request, res: Response): void {
  res.status(410).json(GONE_BODY);
}

export function mountFileRoutes(router: Router, deps: FileRoutesDeps): void {
  // Touch deps so noUnusedParameters doesn't flag this temporary shim.
  void deps;
  const guard = requirePermission(deps, 'client:read');
  router.get('/:id/files', guard, gone);
  router.post('/:id/files', guard, gone);
  router.post('/:id/files/upload-link', guard, gone);
  router.get('/:id/files/:fileId/download', guard, gone);
  router.post('/:id/files/:fileId/move', guard, gone);
  router.post('/:id/files/:fileId/visibility', guard, gone);
  router.post('/:id/files/bulk-move', guard, gone);
  router.post('/:id/files/bulk-visibility', guard, gone);
  router.post('/:id/files/bulk-delete', guard, gone);
  router.delete('/:id/files/:fileId', guard, gone);
}
