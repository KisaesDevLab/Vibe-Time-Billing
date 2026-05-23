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
  // At most one actor — staff, portal, and MCP token are mutually exclusive.
  // Zero is allowed for system-emitted events (Stripe / CPACharge webhooks,
  // worker-driven sweeps). The actor_mcp_token_id column is a UUID FK, so
  // we can't smuggle a string sentinel through it the way prior code tried.
  const actorCount =
    Number(event.actorAppUserId != null) +
    Number(event.actorPortalIdentityId != null) +
    Number(event.actorMcpTokenId != null);
  if (actorCount > 1) {
    throw new Error(`audit emit: at most one actor allowed, got ${actorCount}`);
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
