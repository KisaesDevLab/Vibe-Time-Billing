// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Webhook event publisher. Inserts webhook_delivery rows for every
// matching subscribed endpoint. The dispatcher worker handles delivery,
// retries, and outcome marking; this helper just queues the work.

import { and, eq, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { webhookDeliveries, webhookEndpoints } from '@vibe/db/schema';

import { logger } from '../logger';

export async function publishWebhookEvent(
  db: Database | null,
  firmId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<{ enqueued: number }> {
  if (!db) return { enqueued: 0 };
  // Pick subscribers: same firm, ACTIVE, with the event in their list.
  const endpoints = await db
    .select({ id: webhookEndpoints.id, events: webhookEndpoints.events })
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.firmId, firmId), eq(webhookEndpoints.status, 'ACTIVE')));
  const matching = endpoints.filter((e) => {
    const list = Array.isArray(e.events) ? (e.events as string[]) : [];
    return list.includes(eventType);
  });
  if (matching.length === 0) return { enqueued: 0 };
  const enriched = { ...payload, eventType, firmId, ts: new Date().toISOString() };
  await db.insert(webhookDeliveries).values(
    matching.map((e) => ({
      webhookEndpointId: e.id,
      eventType,
      payload: enriched,
      status: 'PENDING' as const,
      nextAttemptAt: new Date(),
    })),
  );
  logger.info({ eventType, count: matching.length }, 'webhook event enqueued');
  // Silence unused import.
  void sql;
  return { enqueued: matching.length };
}
