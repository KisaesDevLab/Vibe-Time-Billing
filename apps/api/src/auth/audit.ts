// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Audit-log emitter. Every mutating endpoint and every auth event records
// one row. The DB role enforces immutability (`0001_audit_log_immutability.sql`).

import type { Database } from '@vibe/db';
import { auditLog } from '@vibe/db/schema';

import { logger } from '../logger';

export interface AuditEvent {
  action:
    | 'CREATE'
    | 'UPDATE'
    | 'ARCHIVE'
    | 'RESTORE'
    | 'LOGIN'
    | 'LOGOUT'
    | 'STEP_UP'
    | 'EXPORT'
    | 'IMPERSONATE'
    | 'PAYMENT'
    | 'WEBHOOK_DELIVERY'
    | 'MCP_CALL'
    | 'AI_REQUEST'
    | 'BACKUP'
    | 'RESTORE_DATABASE';
  entityType: string;
  entityId?: string | null;
  actorAppUserId?: string | null;
  actorPortalIdentityId?: string | null;
  actorMcpTokenId?: string | null;
  activeClientId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export async function emitAudit(db: Database | null, event: AuditEvent): Promise<void> {
  // Belt-and-suspenders: enforce single-actor invariant in code too (DB
  // already enforces it via CHECK constraint).
  const actorCount =
    Number(event.actorAppUserId != null) +
    Number(event.actorPortalIdentityId != null) +
    Number(event.actorMcpTokenId != null);
  if (actorCount !== 1) {
    throw new Error(`audit emit: exactly one actor required, got ${actorCount}`);
  }

  if (!db) {
    // In tests we sometimes have no DB available; log instead of crashing
    // so the calling code path stays testable.
    logger.info({ event }, 'audit (no-db)');
    return;
  }

  await db.insert(auditLog).values({
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId ?? null,
    actorAppUserId: event.actorAppUserId ?? null,
    actorPortalIdentityId: event.actorPortalIdentityId ?? null,
    actorMcpTokenId: event.actorMcpTokenId ?? null,
    activeClientId: event.activeClientId ?? null,
    beforeJson: event.before == null ? null : (event.before as object),
    afterJson: event.after == null ? null : (event.after as object),
    ip: event.ip ?? null,
    userAgent: event.userAgent ?? null,
    requestId: event.requestId ?? null,
  });
}
