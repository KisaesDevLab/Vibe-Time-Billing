// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Retention enforcement worker (Phase 19 #11). Deletes old AI request log
// rows and old webhook_delivery rows past their retention window. The
// audit_log is exempt — it's append-only at the DB-role level and is
// retained per regulatory requirements.
//
// Defaults (overrideable via env):
//   AI_REQUEST_LOG_RETENTION_DAYS=180
//   WEBHOOK_DELIVERY_RETENTION_DAYS=90

import { lt } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { aiRequestLog, webhookDeliveries } from '@vibe/db/schema';

import type { Logger } from 'pino';

export async function runRetentionEnforcement(
  db: Database,
  log: Logger,
  now = new Date(),
): Promise<{ aiLogsPurged: number; webhookDeliveriesPurged: number }> {
  const aiDays = parseInt(process.env['AI_REQUEST_LOG_RETENTION_DAYS'] ?? '180', 10) || 180;
  const whDays = parseInt(process.env['WEBHOOK_DELIVERY_RETENTION_DAYS'] ?? '90', 10) || 90;

  const aiCutoff = new Date(now.getTime() - aiDays * 86_400_000);
  const whCutoff = new Date(now.getTime() - whDays * 86_400_000);

  const aiPurged = await db
    .delete(aiRequestLog)
    .where(lt(aiRequestLog.occurredAt, aiCutoff))
    .returning({ id: aiRequestLog.id });
  const whPurged = await db
    .delete(webhookDeliveries)
    .where(lt(webhookDeliveries.createdAt, whCutoff))
    .returning({ id: webhookDeliveries.id });

  if (aiPurged.length > 0 || whPurged.length > 0) {
    log.info(
      {
        aiLogsPurged: aiPurged.length,
        webhookDeliveriesPurged: whPurged.length,
        aiCutoff,
        whCutoff,
      },
      'retention enforcement purged rows',
    );
  }
  return { aiLogsPurged: aiPurged.length, webhookDeliveriesPurged: whPurged.length };
}
