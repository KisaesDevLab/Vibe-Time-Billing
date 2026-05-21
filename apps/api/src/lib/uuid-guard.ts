// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// QA fix — shared `:id` UUID validator. Every router with a top-level
// /:id was vulnerable to single-segment static-path shadowing: requests
// like GET /clients/pins matched GET /:id first, the handler then fed
// the literal segment to a UUID column, and Postgres threw 22P02. The
// guard calls `next('route')` on non-UUID `:id` so Express falls through
// to whatever static-path route is registered later.

import type { Router, Request, Response, NextFunction } from 'express';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function addUuidIdGuard(router: Router): void {
  router.param('id', (_req: Request, _res: Response, next: NextFunction, value: unknown) => {
    if (typeof value === 'string' && UUID_RE.test(value)) next();
    else next('route');
  });
}
