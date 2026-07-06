// SPDX-License-Identifier: Elastic-2.0
//
// Side effects fired when an engagement is "completed" — either by moving its
// workflow status to COMPLETED or by the lifecycle Close/Archive action. Both
// entry points call onEngagementCompleted so the behavior is identical:
//
//   1. Fire any ACTIVE, ON_COMPLETION recurrence anchored to this engagement:
//      spawn the next period and (when the recurrence has the toggles on) roll
//      its appointment + drop-off forward. Because the spawn advances the
//      recurrence's last_engagement_id, the worker's daily ON_COMPLETION sweep
//      won't double-spawn.
//   2. Resolve this engagement's still-open DROP_OFF request(s) as FULFILLED so
//      they stop showing outstanding + reminding the client.
//
// Best-effort throughout: a failure here never blocks the status change.

import { and, eq, inArray } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clientRequests, engagementRecurrences } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { logger } from '../logger';
import { spawnNextEngagement } from './recurrence-spawn';

export async function onEngagementCompleted(
  db: Database,
  opts: {
    engagementId: string;
    firmId: string;
    actorAppUserId: string;
    ip: string | null;
    userAgent: string | null;
    /** 'closed' (lifecycle) or 'completed' (workflow status) — audit only. */
    reason: 'engagement_closed' | 'engagement_completed';
  },
): Promise<void> {
  // 1. Spawn + roll forward from this engagement (ON_COMPLETION recurrences).
  try {
    const recs = await db
      .select({ id: engagementRecurrences.id })
      .from(engagementRecurrences)
      .where(
        and(
          eq(engagementRecurrences.lastEngagementId, opts.engagementId),
          eq(engagementRecurrences.triggerMode, 'ON_COMPLETION'),
          eq(engagementRecurrences.status, 'ACTIVE'),
        ),
      );
    for (const r of recs) {
      const result = await spawnNextEngagement({
        db,
        recurrenceId: r.id,
        firmId: opts.firmId,
        actorAppUserId: opts.actorAppUserId,
      });
      if (result.kind === 'error') {
        logger.warn(
          { recurrenceId: r.id, reason: result.reason },
          'on-completion recurrence spawn returned error',
        );
      }
    }
  } catch (err) {
    logger.error({ err, engagementId: opts.engagementId }, 'on-completion recurrence spawn failed');
  }

  // 2. Resolve this engagement's still-open drop-offs as FULFILLED.
  try {
    const now = new Date();
    const fulfilled = await db
      .update(clientRequests)
      .set({
        status: 'FULFILLED',
        fulfilledAt: now,
        fulfilledByAppUserId: opts.actorAppUserId,
        fulfilledByPortalIdentityId: null,
        activationDate: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(clientRequests.engagementId, opts.engagementId),
          eq(clientRequests.kind, 'DROP_OFF'),
          inArray(clientRequests.status, ['OPEN', 'PENDING', 'NEEDS_INFO']),
        ),
      )
      .returning({ id: clientRequests.id });
    for (const f of fulfilled) {
      await emitAudit(db, {
        action: 'UPDATE',
        entityType: 'client_request',
        entityId: f.id,
        actorAppUserId: opts.actorAppUserId,
        after: { status: 'FULFILLED', reason: opts.reason },
        ip: opts.ip,
        userAgent: opts.userAgent,
      }).catch(() => undefined);
    }
  } catch (err) {
    logger.error(
      { err, engagementId: opts.engagementId },
      'drop-off auto-fulfill on completion failed',
    );
  }
}
