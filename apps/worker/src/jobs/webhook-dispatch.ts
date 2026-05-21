// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Outbound webhook dispatcher (Phase 21 #6). Scans PENDING/RETRYING
// webhook_delivery rows whose next_attempt_at is due, POSTs them to the
// endpoint URL with HMAC-SHA256 signature, exponential-backs-off on
// failure, and marks DELIVERED or FAILED.

import crypto from 'node:crypto';
import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { webhookDeliveries, webhookEndpoints } from '@vibe/db/schema';

import type { Logger } from 'pino';

const MAX_ATTEMPTS = 6;

function nextDelayMs(attempt: number): number {
  // 30s, 2m, 8m, 32m, 2h, 8h.
  return Math.min(30_000 * Math.pow(4, attempt - 1), 8 * 3600 * 1000);
}

export async function runWebhookDispatch(
  db: Database,
  log: Logger,
  now = new Date(),
): Promise<{ scanned: number; delivered: number; failed: number; retrying: number }> {
  // QA fix — raw `sql\`${now}\`` interpolation was passing a JS Date to the
  // postgres driver and throwing "string/Buffer expected, got Date" before
  // the parameter binder kicked in. drizzle's typed ops serialise Date
  // correctly against a timestamptz column.
  const due = await db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.status, 'PENDING'),
        or(isNull(webhookDeliveries.nextAttemptAt), lte(webhookDeliveries.nextAttemptAt, now)) ??
          isNull(webhookDeliveries.nextAttemptAt),
      ),
    )
    .limit(100);
  if (due.length === 0) {
    return { scanned: 0, delivered: 0, failed: 0, retrying: 0 };
  }
  const endpointIds = Array.from(new Set(due.map((d) => d.webhookEndpointId)));
  const endpoints = await db
    .select()
    .from(webhookEndpoints)
    .where(inArray(webhookEndpoints.id, endpointIds));
  const endpointById = new Map(endpoints.map((e) => [e.id, e]));

  let delivered = 0;
  let failed = 0;
  let retrying = 0;
  for (const d of due) {
    const endpoint = endpointById.get(d.webhookEndpointId);
    if (!endpoint || endpoint.status !== 'ACTIVE') {
      await db
        .update(webhookDeliveries)
        .set({ status: 'FAILED', lastAttemptAt: now })
        .where(eq(webhookDeliveries.id, d.id));
      failed++;
      continue;
    }
    const attempt = d.attemptCount + 1;
    const body = JSON.stringify(d.payload);
    const timestamp = String(Math.floor(now.getTime() / 1000));
    // Receiver verifies by SHA-256(secret + timestamp + "." + body). We
    // store secret_hash (sha256 of secret); the receiver knows secret in
    // plaintext from initial creation/rotation response.
    const signature = crypto
      .createHmac('sha256', endpoint.secretHash)
      .update(`${timestamp}.${body}`)
      .digest('hex');
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 10_000);
      const resp = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-vibe-event': d.eventType,
          'x-vibe-timestamp': timestamp,
          'x-vibe-signature': signature,
          'x-vibe-delivery-id': d.id,
        },
        body,
        signal: ctl.signal,
      });
      clearTimeout(timer);
      const respText = await resp.text().catch(() => '');
      if (resp.status >= 200 && resp.status < 300) {
        await db
          .update(webhookDeliveries)
          .set({
            status: 'DELIVERED',
            attemptCount: attempt,
            lastAttemptAt: now,
            nextAttemptAt: null,
            responseStatus: resp.status,
            responseBody: respText.slice(0, 4000),
          })
          .where(eq(webhookDeliveries.id, d.id));
        delivered++;
      } else if (attempt >= MAX_ATTEMPTS) {
        await db
          .update(webhookDeliveries)
          .set({
            status: 'FAILED',
            attemptCount: attempt,
            lastAttemptAt: now,
            responseStatus: resp.status,
            responseBody: respText.slice(0, 4000),
          })
          .where(eq(webhookDeliveries.id, d.id));
        failed++;
      } else {
        const next = new Date(now.getTime() + nextDelayMs(attempt));
        await db
          .update(webhookDeliveries)
          .set({
            status: 'PENDING',
            attemptCount: attempt,
            lastAttemptAt: now,
            nextAttemptAt: next,
            responseStatus: resp.status,
            responseBody: respText.slice(0, 4000),
          })
          .where(eq(webhookDeliveries.id, d.id));
        retrying++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'fetch_error';
      if (attempt >= MAX_ATTEMPTS) {
        await db
          .update(webhookDeliveries)
          .set({
            status: 'FAILED',
            attemptCount: attempt,
            lastAttemptAt: now,
            responseBody: msg.slice(0, 4000),
          })
          .where(eq(webhookDeliveries.id, d.id));
        failed++;
      } else {
        const next = new Date(now.getTime() + nextDelayMs(attempt));
        await db
          .update(webhookDeliveries)
          .set({
            status: 'PENDING',
            attemptCount: attempt,
            lastAttemptAt: now,
            nextAttemptAt: next,
            responseBody: msg.slice(0, 4000),
          })
          .where(eq(webhookDeliveries.id, d.id));
        retrying++;
      }
      log.warn({ deliveryId: d.id, err: msg }, 'webhook dispatch failed');
    }
  }
  return { scanned: due.length, delivered, failed, retrying };
}
