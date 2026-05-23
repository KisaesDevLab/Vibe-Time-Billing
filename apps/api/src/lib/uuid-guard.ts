// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Shared UUID param validator. Every route with a UUID-typed path param
// was historically vulnerable to: a request like GET /clients/pins
// matched GET /:id, the handler fed the literal "pins" to a Drizzle
// .where(eq(table.id, "pins")) filter, and Postgres threw 22P02 which
// surfaced as a 500. The guard calls `next('route')` on non-UUID
// values so Express falls through to whatever static-path route is
// registered later (or, more commonly, returns the default 404).
//
// `router.param(name, fn)` is a no-op if the router has no routes
// using `:name`, so blanket-registering the well-known UUID param
// names below is safe and zero-cost.

import type { Router, Request, Response, NextFunction } from 'express';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every UUID-typed path param name used anywhere in the API. Adding a
// name here protects it across all routers that adopt `addUuidIdGuard`.
const DEFAULT_UUID_PARAM_NAMES = [
  'id',
  'accessId',
  'allocationId',
  'appUserId',
  'assignmentId',
  'attachmentId',
  'bankId',
  'batchId',
  'clientId',
  'commentId',
  'engagementId',
  'entryId',
  'fileId',
  'firmId',
  'folderId',
  'identityId',
  'invoiceId',
  'letterId',
  'lineId',
  'milestoneId',
  'noteId',
  'ownerId',
  'paymentId',
  'planId',
  'receiptId',
  'reportId',
  'roleId',
  'snapshotId',
  'templateId',
  'tokenId',
  'txId',
  'userId',
  'webhookId',
] as const;

export function addUuidIdGuard(router: Router, extraParams: string[] = []): void {
  const handler = (_req: Request, _res: Response, next: NextFunction, value: unknown): void => {
    if (typeof value === 'string' && UUID_RE.test(value)) next();
    else next('route');
  };
  for (const name of [...DEFAULT_UUID_PARAM_NAMES, ...extraParams]) {
    router.param(name, handler);
  }
}
